import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type TouchEvent } from 'react';
import type { ScryfallCard } from '../types';
import { addCard } from '../lib/addCard';
import { setTorch, setZoom, startCamera, stopCamera, type CameraHandle, type ZoomRange } from '../lib/camera';
import {
  EMPTY_COLLECTOR_INFO,
  mergeCollectorInfo,
  ocrDistance,
  parseCollectorText,
  type CollectorInfo,
} from '../lib/collector';
import { debugShow } from '../lib/debug';
import { debugTitleProfile, detectCard, detectDebug, findCornerBands, findTitleBand, iou, rectifyCard, type Detection } from '../lib/detect';
import { feedbackAdded, feedbackError, primeAudio } from '../lib/feedback';
import { money, rarityShort, year } from '../lib/format';
import {
  CARD_ASPECT,
  cropToCanvas,
  cssRectToVideoRect,
  loadImage,
  meanLuma,
  preprocessForOcr,
  sourceSize,
  videoRectToCssRect,
  type PixelRect,
} from '../lib/image';
import { undoLastScan } from '../lib/inventory';
import { normalizeName, textSimilarity, type NameIndex, type NameMatch } from '../lib/names';
import { ocrCode, ocrSparse, ocrTitle, useOcrStatus, warmUpOcr } from '../lib/ocr';
import {
  ScryfallError,
  allCardNames,
  availableFinishes,
  cardFaceNames,
  cardImage,
  displayName,
  fetchSets,
  getCardByExactName,
  getCardBySetNumber,
  getPrintings,
  printedName,
  searchCards,
  setCodeCandidates,
  unitPrice,
  type SetInfo,
} from '../lib/scryfall';
import { useSettings } from '../lib/settings';
import { AddControls, Stepper, type AddState } from './AddControls';
import { Icon } from './Icons';
import { PrintingPicker } from './PrintingPicker';
import { useToast } from './Toast';

type Source = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

interface ScanResult {
  /** Impresión en inglés (precios y lista de ediciones). */
  card: ScryfallCard;
  /** La misma impresión en el idioma leído, si Scryfall la tiene. */
  localized: ScryfallCard | null;
  /** La edición se leyó de la carta (set + número) o se dedujo sin ambigüedad. */
  confirmed: boolean;
  /** Cómo se identificó: por el nombre o directamente por la esquina (set + número). */
  via: 'name' | 'corner';
  match: NameMatch;
  info: CollectorInfo | null;
  addedCount: number;
}

interface LoopState {
  running: boolean;
  resolving: boolean;
  lastName: string | null;
  stable: number;
  /** Clave de lo último que se identificó (name:… o corner:set/num), para no repetirlo mientras siga la misma carta. */
  resolvedKey: string | null;
  misses: number;
  lastCornerAt: number;
  cornerReads: { key: string; count: number } | null;
}

interface LiveDetection extends Detection {
  at: number;
}

export interface ScanDiagnostics {
  detected: PixelRect | null;
  outer: boolean | null;
  /** Inclinación detectada en grados. */
  tilt: number | null;
  text: string;
  match: string | null;
  score: number;
  info: CollectorInfo | null;
  card: string | null;
  confirmed: boolean;
}

function rectStyle(r: PixelRect): CSSProperties {
  return { left: r.x, top: r.y, width: r.w, height: r.h };
}

const RARITY_LETTER: Record<string, string[]> = {
  C: ['common'],
  U: ['uncommon'],
  R: ['rare'],
  M: ['mythic'],
  S: ['special', 'bonus'],
  L: ['common'],
  T: ['common'],
};

/** true/false si la letra de rareza leída cuadra con la carta; null si no se leyó. */
function rarityMatches(letter: string | null, rarity: string): boolean | null {
  if (!letter) return null;
  const r = RARITY_LETTER[letter];
  return r ? r.includes(rarity) : null;
}

/** Las tierras básicas tienen cientos de impresiones: no se les puede deducir la edición. */
function isBasicLand(card: ScryfallCard): boolean {
  return (card.type_line ?? '').includes('Basic Land');
}

function totalMatches(total: number | null, set: SetInfo | undefined): boolean | null {
  if (total == null || !set) return null;
  return set.cardCount === total || set.printedSize === total;
}

/**
 * Busca la carta por set + número leídos de la esquina. El código se coteja con la lista real de
 * sets de Scryfall, así que "dex" llega a "dsk" sin gastar peticiones en códigos inexistentes.
 * Si se pasan nombres esperados, exige que uno coincida; sin nombre (identificación solo por la
 * esquina) se aceptan únicamente códigos casi idénticos.
 */
async function fetchBySetNumber(
  set: string,
  number: string,
  lang: string | null,
  expectedNames: string[] | null,
): Promise<ScryfallCard | null> {
  const want = expectedNames ? new Set(expectedNames.map(normalizeName)) : null;
  const codes = await setCodeCandidates(set, want ? 2 : 1);
  for (const code of codes) {
    const langs: (string | undefined)[] = lang && lang !== 'en' ? [lang, undefined] : [undefined];
    for (const l of langs) {
      try {
        const c = await getCardBySetNumber(code, number, l);
        if (!want || cardFaceNames(c).some((n) => want.has(normalizeName(n)))) return c;
        break; // existe pero es otra carta: este código no es
      } catch (e) {
        if (e instanceof ScryfallError && (e.status === 404 || e.status === 400)) continue;
        throw e;
      }
    }
  }
  return null;
}

interface SetHit {
  cards: ScryfallCard[];
  /** Impresiones de ese set cuyo número coincide con el leído. */
  byNumber: ScryfallCard[];
  /** Distancia entre el código leído y el del set encontrado (0 = exacto). */
  distance: number;
}

/**
 * Impresiones de una carta dentro del set leído, con una búsqueda directa: bajar todas las
 * impresiones de un Forest son cientos de cartas. Se prueban los códigos de set reales más
 * parecidos a lo leído y gana el que además cuadre con el número de coleccionista.
 */
