/** Geometría del marco de la carta y preprocesado de imagen para el OCR. */

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type PixelRect = Region;

/** Proporción de una carta de Magic (63 × 88 mm). */
export const CARD_ASPECT = 63 / 88;
/** Zona del nombre (fracciones del marco de la carta). */
export const TITLE_REGION: Region = { x: 0.05, y: 0.038, w: 0.76, h: 0.07 };
/**
 * Franja inferior con el número de coleccionista / código de set. Va de lado a lado
 * porque en marcos viejos (hasta 2003) el "67/350" está al final de la línea del copyright.
 */
export const CODE_REGION: Region = { x: 0.02, y: 0.9, w: 0.96, h: 0.09 };
/** Mitad izquierda de esa franja: donde está el "123/274 · SET • EN" en marcos desde 2014. */
export const CODE_REGION_LEFT: Region = { x: 0.02, y: 0.9, w: 0.55, h: 0.085 };

/**
 * Convierte un rectángulo en píxeles CSS del contenedor (video con object-fit: cover)
 * a coordenadas intrínsecas del video.
 */
export function cssRectToVideoRect(
  css: PixelRect,
  container: { w: number; h: number },
  video: { w: number; h: number },
): PixelRect {
  const scale = Math.max(container.w / video.w, container.h / video.h);
  const dispW = video.w * scale;
  const dispH = video.h * scale;
  const offX = (container.w - dispW) / 2;
  const offY = (container.h - dispH) / 2;
  return { x: (css.x - offX) / scale, y: (css.y - offY) / scale, w: css.w / scale, h: css.h / scale };
}

/** Inversa de cssRectToVideoRect: de píxeles del video a píxeles CSS del contenedor. */
export function videoRectToCssRect(
  v: PixelRect,
  container: { w: number; h: number },
  video: { w: number; h: number },
): PixelRect {
  const scale = Math.max(container.w / video.w, container.h / video.h);
  const offX = (container.w - video.w * scale) / 2;
  const offY = (container.h - video.h * scale) / 2;
  return { x: v.x * scale + offX, y: v.y * scale + offY, w: v.w * scale, h: v.h * scale };
}

export function subRegion(frame: PixelRect, r: Region): PixelRect {
  return { x: frame.x + frame.w * r.x, y: frame.y + frame.h * r.y, w: frame.w * r.w, h: frame.h * r.h };
}

type Source = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

export function sourceSize(source: Source): { w: number; h: number } {
  if (source instanceof HTMLVideoElement) return { w: source.videoWidth, h: source.videoHeight };
  if (source instanceof HTMLImageElement) return { w: source.naturalWidth, h: source.naturalHeight };
  return { w: source.width, h: source.height };
}

/** Recorta `rect` de la fuente y lo reescala a `targetWidth` px de ancho. */
export function cropToCanvas(source: Source, rect: PixelRect, targetWidth: number): HTMLCanvasElement {
  const size = sourceSize(source);
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const sw = Math.max(1, Math.min(Math.round(rect.w), size.w - x));
  const sh = Math.max(1, Math.min(Math.round(rect.h), size.h - y));
  const scale = targetWidth / sw;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D no disponible');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, x, y, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function percentile(hist: Uint32Array, total: number, q: number): number {
  let acc = 0;
  const target = total * q;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

/**
 * Escala de grises + estirado de contraste; si el fondo es oscuro (texto claro) invierte,
 * porque Tesseract rinde mejor con texto oscuro sobre fondo claro. Añade un margen blanco.
 */
/**
 * Umbral adaptativo (Bradley): un píxel es tinta si es claramente más oscuro que la media
 * de su vecindario. Aguanta fondos mixtos (borde blanco + franja de color + borde negro)
 * y la luz despareja de una foto, donde un umbral global se come el texto pequeño.
 */
function adaptiveThreshold(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  t: number,
  minContrast: number,
): void {
  const W1 = w + 1;
  const integral = new Float64Array(W1 * (h + 1));
  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    for (let x = 1; x <= w; x++) {
      rowSum += gray[(y - 1) * w + (x - 1)];
      integral[y * W1 + x] = integral[(y - 1) * W1 + x] + rowSum;
    }
  }
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * W1 + (x1 + 1)] -
        integral[y0 * W1 + (x1 + 1)] -
        integral[(y1 + 1) * W1 + x0] +
        integral[y0 * W1 + x0];
      const mean = sum / area;
      const v = gray[y * w + x];
      // El contraste mínimo absoluto evita que el grano JPEG o el ruido de la cámara
      // en zonas oscuras uniformes se convierta en "letras".
      out[y * w + x] = v < mean * (1 - t) && mean - v > minContrast ? 0 : 255;
    }
  }
  gray.set(out);
}

