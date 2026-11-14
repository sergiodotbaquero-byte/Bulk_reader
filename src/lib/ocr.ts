import { useSyncExternalStore } from 'react';
import { createWorker, PSM, type Worker } from 'tesseract.js';

export interface OcrStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  progress: number;
  message: string;
}

let status: OcrStatus = { state: 'idle', progress: 0, message: 'OCR sin iniciar' };
const listeners = new Set<() => void>();

function setStatus(patch: Partial<OcrStatus>): void {
  status = { ...status, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export const getOcrStatus = (): OcrStatus => status;

export function useOcrStatus(): OcrStatus {
  return useSyncExternalStore(subscribe, getOcrStatus, getOcrStatus);
}

type Mode = 'title' | 'code' | 'sparse';
let workerPromise: Promise<Worker> | null = null;
let mode: Mode | null = null;

const MESSAGES: Record<string, string> = {
  'loading tesseract core': 'Cargando motor OCR',
  'initializing tesseract': 'Iniciando OCR',
  'loading language traineddata': 'Descargando idioma OCR',
  'loaded language traineddata': 'Idioma OCR listo',
  'initializing api': 'Preparando OCR',
  'initialized api': 'OCR listo',
};

/** El worker se crea desde un blob, así que las rutas deben ser absolutas. */
function abs(path: string): string {
  return new URL(path, window.location.href).href;
}

/** Arranca el motor OCR (descarga ~5 MB la primera vez; luego queda en caché). */
export function warmUpOcr(): Promise<Worker> {
  if (workerPromise) return workerPromise;
  setStatus({ state: 'loading', progress: 0, message: 'Cargando motor OCR…' });
  const base = import.meta.env.BASE_URL;
  workerPromise = createWorker('eng', 1, {
    workerPath: abs(`${base}tesseract/worker.min.js`),
    corePath: abs(`${base}tesseract/core`),
    // eng.traineddata.gz se copia desde @tesseract.js-data/eng (scripts/copy-tesseract.mjs).
    langPath: abs(`${base}tesseract/lang`),
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') return;
      setStatus({ progress: m.progress ?? 0, message: `${MESSAGES[m.status] ?? m.status}…` });
    },
    errorHandler: (e: unknown) => console.warn('[ocr]', e),
  })
    .then((w) => {
      setStatus({ state: 'ready', progress: 1, message: 'OCR listo' });
      return w;
    })
    .catch((e: unknown) => {
      workerPromise = null;
      setStatus({ state: 'error', progress: 0, message: `No se pudo cargar el OCR: ${(e as Error).message}` });
      throw e;
    });
  return workerPromise;
}

// Sin `tessedit_char_whitelist`: con el motor LSTM empeora la lectura (leía "Donovarbives"
// donde decía "Llanowar Elves"); la limpieza se hace después con el índice de nombres y regex.
const PSM_FOR: Record<Mode, PSM> = {
  title: PSM.SINGLE_LINE,
  code: PSM.SINGLE_BLOCK,
  sparse: PSM.SPARSE_TEXT,
};

async function prepare(m: Mode): Promise<Worker> {
  const w = await warmUpOcr();
  if (mode !== m) {
    mode = m;
    await w.setParameters({ tessedit_pageseg_mode: PSM_FOR[m], preserve_interword_spaces: '1' });
  }
  return w;
}

export interface OcrResult {
  text: string;
  confidence: number;
}

/** Lee la franja del nombre (una sola línea). */
export async function ocrTitle(canvas: HTMLCanvasElement): Promise<OcrResult> {
  const w = await prepare('title');
  const { data } = await w.recognize(canvas);
  return { text: (data.text ?? '').replace(/\s+/g, ' ').trim(), confidence: data.confidence ?? 0 };
}

/** Lee la franja del número de coleccionista / set (bloque corto, o texto disperso si es muy ancha). */
export async function ocrCode(canvas: HTMLCanvasElement, sparse = false): Promise<string> {
  const w = await prepare(sparse ? 'sparse' : 'code');
  const { data } = await w.recognize(canvas);
  return (data.text ?? '').trim();
}

/** Lee texto disperso en una imagen completa (foto sin encuadrar). */
export async function ocrSparse(canvas: HTMLCanvasElement): Promise<string> {
  const w = await prepare('sparse');
  const { data } = await w.recognize(canvas);
  return (data.text ?? '').trim();
}

export async function terminateOcr(): Promise<void> {
  const p = workerPromise;
  workerPromise = null;
  mode = null;
  if (p) await (await p).terminate();
  setStatus({ state: 'idle', progress: 0, message: 'OCR detenido' });
}