async function printingsInSet(name: string, set: string, number: string | null): Promise<SetHit | null> {
  const codes = await setCodeCandidates(set, 2, 4);
  const hits: SetHit[] = [];
  for (const code of codes) {
    const cards = await searchCards(`!"${name.replace(/"/g, '')}" set:${code}`);
    if (!cards.length) continue;
    // Primero el número más bajo (la impresión normal; las variantes van después).
    cards.sort((a, b) => parseInt(a.collector_number, 10) - parseInt(b.collector_number, 10));
    const byNumber = number ? cards.filter((c) => c.collector_number.toLowerCase() === number.toLowerCase()) : [];
    const distance = ocrDistance(set, code);
    hits.push({ cards, byNumber, distance });
    if (distance === 0 || byNumber.length) break;
  }
  if (!hits.length) return null;
  hits.sort((a, b) => (b.byNumber.length ? 1 : 0) - (a.byNumber.length ? 1 : 0) || a.distance - b.distance);
  return hits[0];
}

/** La impresión en inglés de la misma carta (para precios y ediciones). */
async function englishTwin(card: ScryfallCard): Promise<ScryfallCard> {
  if (card.lang === 'en') return card;
  try {
    return await getCardBySetNumber(card.set, card.collector_number);
  } catch {
    return card;
  }
}

function touchDistance(t: TouchEvent['touches']): number {
  const dx = t[0].clientX - t[1].clientX;
  const dy = t[0].clientY - t[1].clientY;
  return Math.hypot(dx, dy);
}