/** Luminancia media (0-255) de un canvas, muestreando píxeles. */
export function meanLuma(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 128;
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < d.length; i += 16) {
    sum += (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    count++;
  }
  return count ? sum / count : 128;
}

/**
 * Escala de grises + estirado de contraste; si el fondo es oscuro (texto claro) invierte,
 * porque Tesseract rinde mejor con texto oscuro sobre fondo claro. Añade un margen blanco.
 * `invert` fuerza la polaridad (si no se pasa, se decide por el brillo medio).
 */
export function preprocessForOcr(
  canvas: HTMLCanvasElement,
  opts: { invert?: boolean; pad?: number; binarize?: boolean; out?: { inverted: boolean } } = {},
): HTMLCanvasElement {
  const { pad = 14, binarize = false } = opts;
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D no disponible');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const gray = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const g = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    gray[p] = g;
    hist[g]++;
    sum += g;
  }
  const lo = percentile(hist, n, 0.02);
  const hi = percentile(hist, n, 0.98);
  const range = Math.max(8, hi - lo);
  // Polaridad: el texto es una minoría de píxeles. Si la cola clara del histograma se aleja
  // más de la mediana que la oscura, las letras son claras sobre fondo oscuro (marcos viejos,
  // bordes negros) y hay que invertir; si no, es texto oscuro sobre claro (marcos modernos).
  const p10 = percentile(hist, n, 0.1);
  const p50 = percentile(hist, n, 0.5);
  const p90 = percentile(hist, n, 0.9);
  const brightTail = p90 - p50;
  const darkTail = p50 - p10;
  const invert = opts.invert ?? (sum / n < 70 || brightTail > darkTail * 1.3);
  if (opts.out) opts.out.inverted = invert;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    let v = ((gray[p] - lo) * 255) / range;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    if (invert) v = 255 - v;
    gray[p] = v;
  }
  if (binarize) {
    // Texto diminuto (la esquina del número): blanco y negro puro, decidido por vecindario.
    adaptiveThreshold(gray, w, h, Math.max(8, Math.round(h / 5)), 0.2, 28);
  }
  // Borra los bordes del marco de la carta (líneas largas y muy oscuras, horizontales o
  // verticales, cerca de los bordes del recorte): confunden al OCR y nunca forman parte del
  // texto. Se exige que la fila/columna sea casi toda oscura para no borrar fondos texturizados.
  const rowDark = new Uint32Array(h);
  const colDark = new Uint32Array(w);
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      if (gray[p] < 80) {
        rowDark[y]++;
        colDark[x]++;
      }
    }
  }
  const badRow = new Uint8Array(h);
  const badCol = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    const nearEdge = y < h * 0.3 || y > h * 0.7;
    if (nearEdge && rowDark[y] > w * 0.85) badRow[Math.max(0, y - 1)] = badRow[y] = badRow[Math.min(h - 1, y + 1)] = 1;
  }
  for (let x = 0; x < w; x++) {
    const nearEdge = x < w * 0.15 || x > w * 0.85;
    if (nearEdge && colDark[x] > h * 0.85) badCol[Math.max(0, x - 1)] = badCol[x] = badCol[Math.min(w - 1, x + 1)] = 1;
  }
  for (let y = 0, p = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++, i += 4) {
      const v = badRow[y] || badCol[x] ? 255 : gray[p];
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (pad <= 0) return canvas;
  const out = document.createElement('canvas');
  out.width = w + pad * 2;
  out.height = h + pad * 2;
  const octx = out.getContext('2d');
  if (!octx) return canvas;
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(canvas, pad, pad);
  return out;
}

export function loadImage(src: string | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const url = typeof src === 'string' ? src : URL.createObjectURL(src);
    img.onload = () => {
      if (typeof src !== 'string') URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => reject(new Error('No se pudo cargar la imagen'));
    img.src = url;
  });
}