export function Scanner({
  index,
  indexStatus,
  indexError,
  onRetryIndex,
  goSearch,
}: {
  index: NameIndex | null;
  indexStatus: string;
  indexError: string | null;
  onRetryIndex: () => void;
  goSearch: () => void;
}) {
  const [settings, update] = useSettings();
  const toast = useToast();
  const ocr = useOcrStatus();

  const videoRef = useRef<HTMLVideoElement>(null);
  const camRef = useRef<HTMLDivElement>(null);
  const camera = useRef<CameraHandle | null>(null);
  const wasOn = useRef(false);

  const [camState, setCamState] = useState<'off' | 'starting' | 'on' | 'error'>('off');
  const [camError, setCamError] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchOk, setTorchOk] = useState(false);
  const [zoom, setZoomState] = useState<ZoomRange | null>(null);
  const [camSize, setCamSize] = useState({ w: 0, h: 0 });
  const [status, setStatus] = useState('Muestra la carta completa a la cámara');
  const [busy, setBusy] = useState(false);
  const [hit, setHit] = useState<'' | 'hit' | 'found'>('');
  const [lastOcr, setLastOcr] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [add, setAdd] = useState<AddState>({
    finish: settings.defaultFinish,
    condition: settings.defaultCondition,
    lang: settings.defaultLang,
    quantity: 1,
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [printings, setPrintings] = useState<ScryfallCard[] | null>(null);
  const [sessionCount, setSessionCount] = useState(0);
  const [adding, setAdding] = useState(false);
  const [detCss, setDetCss] = useState<(PixelRect & { outer: boolean; tilt: number }) | null>(null);
  const [zones, setZones] = useState<{ title: PixelRect | null; code: PixelRect | null }>({ title: null, code: null });

  const loop = useRef<LoopState>({
    running: false,
    resolving: false,
    lastName: null,
    stable: 0,
    resolvedKey: null,
    misses: 0,
    lastCornerAt: 0,
    cornerReads: null,
  });
  const detRef = useRef<LiveDetection | null>(null);
  const latestResult = useRef<ScanResult | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const addRef = useRef(add);
  addRef.current = add;
  const camSizeRef = useRef(camSize);
  camSizeRef.current = camSize;
  const pausedRef = useRef(false);
  pausedRef.current = pickerOpen || adding;

  // ---------- marco guía ----------
  useEffect(() => {
    const el = camRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setCamSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const frame = useMemo<PixelRect | null>(() => {
    if (!camSize.w || !camSize.h) return null;
    let w = camSize.w * settings.frameScale;
    let h = w / CARD_ASPECT;
    const maxH = camSize.h * 0.94;
    if (h > maxH) {
      h = maxH;
      w = h * CARD_ASPECT;
    }
    return { x: (camSize.w - w) / 2, y: (camSize.h - h) / 2, w, h };
  }, [camSize, settings.frameScale]);
  const frameRef = useRef(frame);
  frameRef.current = frame;

  // ---------- cámara ----------
  const start = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    primeAudio();
    setCamState('starting');
    setCamError(null);
    try {
      const h = await startCamera(video, { zoom: settingsRef.current.cameraZoom, res: settingsRef.current.cameraRes });
      if (!videoRef.current) {
        stopCamera(h);
        return;
      }
      camera.current = h;
      wasOn.current = true;
      setTorchOk(h.torchSupported);
      setTorchOn(false);
      setZoomState(h.zoom ? { ...h.zoom } : null);
      setCamState('on');
    } catch (e) {
      setCamError((e as Error).message);
      setCamState('error');
    }
  }, []);

  const stop = useCallback(() => {
    stopCamera(camera.current);
    camera.current = null;
    detRef.current = null;
    setDetCss(null);
    setZones({ title: null, code: null });
    setCamState('off');
  }, []);

  useEffect(() => {
    void start();
    void warmUpOcr().catch(() => undefined);
    return () => {
      stopCamera(camera.current);
      camera.current = null;
    };
  }, [start]);

  // Cambio de resolución en Ajustes: se reabre la cámara.
  const resRef = useRef(settings.cameraRes);
  useEffect(() => {
    if (resRef.current === settings.cameraRes) return;
    resRef.current = settings.cameraRes;
    if (!camera.current) return;
    stopCamera(camera.current);
    camera.current = null;
    void start();
  }, [settings.cameraRes, start]);

  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        if (camera.current) {
          stopCamera(camera.current);
          camera.current = null;
          setCamState('off');
        }
      } else if (wasOn.current && !camera.current) {
        void start();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [start]);

  const toggleTorch = async () => {
    if (!camera.current) return;
    const ok = await setTorch(camera.current, !torchOn);
    if (ok) setTorchOn(!torchOn);
    else toast.show('Esta cámara no permite controlar la linterna.');
  };

  // ---------- zoom (deslizador y pellizco) ----------
  const zoomTimer = useRef<number | null>(null);
  const applyZoom = useCallback(
    (value: number) => {
      const h = camera.current;
      if (!h?.zoom) return;
      const v = Math.round(Math.min(h.zoom.max, Math.max(h.zoom.min, value)) * 100) / 100;
      setZoomState({ ...h.zoom, value: v });
      if (zoomTimer.current != null) return;
      zoomTimer.current = window.setTimeout(() => {
        zoomTimer.current = null;
        const cur = camera.current;
        if (!cur?.zoom) return;
        void setZoom(cur, v).then((ok) => {
          if (ok) update({ cameraZoom: v });
        });
      }, 60);
    },
    [update],
  );

  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  const onTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    const z = camera.current?.zoom;
    if (e.touches.length === 2 && z) pinch.current = { dist: touchDistance(e.touches), zoom: z.value };
  };
  const onTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    if (!pinch.current || e.touches.length !== 2) return;
    const d = touchDistance(e.touches);
    if (d > 0 && pinch.current.dist > 0) applyZoom(pinch.current.zoom * (d / pinch.current.dist));
  };
  const onTouchEnd = () => {
    pinch.current = null;
  };

  // ---------- agregar ----------
  const doAdd = useCallback(
    async (card: ScryfallCard, a: AddState) => {
      setAdding(true);
      try {
        const { item } = await addCard(card, a);
        setSessionCount((n) => n + a.quantity);
        feedbackAdded();
        setResult((r) => (r && r.card.id === card.id ? { ...r, addedCount: r.addedCount + a.quantity } : r));
        toast.show(
          `+${a.quantity} ${item.printedName ?? item.name} · ${item.setCode.toUpperCase()} #${item.collectorNumber} (total ×${item.quantity})`,
          {
            kind: 'ok',
            action: {
              label: 'Deshacer',
              onClick: () => {
                void undoLastScan().then((d) => {
                  if (d) toast.show(`Deshecho: ${d}`);
                });
                setSessionCount((n) => Math.max(0, n - a.quantity));
              },
            },
          },
        );
      } catch (e) {
        feedbackError();
        toast.show(`No se pudo guardar: ${(e as Error).message}`, { kind: 'err' });
      } finally {
        setAdding(false);
      }
    },
    [toast],
  );

  /** Quita la carta del panel (al perder la carta de vista o si falla la identificación). */
  const clearResult = useCallback(() => {
    latestResult.current = null;
    setResult(null);
    setPrintings(null);
    setHit('');
  }, []);

  // ---------- lectura del nombre ----------
  /**
   * Lee la franja del nombre probando, solo si hace falta, la polaridad contraria y una versión
   * binarizada: los marcos modernos salen al primer intento; los viejos (letras claras sobre
   * fondo texturizado) suelen necesitar el segundo o el tercero.
   */
  const readTitle = useCallback(async (source: Source, band: PixelRect): Promise<{ text: string; match: NameMatch | null }> => {
    const idx = indexRef.current;
    if (!idx) return { text: '', match: null };
    const lang = settingsRef.current.defaultLang;
    const letters = (s: string) => (s.match(/[a-záéíóúñç]/gi) ?? []).length;
    const out = { inverted: false };
    // Orden de intentos: gris con la polaridad estimada, gris con la contraria, binarizado con la
    // contraria (marcos viejos: letras claras sobre mármol) y binarizado con la estimada.
    const attempts: { label: string; opts: { invert?: boolean; binarize?: boolean } }[] = [
      { label: 'nombre', opts: {} },
      { label: 'nombre (invertido)', opts: { invert: undefined } },
      { label: 'nombre (binarizado inv.)', opts: { invert: undefined, binarize: true } },
      { label: 'nombre (binarizado)', opts: { binarize: true } },
    ];
    const texts: string[] = [];
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      const opts = { ...a.opts, out: i === 0 ? out : undefined } as { invert?: boolean; binarize?: boolean; out?: { inverted: boolean } };
      if (i === 1 || i === 2) opts.invert = !out.inverted;
      if (i === 3) opts.invert = out.inverted;
      const canvas = preprocessForOcr(cropToCanvas(source, band, 1000), opts);
      debugShow(canvas, a.label);
      const t = (await ocrTitle(canvas)).text;
      texts.push(t);
      const m = t ? idx.match(t, lang) : null;
      if (m) return { text: t, match: m };
    }
    return { text: texts.sort((a, b) => letters(b) - letters(a))[0] ?? '', match: null };
  }, []);

  // ---------- lectura de la esquina ----------
  const readCorner = useCallback(async (source: Source, cardRect: PixelRect, outer: boolean): Promise<CollectorInfo> => {
    // Pasadas sobre la franja inferior, de la más barata a la más tolerante:
    // 1) mitad izquierda en gris (marcos modernos: "168/269 C · DOM • EN"),
    // 2) franja completa en gris (marcos viejos: el número va al final del copyright),
    // 3) y 4) franja completa binarizada con una y otra polaridad.
    const bands = findCornerBands(source, cardRect, outer);
    const dark = meanLuma(cropToCanvas(source, bands.left, 300)) < 105;
    const passes = [
      { rect: bands.left, width: 1100, sparse: false, binarize: false, invert: dark },
      { rect: bands.full, width: 2000, sparse: true, binarize: false, invert: dark },
      { rect: bands.full, width: 2000, sparse: true, binarize: true, invert: dark },
      { rect: bands.full, width: 2000, sparse: true, binarize: true, invert: !dark },
    ];
    let info = EMPTY_COLLECTOR_INFO;
    for (let i = 0; i < passes.length; i++) {
      const p = passes[i];
      const codeCanvas = preprocessForOcr(cropToCanvas(source, p.rect, p.width), p);
      debugShow(codeCanvas, `esquina ${i + 1}${bands.found ? '' : ' (zona fija)'}`);
      info = mergeCollectorInfo(info, parseCollectorText(await ocrCode(codeCanvas, p.sparse)));
      if (info.number && (info.set || i >= 1)) break;
    }
    return info;
  }, []);

  // ---------- mostrar el resultado ----------
  const present = useCallback(
    async (found: ScryfallCard, confirmed: boolean, via: 'name' | 'corner', m: NameMatch, info: CollectorInfo | null) => {
      const card = await englishTwin(found);
      const localized = found.lang !== 'en' ? found : null;
      const finishes = availableFinishes(card);
      const prev = addRef.current;
      // Idioma: el de la esquina, si no el de la impresión o del nombre impreso que se reconoció, y si
      // la carta no dice nada, el idioma por defecto de Ajustes (no el de la carta anterior).
      const lang =
        info?.lang ?? (found.lang !== 'en' ? found.lang : m.lang !== 'en' ? m.lang : settingsRef.current.defaultLang);
      const nextAdd: AddState = {
        ...prev,
        finish: finishes.includes(prev.finish) ? prev.finish : finishes[0],
        lang,
        quantity: 1,
      };
      setAdd(nextAdd);
      setPrintings(null);
      const res: ScanResult = { card, localized, confirmed, via, match: m, info, addedCount: 0 };
      latestResult.current = res;
      setResult(res);
      setHit('found');
      setStatus(
        confirmed
          ? `${card.set_name} · #${card.collector_number}`
          : via === 'corner'
            ? 'Leída por la esquina: revísala antes de agregar'
            : 'No pude leer la edición: revísala antes de agregar',
      );
      const s = settingsRef.current;
      if (s.autoAdd && (confirmed || s.autoAddUnconfirmed)) await doAdd(card, nextAdd);
    },
    [doAdd],
  );

  // ---------- identificar por el nombre ----------
  const resolve = useCallback(
    async (m: NameMatch, source: Source, cardRect: PixelRect, outer: boolean) => {
      const L = loop.current;
      L.resolving = true;
      setStatus(`Identificando «${m.printed}»…`);
      let info: CollectorInfo | null = null;
      let card: ScryfallCard | null = null;
      let confirmed = false;
      try {
        if (settingsRef.current.readCollectorCode) {
          info = await readCorner(source, cardRect, outer);
          if (info.set && info.number) {
            // Un nombre impreso puede ser de dos cartas distintas ("Agotamiento" es Attrition y
            // Exhaustion): se aceptan todas las lecturas y el set + número decide cuál es.
            const names = m.options?.length ? m.options.map((o) => o.name) : [m.name];
            card = await fetchBySetNumber(info.set, info.number, info.lang ?? (m.lang !== 'en' ? m.lang : null), names);
            confirmed = card != null;
          }
        }
        if (!card) {
          // Sin edición legible queda la lectura preferida del índice (si había varias, la
          // primera); el usuario puede corregirla con "Cambiar edición" o desde Buscar.
          const base = await getCardByExactName(m.name);
          card = base;
          const sameNumber = (p: ScryfallCard) =>
            info?.number != null && p.collector_number.toLowerCase() === info.number.toLowerCase();
          if (info?.set || info?.number) {
            const hit = info.set ? await printingsInSet(base.name, info.set, info.number) : null;
            if (hit) {
              // El set se leyó bien aunque el número no cuadre: elige dentro del set. Si el código
              // no era idéntico, hace falta que el número lo respalde para darlo por confirmado.
              card = hit.byNumber[0] ?? hit.cards[0];
              const unique = hit.cards.length === 1 || hit.byNumber.length === 1;
              confirmed = unique && (hit.distance <= 1 || hit.byNumber.length === 1);
            } else if (info.number) {
              // Solo número (marcos viejos): confirma únicamente si el total cuadra con el tamaño del set.
              const prints = await getPrintings(base);
              const byNum = prints.filter(sameNumber);
              if (byNum.length) {
                const total = info.total;
                const sets = await fetchSets().catch(() => null);
                const exact =
                  total != null && sets ? byNum.find((p) => totalMatches(total, sets.get(p.set)) === true) : undefined;
                card = exact ?? byNum[0];
                // También vale si ese número solo existe en una impresión de la carta y la rareza
                // leída cuadra (el set se leyó mal, pero nombre + número + rareza no dejan dudas).
                confirmed = exact != null || (byNum.length === 1 && rarityMatches(info.rarity, byNum[0].rarity) === true);
              }
            }
            // La carta existe en una sola edición: basta con que el código leído se le parezca (el
            // número de la esquina suele ser lo primero que se lee mal). No vale para tierras
            // básicas, que están en casi todos los sets.
            if (!confirmed && info.set && !isBasicLand(card)) {
              const all = await getPrintings(card);
              if (all.length === 1 && ocrDistance(info.set, all[0].set) <= 2) {
                card = all[0];
                confirmed = true;
              }
            }
          }
        }
      } catch (e) {
        L.resolvedKey = null;
        L.resolving = false;
        // Importante: borrar la carta anterior. Si se queda en pantalla, el botón Agregar sumaría
        // al inventario la carta del escaneo pasado.
        clearResult();
        setStatus(e instanceof ScryfallError ? `Scryfall: ${e.message}` : 'Sin conexión con Scryfall. Reintenta.');
        feedbackError();
        return;
      }
      try {
        await present(card, confirmed, 'name', m, info);
      } finally {
        L.resolving = false;
      }
    },
    [present, readCorner],
  );
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  // ---------- identificar por la esquina (sin nombre legible) ----------
  const cornerFirst = useCallback(
    async (source: Source, cardRect: PixelRect, outer: boolean, titleText: string, fromPhoto = false) => {
      const L = loop.current;
      L.resolving = true;
      try {
        const info = await readCorner(source, cardRect, outer);
        if (!info.set || !info.number) return false;
        const key = `corner:${info.set}/${info.number}`;
        if (L.resolvedKey === key) return true;
        const reads = L.cornerReads?.key === key ? { key, count: L.cornerReads.count + 1 } : { key, count: 1 };
        L.cornerReads = reads;
        setStatus(`Leí ${info.set.toUpperCase()} #${info.number}, comprobando…`);
        const card = await fetchBySetNumber(info.set, info.number, info.lang, null);
        if (!card) return false;
        // Validación: el título leído se parece al nombre de esa carta, o la lectura es estable y
        // la rareza / el total impresos cuadran con la carta y el set.
        const textScore = textSimilarity(titleText, allCardNames(card));
        const sets = await fetchSets().catch(() => null);
        const rarityOk = rarityMatches(info.rarity, card.rarity);
        const totalOk = totalMatches(info.total, sets?.get(card.set));
        const consistent = rarityOk !== false && totalOk !== false && (rarityOk === true || totalOk === true);
        const confirmed = textScore >= 0.5 || (reads.count >= 2 && consistent);
        if (!confirmed && !fromPhoto && reads.count < 2) {
          setStatus(`¿${displayName(card)}? Mantén la carta quieta…`);
          return false;
        }
        L.resolvedKey = key;
        const m: NameMatch = {
          name: card.name,
          printed: printedName(card) ?? card.name,
          lang: card.lang,
          score: textScore,
          norm: '',
          query: normalizeName(titleText),
        };
        await present(card, confirmed, 'corner', m, info);
        return true;
      } catch (e) {
        clearResult();
        setStatus(e instanceof ScryfallError ? `Scryfall: ${e.message}` : 'Sin conexión con Scryfall. Reintenta.');
        return false;
      } finally {
        L.resolving = false;
      }
    },
    [present, readCorner],
  );
  const cornerFirstRef = useRef(cornerFirst);
  cornerFirstRef.current = cornerFirst;

  // ---------- detección continua de la carta ----------
  useEffect(() => {
    if (camState !== 'on') return;
    let alive = true;
    let timer: number | undefined;
    let lastCss: PixelRect | null = null;
    const onLost = () => {
      const L = loop.current;
      L.lastName = null;
      L.stable = 0;
      L.resolvedKey = null;
      L.cornerReads = null;
      L.misses = 0;
      setHit('');
      setZones({ title: null, code: null });
      // Solo se limpia el panel si la carta ya se agregó: si no, se deja para poder tocar Agregar
      // después de retirarla (o cambiar la edición con calma).
      if (latestResult.current && latestResult.current.addedCount > 0) clearResult();
    };
    const run = () => {
      if (!alive) return;
      const video = videoRef.current;
      if (video && video.readyState >= 2 && video.videoWidth && !pausedRef.current) {
        try {
          const det = detectCard(video);
          const prev = detRef.current;
          const now = performance.now();
          if (det) {
            let rect = det.rect;
            if (prev && iou(prev.rect, det.rect) > 0.7) {
              rect = {
                x: (prev.rect.x + det.rect.x) / 2,
                y: (prev.rect.y + det.rect.y) / 2,
                w: (prev.rect.w + det.rect.w) / 2,
                h: (prev.rect.h + det.rect.h) / 2,
              };
            }
            detRef.current = { ...det, rect, at: now };
            // El recuadro en pantalla es la carta (sin la caja envolvente), girada si está inclinada.
            const c = det.card;
            const css = videoRectToCssRect(
              { x: c.cx - c.w / 2, y: c.cy - c.h / 2, w: c.w, h: c.h },
              camSizeRef.current,
              sourceSize(video),
            );
            if (
              !lastCss ||
              Math.abs(css.x - lastCss.x) > 1.5 ||
              Math.abs(css.y - lastCss.y) > 1.5 ||
              Math.abs(css.w - lastCss.w) > 1.5 ||
              Math.abs(css.h - lastCss.h) > 1.5 ||
              (prev && (prev.outer !== det.outer || Math.abs(prev.card.tilt - c.tilt) > 0.01))
            ) {
              lastCss = css;
              setDetCss({ ...css, outer: det.outer, tilt: c.tilt });
            }
          } else if (prev && now - prev.at > 700) {
            // La carta salió del cuadro: se olvida lo identificado para que la siguiente se lea de cero.
            detRef.current = null;
            lastCss = null;
            setDetCss(null);
            onLost();
          }
        } catch (e) {
          console.warn('[detect]', e);
        }
      }
      timer = window.setTimeout(run, 170);
    };
    run();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [camState, clearResult]);

  // ---------- bucle de lectura (OCR) ----------
  useEffect(() => {
    if (camState !== 'on' || ocr.state !== 'ready') return;
    const L = loop.current;
    L.running = true;
    let timer: number | undefined;
    const schedule = (ms: number) => {
      if (L.running) timer = window.setTimeout(() => void tick(), ms);
    };
    const tick = async () => {
      if (!L.running) return;
      const video = videoRef.current;
      const idx = indexRef.current;
      const fr = frameRef.current;
      if (!video || !idx || !fr || pausedRef.current || video.readyState < 2 || !video.videoWidth || L.resolving) {
        schedule(200);
        return;
      }
      try {
        setBusy(true);
        const size = sourceSize(video);
        const det = detRef.current;
        // Sin detección se usa el marco guía de la pantalla, como antes. Si la carta está
        // inclinada, se trabaja sobre una copia enderezada.
        const prepared = det ? rectifyCard(video, det) : { source: video, rect: cssRectToVideoRect(fr, camSizeRef.current, size) };
        const source: Source = prepared.source;
        const cardRect = prepared.rect;
        const outer = det ? det.outer : true;
        const tilted = source !== video;
        const band = findTitleBand(source, cardRect);
        const corner = settingsRef.current.readCollectorCode ? findCornerBands(source, cardRect, outer) : null;
        setZones(
          tilted
            ? { title: null, code: null }
            : {
                title: videoRectToCssRect(band.rect, camSizeRef.current, size),
                code: corner ? videoRectToCssRect(corner.full, camSizeRef.current, size) : null,
              },
        );
        const { text, match: m } = await readTitle(source, band.rect);
        if (!L.running) return;
        setLastOcr(text);
        if (m) {
          L.misses = 0;
          if (m.name === L.lastName) L.stable++;
          else {
            L.lastName = m.name;
            L.stable = 1;
          }
          setHit((h) => (h === 'found' ? h : 'hit'));
          const ready = L.stable >= 2 || m.score >= 0.97;
          if (ready && L.resolvedKey !== `name:${m.name}`) {
            L.resolvedKey = `name:${m.name}`;
            await resolveRef.current(m, source, cardRect, outer);
          }
        } else {
          L.misses++;
          const now = performance.now();
          if (det && settingsRef.current.readCollectorCode && L.misses >= 2 && now - L.lastCornerAt > 1500) {
            // Sin nombre legible (idioma que no está en el índice, land a arte completo, nombre
            // tapado…): se intenta identificar por la esquina directamente.
            L.lastCornerAt = now;
            await cornerFirstRef.current(source, cardRect, outer, text);
          } else if (!det && L.misses >= 4) {
            // Sin detección, la única señal de que se cambió la carta es que deje de leerse el nombre.
            L.lastName = null;
            L.stable = 0;
            L.resolvedKey = null;
            L.cornerReads = null;
            setHit('');
          } else if (det && !L.resolvedKey) {
            const small = det.card.w < size.w * 0.42;
            setStatus(small ? 'Carta detectada · acércala más para leerla' : 'Carta detectada · leyendo el nombre…');
          }
        }
      } catch (e) {
        console.warn('[scan]', e);
      } finally {
        setBusy(false);
      }
      schedule(80);
    };
    void tick();
    return () => {
      L.running = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [camState, ocr.state]);

  // ---------- foto desde archivo (y gancho de depuración) ----------
  const scanSource = async (source: Source): Promise<ScanDiagnostics> => {
    const idx = indexRef.current;
    const diag: ScanDiagnostics = {
      detected: null,
      outer: null,
      tilt: null,
      text: '',
      match: null,
      score: 0,
      info: null,
      card: null,
      confirmed: false,
    };
    if (!idx) {
      toast.show('Todavía se está cargando el catálogo de nombres, dale un momento.');
      return diag;
    }
    setBusy(true);
    setStatus('Leyendo la foto…');
    try {
      const size = sourceSize(source);
      const det = detectCard(source);
      diag.detected = det?.rect ?? null;
      diag.outer = det?.outer ?? null;
      diag.tilt = det ? +((det.card.tilt * 180) / Math.PI).toFixed(2) : null;
      const prepared = det ? rectifyCard(source, det) : { source, rect: { x: 0, y: 0, w: size.w, h: size.h } };
      source = prepared.source;
      const cardRect: PixelRect = prepared.rect;
      const outer = det ? det.outer : true;
      const band = findTitleBand(source, cardRect);
      const read = await readTitle(source, band.rect);
      let text = read.text;
      let m = read.match;
      if (!m) {
        // Segundo intento con texto disperso, pero solo sobre el cuarto superior de la carta:
        // el texto de ambientación suele citar nombres de otras cartas.
        const top = { x: cardRect.x, y: cardRect.y, w: cardRect.w, h: cardRect.h * 0.24 };
        const sparse = await ocrSparse(preprocessForOcr(cropToCanvas(source, top, Math.min(1400, cardRect.w)), { pad: 20 }));
        m = idx.matchLines(sparse, settingsRef.current.defaultLang);
        text = `${text}\n${sparse}`;
      }
      setLastOcr(text);
      diag.text = text;
      if (m) {
        diag.match = m.name;
        diag.score = m.score;
        loop.current.resolvedKey = `name:${m.name}`;
        await resolveRef.current(m, source, cardRect, outer);
      } else if (settingsRef.current.readCollectorCode) {
        loop.current.cornerReads = null;
        const ok = await cornerFirstRef.current(source, cardRect, outer, text.split('\n')[0] ?? '', true);
        if (!ok) {
          setStatus('No reconocí la carta en la foto. Prueba con más luz o usa Buscar.');
          feedbackError();
          return diag;
        }
      } else {
        setStatus('No reconocí el nombre en la foto. Prueba con más luz o usa Buscar.');
        feedbackError();
        return diag;
      }
      return diag;
    } catch (e) {
      setStatus(`Error leyendo la foto: ${(e as Error).message}`);
      return diag;
    } finally {
      setBusy(false);
    }
  };
  const scanPhoto = async (file: File) => scanSource(await loadImage(file));

  // Ganchos de depuración desde la consola:
  //   mtgScan.image('https://…/carta.jpg')               → la imagen tal cual (carta recortada)
  //   mtgScan.compose('https://…/carta.jpg', { scale })  → la carta puesta sobre un fondo, para probar la detección
  const scanSourceRef = useRef(scanSource);
  scanSourceRef.current = scanSource;
  const resultRef = latestResult;
  useEffect(() => {
    interface ComposeOpts {
      scale?: number;
      dx?: number;
      dy?: number;
      bg?: string;
      width?: number;
      height?: number;
      noise?: number;
      rotate?: number;
    }
    const withResult = (diag: ScanDiagnostics) => {
      const r = resultRef.current;
      return {
        ...diag,
        card: r ? `${r.card.name} · ${r.card.set} #${r.card.collector_number}` : null,
        confirmed: r?.confirmed ?? false,
        info: r?.info ?? null,
      };
    };
    const compose = async (url: string, o: ComposeOpts = {}) => {
      const img = await loadImage(url);
      const W = o.width ?? 1080;
      const H = o.height ?? 1620;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('canvas');
      ctx.fillStyle = o.bg ?? '#7d6b55';
      ctx.fillRect(0, 0, W, H);
      const noise = o.noise ?? 18;
      if (noise > 0) {
        const d = ctx.getImageData(0, 0, W, H);
        for (let i = 0; i < d.data.length; i += 4) {
          const n = (Math.random() - 0.5) * noise;
          d.data[i] += n;
          d.data[i + 1] += n;
          d.data[i + 2] += n;
        }
        ctx.putImageData(d, 0, 0);
      }
      const scale = o.scale ?? 0.72;
      const cw = W * scale;
      const ch = cw / CARD_ASPECT;
      ctx.save();
      ctx.translate(W / 2 + (o.dx ?? 0), H / 2 + (o.dy ?? 0));
      ctx.rotate(((o.rotate ?? 0) * Math.PI) / 180);
      ctx.drawImage(img, -cw / 2, -ch / 2, cw, ch);
      ctx.restore();
      const diag = await scanSourceRef.current(c);
      return { ...withResult(diag), expected: { x: (W - cw) / 2, y: (H - ch) / 2, w: cw, h: ch } };
    };
    // Solo geometría (sin OCR ni Scryfall): detección, franjas y recortes como data URLs.
    const inspect = async (url: string, o: ComposeOpts & { raw?: boolean; ocr?: boolean } = {}) => {
      const img = await loadImage(url);
      let source: Source = img;
      if (!o.raw) {
        const W = o.width ?? 1080;
        const H = o.height ?? 1620;
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const ctx = c.getContext('2d');
        if (!ctx) throw new Error('canvas');
        ctx.fillStyle = o.bg ?? '#7d6b55';
        ctx.fillRect(0, 0, W, H);
        const noise = o.noise ?? 18;
        if (noise > 0) {
          const d = ctx.getImageData(0, 0, W, H);
          for (let i = 0; i < d.data.length; i += 4) {
            const n = (Math.random() - 0.5) * noise;
            d.data[i] += n;
            d.data[i + 1] += n;
            d.data[i + 2] += n;
          }
          ctx.putImageData(d, 0, 0);
        }
        const scale = o.scale ?? 0.72;
        const cw = W * scale;
        const ch = cw / CARD_ASPECT;
        ctx.save();
        ctx.translate(W / 2 + (o.dx ?? 0), H / 2 + (o.dy ?? 0));
        ctx.rotate(((o.rotate ?? 0) * Math.PI) / 180);
        ctx.drawImage(img, -cw / 2, -ch / 2, cw, ch);
        ctx.restore();
        source = c;
      }
      const size = sourceSize(source);
      const t0 = performance.now();
      const det = detectCard(source);
      const detMs = performance.now() - t0;
      const debug = detectDebug(source);
      const prepared = det ? rectifyCard(source, det) : { source, rect: { x: 0, y: 0, w: size.w, h: size.h } };
      const outer = det ? det.outer : true;
      source = prepared.source;
      const cardRect: PixelRect = prepared.rect;
      const title = findTitleBand(source, cardRect);
      const corner = findCornerBands(source, cardRect, outer);
      const pol = { inverted: false };
      const titleCanvas = preprocessForOcr(cropToCanvas(source, title.rect, 1000), { out: pol });
      const titleInv = preprocessForOcr(cropToCanvas(source, title.rect, 1000), { invert: !pol.inverted });
      const titleBin = preprocessForOcr(cropToCanvas(source, title.rect, 1000), { binarize: true });
      const titleBinInv = preprocessForOcr(cropToCanvas(source, title.rect, 1000), { binarize: true, invert: !pol.inverted });
      const titleRaw = cropToCanvas(source, title.rect, 1000);
      const texts = o.ocr
        ? {
            inverted: pol.inverted,
            auto: (await ocrTitle(titleCanvas)).text,
            inv: (await ocrTitle(titleInv)).text,
            bin: (await ocrTitle(titleBin)).text,
            binInv: (await ocrTitle(titleBinInv)).text,
          }
        : null;
      const dark = meanLuma(cropToCanvas(source, corner.left, 300)) < 105;
      const leftCanvas = preprocessForOcr(cropToCanvas(source, corner.left, 1100), { invert: dark });
      const osize = sourceSize(source);
      const overview = cropToCanvas(source, { x: 0, y: 0, w: osize.w, h: osize.h }, 360);
      const octx = overview.getContext('2d');
      if (octx && det) {
        const k = 360 / osize.w;
        octx.strokeStyle = '#3ad0a0';
        octx.lineWidth = 2;
        octx.strokeRect(cardRect.x * k, cardRect.y * k, cardRect.w * k, cardRect.h * k);
        octx.strokeStyle = '#f0a23a';
        octx.strokeRect(title.rect.x * k, title.rect.y * k, title.rect.w * k, title.rect.h * k);
        octx.strokeStyle = '#ff5c8a';
        octx.strokeRect(corner.full.x * k, corner.full.y * k, corner.full.w * k, corner.full.h * k);
      }
      return {
        size,
        det,
        debug,
        tiltDeg: det ? +((det.card.tilt * 180) / Math.PI).toFixed(2) : null,
        detMs: Math.round(detMs),
        profile: debugTitleProfile(source, cardRect),
        title: { rect: title.rect, found: title.found },
        corner: { left: corner.left, full: corner.full, found: corner.found },
        texts,
        images: {
          overview: overview.toDataURL('image/jpeg', 0.7),
          title: titleCanvas.toDataURL(),
          titleInv: titleInv.toDataURL(),
          titleBin: titleBin.toDataURL(),
          titleBinInv: titleBinInv.toDataURL(),
          titleRaw: titleRaw.toDataURL('image/jpeg', 0.85),
          corner: leftCanvas.toDataURL(),
        },
      };
    };
    const w = window as unknown as {
      mtgScan?: {
        image: (url: string) => Promise<ScanDiagnostics>;
        compose: typeof compose;
        detect: (url: string) => Promise<Detection | null>;
        inspect: typeof inspect;
      };
    };
    w.mtgScan = {
      image: async (url: string) => withResult(await scanSourceRef.current(await loadImage(url))),
      compose,
      detect: async (url: string) => detectCard(await loadImage(url)),
      inspect,
    };
    return () => {
      delete w.mtgScan;
    };
  }, []);

  // ---------- cambiar edición ----------
  const openPicker = async () => {
    if (!result) return;
    setPickerOpen(true);
    if (!printings) {
      try {
        setPrintings(await getPrintings(result.card));
      } catch (e) {
        toast.show(`No pude cargar las ediciones: ${(e as Error).message}`, { kind: 'err' });
        setPickerOpen(false);
      }
    }
  };

  const selectPrinting = (p: ScryfallCard) => {
    setPickerOpen(false);
    setResult((r) => (r ? { ...r, card: p, localized: null, confirmed: true, addedCount: 0 } : r));
    const finishes = availableFinishes(p);
    setAdd((a) => ({ ...a, finish: finishes.includes(a.finish) ? a.finish : finishes[0] }));
    setStatus(`${p.set_name} · #${p.collector_number}`);
  };

  const img = result ? cardImage(result.localized ?? result.card, 'small') : null;
  const price = result ? unitPrice(result.card, add.finish, settings.currency) : null;
  const shownName = result
    ? result.localized
      ? displayName(result.localized)
      : result.match.lang !== 'en' && result.match.printed !== result.card.name
        ? `${result.match.printed} (${result.card.name})`
        : result.card.name
    : '';
  const topMessage =
    ocr.state === 'loading'
      ? `${ocr.message} ${Math.round(ocr.progress * 100)}%`
      : ocr.state === 'error'
        ? ocr.message
        : !index && indexStatus
          ? indexStatus
          : status;
  const overlayMessage =
    ocr.state !== 'ready'
      ? ocr.message
      : !index
        ? indexStatus || 'Cargando catálogo de cartas…'
        : detCss
          ? result
            ? 'Cambia de carta para seguir'
            : 'Carta detectada · quieta un momento'
          : 'Muestra la carta completa; el recuadro aparece al detectarla';

  return (
    <div className="view view-scan">
      <div className="scan-top">
        <button
          type="button"
          className={`btn btn-icon ${settings.autoAdd ? 'on' : ''}`}
          title="Agregar automáticamente al reconocer"
          aria-pressed={settings.autoAdd}
          onClick={() => update({ autoAdd: !settings.autoAdd })}
        >
          <Icon name="bolt" />
        </button>
        <div className={`status ${busy ? 'busy' : ''}`}>{topMessage}</div>
        {torchOk && (
          <button
            type="button"
            className={`btn btn-icon ${torchOn ? 'on' : ''}`}
            title="Linterna"
            aria-pressed={torchOn}
            onClick={() => void toggleTorch()}
          >
            <Icon name="flash" />
          </button>
        )}
        <label className="btn btn-icon file-btn" title="Escanear una foto">
          <Icon name="image" />
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void scanPhoto(f);
              e.target.value = '';
            }}
          />
        </label>
        <div className="count" title="Cartas agregadas en esta sesión">
          {sessionCount}
        </div>
      </div>

      <div
        className="scan-camera"
        ref={camRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <video ref={videoRef} playsInline muted autoPlay className={camState === 'on' ? '' : 'hidden'} />
        {camState === 'on' && frame && (
          <>
            <div className={`scan-frame ${hit} ${detCss ? 'guide' : ''}`} style={rectStyle(frame)} />
            {detCss && (
              <div
                className={`scan-det ${hit} ${detCss.outer ? '' : 'inner'}`}
                style={{ ...rectStyle(detCss), transform: detCss.tilt ? `rotate(${detCss.tilt}rad)` : undefined }}
              >
                <i className="c tl" />
                <i className="c tr" />
                <i className="c bl" />
                <i className="c br" />
              </div>
            )}
            {zones.title && <div className="scan-zone" style={rectStyle(zones.title)} />}
            {zones.code && <div className="scan-zone code" style={rectStyle(zones.code)} />}
            {zoom && (
              <div className="scan-zoom">
                <span>{zoom.value.toFixed(1)}×</span>
                <input
                  type="range"
                  min={zoom.min}
                  max={zoom.max}
                  step={zoom.step}
                  value={zoom.value}
                  aria-label="Zoom de la cámara"
                  onChange={(e) => applyZoom(parseFloat(e.target.value))}
                />
              </div>
            )}
            <div className="scan-overlay-msg">{overlayMessage}</div>
          </>
        )}
        {camState !== 'on' && (
          <div className="scan-center">
            <div className="stack">
              {camState === 'starting' && (
                <>
                  <span className="spinner" />
                  <div>Abriendo la cámara…</div>
                </>
              )}
              {camState === 'error' && (
                <>
                  <div>{camError}</div>
                  <button type="button" className="btn" onClick={() => void start()}>
                    Reintentar
                  </button>
                </>
              )}
              {camState === 'off' && (
                <button type="button" className="btn btn-primary btn-lg" onClick={() => void start()}>
                  <Icon name="camera" /> Abrir cámara
                </button>
              )}
              <div className="small muted">
                Sin cámara también puedes <b>escanear una foto</b> (botón de imagen arriba) o usar <b>Buscar</b>.
              </div>
              {indexError && (
                <div className="small" style={{ color: 'var(--warn)' }}>
                  Catálogo de nombres: {indexError}{' '}
                  <button type="button" className="btn btn-sm" onClick={onRetryIndex}>
                    Reintentar
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="scan-panel">
        {settings.showOcrDebug && (
          <div className="ocr-debug">
            OCR: {lastOcr || '—'}
            {result?.info ? `\nEsquina: ${result.info.raw.replace(/\s*\n\s*/g, ' | ')}` : ''}
            {detCss
              ? `\nCarta: ${Math.round(detCss.w)}×${Math.round(detCss.h)} px${detCss.outer ? '' : ' (marco interior)'}`
              : '\nCarta: no detectada'}
          </div>
        )}
        {result ? (
          <>
            <div className="scan-result">
              {img ? <img className="thumb lg" src={img} alt="" /> : <div className="thumb lg" />}
              <div className="grow">
                <div className="name">{shownName}</div>
                <div className="meta">
                  <span>
                    {result.card.set_name} ({result.card.set.toUpperCase()}) · #{result.card.collector_number} ·{' '}
                    {year(result.card.released_at)}
                  </span>
                  <span className={`r-${result.card.rarity}`}>{rarityShort(result.card.rarity)}</span>
                  <span className="price">{money(price, settings.currency)}</span>
                  <span className={`confirm ${result.confirmed ? 'ok' : 'warn'}`}>
                    {result.confirmed
                      ? result.via === 'corner'
                        ? '✓ leída por la esquina'
                        : '✓ edición leída'
                      : result.via === 'corner'
                        ? '? esquina sin confirmar'
                        : '? edición sin confirmar'}
                  </span>
                </div>
                <div className="hstack" style={{ marginTop: 6 }}>
                  <button type="button" className="btn btn-sm" onClick={() => void openPicker()}>
                    <Icon name="swap" size={16} /> Cambiar edición
                  </button>
                  {result.addedCount > 0 && (
                    <span className="small" style={{ color: 'var(--ok)', fontWeight: 700 }}>
                      ✓ {result.addedCount} agregada{result.addedCount > 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <AddControls state={add} onChange={setAdd} finishes={availableFinishes(result.card)} />
            <div className="scan-actions">
              <Stepper value={add.quantity} onChange={(q) => setAdd({ ...add, quantity: q })} />
              <button
                type="button"
                className="btn btn-primary btn-lg"
                disabled={adding}
                onClick={() => void doAdd(result.card, add)}
              >
                {adding ? <span className="spinner" /> : <Icon name="plus" />} Agregar
                {add.quantity > 1 ? ` ×${add.quantity}` : ''}
              </button>
            </div>
          </>
        ) : (
          <div className="spread">
            <div className="small muted">
              {settings.autoAdd
                ? 'Modo automático: cada carta reconocida se agrega sola.'
                : 'Reconoce la carta y toca Agregar. Activa ⚡ para que se agregue sola.'}
            </div>
            <div className="hstack">
              {camState === 'on' && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={stop} title="Apagar cámara">
                  <Icon name="close" size={16} />
                </button>
              )}
              <button type="button" className="btn btn-sm btn-ghost" onClick={goSearch}>
                Buscar manual
              </button>
            </div>
          </div>
        )}
      </div>

      {pickerOpen && result && (
        <PrintingPicker
          printings={printings}
          selectedId={result.card.id}
          onSelect={selectPrinting}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
