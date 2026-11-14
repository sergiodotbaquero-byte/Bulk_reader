/**
 * Detección de la carta dentro del cuadro de la cámara, sin zonas fijas.
 *
 * La carta es un rectángulo con proporción 63:88 cuyos cuatro lados son bordes largos y
 * rectos. Sobre una copia pequeña del cuadro (192 px de ancho) se calculan los gradientes
 * horizontal y vertical y, con sumas acumuladas, se puntúan todos los rectángulos con esa
 * proporción (cualquier tamaño y posición) por la fuerza media de los bordes en sus lados.
 * El mejor gana. Si la carta está algo girada se estima la inclinación por los lados y se
 * repite la búsqueda sobre el cuadro enderezado. Después se intenta ampliar hasta el borde
 * exterior (el borde negro o blanco), porque el marco interior también forma un rectángulo.
 *
 * Con la carta ubicada, el nombre y la esquina del número se buscan por el perfil de
 * "energía de texto" (transiciones horizontales por fila) en vez de por fracciones fijas, así
 * aguanta que la carta esté más cerca, más lejos, descentrada o con el marco interior detectado.
 */
import { CARD_ASPECT, cropToCanvas, sourceSize, subRegion, type PixelRect, type Region } from './image';

type Source = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

export interface Detection {
  /** Caja envolvente de la carta en píxeles de la fuente (sin girar). */
  rect: PixelRect;
  /** Centro y tamaño de la carta (en píxeles de la fuente) y su inclinación en radianes. */
  card: { cx: number; cy: number; w: number; h: number; tilt: number };
  /** Puntuación de bordes (≈ 0 a 2.8); por encima de ~1.05 es una carta clara. */
  score: number;
  sides: { left: number; right: number; top: number; bottom: number };
  /** Si se llegó al borde exterior de la carta (si no, es probable que sea el marco interior). */
  outer: boolean;
}

const SMALL_W = 192;
const MIN_WIDTH_FRAC = 0.28;
const MIN_SCORE = 1.05;
const MIN_SIDE = 0.2;
/** Inclinación mínima (radianes) a partir de la cual vale la pena enderezar (~0.8°). */
const MIN_TILT = 0.014;

let work: HTMLCanvasElement | null = null;

function workCanvas(W: number, H: number): CanvasRenderingContext2D {
  work ??= document.createElement('canvas');
  if (work.width !== W || work.height !== H) {
    work.width = W;
    work.height = H;
  }
  const ctx = work.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D no disponible');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  return ctx;
}

function grayOf(ctx: CanvasRenderingContext2D, W: number, H: number): Float32Array {
  const d = ctx.getImageData(0, 0, W, H).data;
  const n = W * H;
  const g = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) g[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return g;
}

/** Copia pequeña en gris del cuadro, opcionalmente girada `angle` radianes alrededor del centro. */
function smallGray(source: Source, W: number, H: number, angle = 0): Float32Array {
  const ctx = workCanvas(W, H);
  const size = sourceSize(source);
  ctx.save();
  if (angle) {
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2, H / 2);
    ctx.rotate(angle);
    ctx.translate(-W / 2, -H / 2);
  }
  ctx.drawImage(source, 0, 0, size.w, size.h, 0, 0, W, H);
  ctx.restore();
  return grayOf(ctx, W, H);
}

/** Desenfoque 3×3 separable (quita el grano antes de derivar). */
function blur3(g: Float32Array, W: number, H: number): Float32Array {
  const tmp = new Float32Array(g.length);
  const out = new Float32Array(g.length);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    tmp[row] = g[row];
    tmp[row + W - 1] = g[row + W - 1];
    for (let x = 1; x < W - 1; x++) tmp[row + x] = (g[row + x - 1] + g[row + x] + g[row + x + 1]) / 3;
  }
  for (let x = 0; x < W; x++) {
    out[x] = tmp[x];
    out[(H - 1) * W + x] = tmp[(H - 1) * W + x];
  }
  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      out[p] = (tmp[p - W] + tmp[p] + tmp[p + W]) / 3;
    }
  }
  return out;
}

interface Tables {
  W: number;
  H: number;
  g: Float32Array;
  /** |gx| dilatado 1 px en horizontal (bordes verticales). */
  exd: Float32Array;
  /** |gy| dilatado 1 px en vertical (bordes horizontales). */
  eyd: Float32Array;
  /** Suma acumulada por columna de exd: colSum[x * (H + 1) + y]. */
  colSum: Float32Array;
  /** Suma acumulada por fila de eyd: rowSum[y * (W + 1) + x]. */
  rowSum: Float32Array;
}

function buildTables(g0: Float32Array, W: number, H: number): Tables {
  const g = blur3(g0, W, H);
  const n = W * H;
  const ex = new Float32Array(n);
  const ey = new Float32Array(n);
  const NORM = 44;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      const dx = Math.abs(g[p + 1] - g[p - 1]) / NORM;
      const dy = Math.abs(g[p + W] - g[p - W]) / NORM;
      ex[p] = dx > 1 ? 1 : dx;
      ey[p] = dy > 1 ? 1 : dy;
    }
  }
  // Dilatación de 1 px perpendicular al borde: tolera que el lado no caiga en la columna exacta.
  const exd = new Float32Array(n);
  const eyd = new Float32Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      exd[p] = Math.max(ex[p - 1], ex[p], ex[p + 1]);
    }
  }
  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      eyd[p] = Math.max(ey[p - W], ey[p], ey[p + W]);
    }
  }
  const colSum = new Float32Array(W * (H + 1));
  for (let x = 0; x < W; x++) {
    const base = x * (H + 1);
    let acc = 0;
    for (let y = 0; y < H; y++) {
      acc += exd[y * W + x];
      colSum[base + y + 1] = acc;
    }
  }
  const rowSum = new Float32Array(H * (W + 1));
  for (let y = 0; y < H; y++) {
    const base = y * (W + 1);
    let acc = 0;
    for (let x = 0; x < W; x++) {
      acc += eyd[y * W + x];
      rowSum[base + x + 1] = acc;
    }
  }
  return { W, H, g, exd, eyd, colSum, rowSum };
}

interface Candidate {
  x0: number;
  y0: number;
  w: number;
  h: number;
  score: number;
  l: number;
  r: number;
  t: number;
  b: number;
}

/** Puntuación de un rectángulo: el par de lados más débil manda (una mesa con un borde fuerte no debe ganar). */
function scoreRect(T: Tables, x0: number, y0: number, w: number, h: number): Candidate {
  const H1 = T.H + 1;
  const W1 = T.W + 1;
  const xr = x0 + w - 1;
  const yb = y0 + h - 1;
  const l = (T.colSum[x0 * H1 + y0 + h] - T.colSum[x0 * H1 + y0]) / h;
  const r = (T.colSum[xr * H1 + y0 + h] - T.colSum[xr * H1 + y0]) / h;
  const t = (T.rowSum[y0 * W1 + x0 + w] - T.rowSum[y0 * W1 + x0]) / w;
  const b = (T.rowSum[yb * W1 + x0 + w] - T.rowSum[yb * W1 + x0]) / w;
  const score = Math.min(l, r) + Math.min(t, b) + 0.2 * (l + r + t + b);
  return { x0, y0, w, h, score, l, r, t, b };
}

/** Barrido de todos los rectángulos con proporción de carta; devuelve el mejor (sin crear objetos por candidato). */
function searchBest(T: Tables): Candidate | null {
  const { W, H, colSum, rowSum } = T;
  const H1 = H + 1;
  const W1 = W + 1;
  let bestScore = -1;
  let bx = 0;
  let by = 0;
  let bw = 0;
  let bh = 0;
  const wMin = Math.max(24, Math.round(W * MIN_WIDTH_FRAC));
  for (let w = wMin; w <= W; w += 2) {
    const h0 = Math.round(w / CARD_ASPECT);
    const dh = Math.max(1, Math.round(h0 * 0.025));
    for (let k = -1; k <= 1; k++) {
      const h = h0 + k * dh;
      if (h > H || h < 8) continue;
      for (let y0 = 0; y0 + h <= H; y0 += 2) {
        const yb = y0 + h - 1;
        const rowT = y0 * W1;
        const rowB = yb * W1;
        for (let x0 = 0; x0 + w <= W; x0 += 2) {
          const xr = x0 + w - 1;
          const l = (colSum[x0 * H1 + y0 + h] - colSum[x0 * H1 + y0]) / h;
          const r = (colSum[xr * H1 + y0 + h] - colSum[xr * H1 + y0]) / h;
          const t = (rowSum[rowT + x0 + w] - rowSum[rowT + x0]) / w;
          const b = (rowSum[rowB + x0 + w] - rowSum[rowB + x0]) / w;
          const s = (l < r ? l : r) + (t < b ? t : b) + 0.2 * (l + r + t + b);
          if (s > bestScore) {
            bestScore = s;
            bx = x0;
            by = y0;
            bw = w;
            bh = h;
          }
        }
      }
    }
  }
  if (bestScore < 0) return null;
  let best = scoreRect(T, bx, by, bw, bh);
  // Afinado fino (paso 1, proporción libre ±6 %).
  const seed = best;
  for (let x0 = seed.x0 - 2; x0 <= seed.x0 + 2; x0++) {
    for (let y0 = seed.y0 - 2; y0 <= seed.y0 + 2; y0++) {
      for (let w = seed.w - 2; w <= seed.w + 2; w++) {
        for (let h = seed.h - 2; h <= seed.h + 2; h++) {
          if (x0 < 0 || y0 < 0 || w < 8 || h < 8 || x0 + w > W || y0 + h > H) continue;
          if (Math.abs(w / h / CARD_ASPECT - 1) > 0.06) continue;
          const c = scoreRect(T, x0, y0, w, h);
          if (c.score > best.score) best = c;
        }
      }
    }
  }
  // La dilatación hace que un rectángulo 1-2 px más grande puntúe casi igual: si encogerlo
  // apenas cambia la puntuación, el borde real está más adentro.
  for (let i = 0; i < 3; i++) {
    const c = scoreRect(T, best.x0 + 1, best.y0 + 1, best.w - 2, best.h - 2);
    if (c.w < 8 || c.h < 8 || c.score < best.score * 0.985) break;
    best = c;
  }
  return best;
}

/**
 * Inclinación dominante de los bordes largos alrededor del rectángulo: histograma de la
 * dirección del gradiente (plegada a ±45°) ponderado por su magnitud. Los bordes de la carta y
 * las líneas del marco forman un pico nítido en el ángulo de giro; el arte y el texto se
 * reparten. Devuelve radianes (positivo = horario) o 0 si no hay un pico claro.
 */
function estimateTiltHist(T: Tables, c: Candidate): number {
  const { W, H, g } = T;
  const mx = Math.round(c.w * 0.12);
  const my = Math.round(c.h * 0.12);
  const x0 = Math.max(1, c.x0 - mx);
  const x1 = Math.min(W - 2, c.x0 + c.w + mx);
  const y0 = Math.max(1, c.y0 - my);
  const y1 = Math.min(H - 2, c.y0 + c.h + my);
  const RANGE = 20; // grados
  const BIN = 0.5;
  const bins = new Float32Array(Math.round((2 * RANGE) / BIN) + 1);
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = y * W + x;
      const dx = g[p + 1] - g[p - 1];
      const dy = g[p + W] - g[p - W];
      const mag = Math.abs(dx) + Math.abs(dy);
      if (mag < 24) continue;
      let a = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180
      a = ((a % 90) + 90) % 90; // 0..90
      if (a > 45) a -= 90; // -45..45
      if (a < -RANGE || a > RANGE) continue;
      const b = Math.round((a + RANGE) / BIN);
      bins[b] += mag;
      total += mag;
    }
  }
  if (!total) return 0;
  // Pico (suavizado con los vecinos) frente a la media: si no destaca, no hay giro fiable.
  let bestB = -1;
  let bestV = 0;
  for (let b = 1; b < bins.length - 1; b++) {
    const v = bins[b - 1] + bins[b] + bins[b + 1];
    if (v > bestV) {
      bestV = v;
      bestB = b;
    }
  }
  const mean = (3 * total) / bins.length;
  if (bestB < 0 || bestV < mean * 2.5) return 0;
  // Centro de masa alrededor del pico, para afinar por debajo del tamaño del bin.
  let num = 0;
  let den = 0;
  for (let b = Math.max(0, bestB - 2); b <= Math.min(bins.length - 1, bestB + 2); b++) {
    num += bins[b] * (b * BIN - RANGE);
    den += bins[b];
  }
  const deg = den ? num / den : bestB * BIN - RANGE;
  return (deg * Math.PI) / 180;
}

/** Suma de bordes a lo largo de una línea inclinada (x varía linealmente con y, o al revés). */
function lineSum(map: Float32Array, W: number, H: number, vertical: boolean, a0: number, b0: number, a1: number, len: number): number {
  // vertical: columna a va de a0 (fila b0) a a1 (fila b0+len-1); horizontal: fila a va de a0 a a1 a lo largo de x.
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const a = Math.round(a0 + ((a1 - a0) * i) / Math.max(1, len - 1));
    const b = b0 + i;
    if (vertical) {
      if (a < 0 || a >= W || b < 0 || b >= H) continue;
      sum += map[b * W + a];
    } else {
      if (b < 0 || b >= W || a < 0 || a >= H) continue;
      sum += map[a * W + b];
    }
  }
  return sum / len;
}

/** Inclinación (radianes, positivo = horario) estimada por el cizallamiento de los cuatro lados. */
function estimateTilt(T: Tables, c: Candidate): number {
  const { W, H, exd, eyd } = T;
  const S = Math.max(2, Math.round(c.h * 0.1));
  const sides: { s: number; peak: number; len: number }[] = [];
  const scan = (vertical: boolean, a: number, b0: number, len: number, map: Float32Array) => {
    let bestS = 0;
    let bestV = -1;
    let base = 0;
    for (let s = -S; s <= S; s++) {
      const v = lineSum(map, W, H, vertical, a + s, b0, a - s, len);
      if (s === 0) base = v;
      if (v > bestV) {
        bestV = v;
        bestS = s;
      }
    }
    // Solo cuenta si la línea inclinada es claramente mejor que la recta.
    if (bestV > base * 1.15 && bestV > 0.2) sides.push({ s: bestS, peak: bestV, len });
  };
  scan(true, c.x0, c.y0, c.h, exd);
  scan(true, c.x0 + c.w - 1, c.y0, c.h, exd);
  scan(false, c.y0, c.x0, c.w, eyd);
  scan(false, c.y0 + c.h - 1, c.x0, c.w, eyd);
  if (sides.length < 2) return 0;
  // Lado izquierdo/derecho: x crece hacia abajo cuando la carta gira en sentido antihorario…
  let num = 0;
  let den = 0;
  for (const s of sides) {
    const angle = Math.atan2(2 * s.s, s.len);
    num += angle * s.peak;
    den += s.peak;
  }
  const tilt = den ? num / den : 0;
  // Las cuatro medidas deben coincidir en signo para fiarse.
  const signs = sides.map((s) => Math.sign(s.s));
  if (new Set(signs.filter((x) => x !== 0)).size > 1) return 0;
  return tilt;
}

/** Media y desviación del gris en el anillo entre dos rectángulos (inner dentro de outer). */
function ringStats(g: Float32Array, W: number, inner: Candidate, outer: Candidate): { mean: number; std: number } {
  let sum = 0;
  let sq = 0;
  let n = 0;
  const ox1 = outer.x0 + outer.w;
  const oy1 = outer.y0 + outer.h;
  const ix1 = inner.x0 + inner.w;
  const iy1 = inner.y0 + inner.h;
  for (let y = outer.y0; y < oy1; y++) {
    const insideY = y >= inner.y0 && y < iy1;
    for (let x = outer.x0; x < ox1; x++) {
      if (insideY && x >= inner.x0 && x < ix1) continue;
      const v = g[y * W + x];
      sum += v;
      sq += v * v;
      n++;
    }
  }
  if (!n) return { mean: 128, std: 999 };
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

/** Borde negro o blanco de la carta: anillo liso y claramente oscuro o claro. */
function uniformRing(ring: { mean: number; std: number }): boolean {
  return ring.std < 22 && (ring.mean < 70 || ring.mean > 180);
}

/** Rectángulo encogido `d` px por cada lado (para medir anillos sin la transición del borde). */
function shrunk(c: Candidate, d: number): Candidate {
  return { ...c, x0: c.x0 + d, y0: c.y0 + d, w: c.w - 2 * d, h: c.h - 2 * d };
}

/** Amplía hasta el borde exterior si el marco interior fue lo detectado. Devuelve [candidato, esExterior]. */
function snapOuter(T: Tables, inner: Candidate): [Candidate, boolean] {
  const { W, H, g } = T;
  let bestOuter: Candidate | null = null;
  const mxMin = Math.max(1, Math.round(inner.w * 0.02));
  const mxMax = Math.max(mxMin, Math.round(inner.w * 0.1));
  const myMin = Math.max(1, Math.round(inner.h * 0.015));
  const myMax = Math.max(myMin, Math.round(inner.h * 0.1));
  for (let mx = mxMin; mx <= mxMax; mx++) {
    for (let my = myMin; my <= myMax; my++) {
      const x0 = inner.x0 - mx;
      const y0 = inner.y0 - my;
      const w = inner.w + 2 * mx;
      const h = inner.h + 2 * my;
      if (x0 < 0 || y0 < 0 || x0 + w > W || y0 + h > H) continue;
      if (Math.abs(w / h / CARD_ASPECT - 1) > 0.08) continue;
      const c = scoreRect(T, x0, y0, w, h);
      if (!bestOuter || c.score > bestOuter.score) bestOuter = c;
    }
  }
  // El exterior tiene que ser un rectángulo fuerte por sí mismo (no una franja de fondo con
  // ruido) y el anillo entre ambos, medido sin los píxeles de transición, un borde liso.
  if (
    bestOuter &&
    bestOuter.score >= Math.max(MIN_SCORE, inner.score * 0.75) &&
    Math.min(bestOuter.l, bestOuter.r, bestOuter.t, bestOuter.b) >= 0.45 &&
    bestOuter.w - inner.w >= 6
  ) {
    if (uniformRing(ringStats(g, W, shrunk(inner, -1), shrunk(bestOuter, 1)))) return [bestOuter, true];
  }
  // Sin exterior aparente: si justo dentro hay un anillo liso oscuro o claro, lo que
  // detectamos ya es el borde exterior (borde negro o blanco de la carta).
  const ix = Math.max(2, Math.round(inner.w * 0.035));
  const iy = Math.max(2, Math.round(inner.h * 0.025));
  const inset = scoreRect(T, inner.x0 + ix, inner.y0 + iy, inner.w - 2 * ix, inner.h - 2 * iy);
  return [inner, uniformRing(ringStats(g, W, inset, shrunk(inner, 1)))];
}

/**
 * Busca la carta en la fuente. Devuelve null si no hay un rectángulo claro con proporción de
 * carta (p. ej. la carta se sale del cuadro o no hay carta).
 */
export function detectCard(source: Source): Detection | null {
  const size = sourceSize(source);
  if (!size.w || !size.h) return null;
  const W = SMALL_W;
  const H = Math.max(16, Math.round((size.h * W) / size.w));
  let T = buildTables(smallGray(source, W, H), W, H);
  let best = searchBest(T);
  if (!best) return null;
  let tilt = 0;
  if (best.score >= MIN_SCORE * 0.6) {
    let t = estimateTiltHist(T, best);
    if (Math.abs(t) < MIN_TILT) t = estimateTilt(T, best);
    if (Math.abs(t) >= MIN_TILT && Math.abs(t) < 0.3) {
      // Segunda pasada sobre el cuadro enderezado.
      const T2 = buildTables(smallGray(source, W, H, -t), W, H);
      const b2 = searchBest(T2);
      if (b2 && b2.score >= best.score * 0.9) {
        T = T2;
        best = b2;
        tilt = t;
      }
    }
  }
  if (best.score < MIN_SCORE || Math.min(best.l, best.r, best.t, best.b) < MIN_SIDE) return null;
  const [finalC, outer] = snapOuter(T, best);

  const scale = size.w / W;
  // Centro en el cuadro (enderezado) → centro en la fuente original.
  const cxs = finalC.x0 + finalC.w / 2 - W / 2;
  const cys = finalC.y0 + finalC.h / 2 - H / 2;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const cx = (cxs * cos - cys * sin + W / 2) * scale;
  const cy = (cxs * sin + cys * cos + H / 2) * scale;
  const w = finalC.w * scale;
  const h = finalC.h * scale;
  const bw = Math.abs(w * cos) + Math.abs(h * sin);
  const bh = Math.abs(w * sin) + Math.abs(h * cos);
  return {
    rect: { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh },
    card: { cx, cy, w, h, tilt },
    score: finalC.score,
    sides: { left: finalC.l, right: finalC.r, top: finalC.t, bottom: finalC.b },
    outer,
  };
}

/** Números internos de la detección (mtgScan.inspect): candidato en coordenadas pequeñas y variantes. */
export function detectDebug(source: Source) {
  const size = sourceSize(source);
  const W = SMALL_W;
  const H = Math.max(16, Math.round((size.h * W) / size.w));
  const T = buildTables(smallGray(source, W, H), W, H);
  const best = searchBest(T);
  if (!best) return null;
  const variants = [-2, -1, 0, 1, 2, 3].map((d) => {
    const c = scoreRect(T, best.x0 - d, best.y0 - d, best.w + 2 * d, best.h + 2 * d);
    return { d, score: +c.score.toFixed(3), l: +c.l.toFixed(2), r: +c.r.toFixed(2), t: +c.t.toFixed(2), b: +c.b.toFixed(2) };
  });
  return { W, H, scale: size.w / W, best: { x0: best.x0, y0: best.y0, w: best.w, h: best.h, score: +best.score.toFixed(3) }, variants, tiltHistDeg: +((estimateTiltHist(T, best) * 180) / Math.PI).toFixed(2), tiltSidesDeg: +((estimateTilt(T, best) * 180) / Math.PI).toFixed(2) };
}

/**
 * Si la carta está inclinada, devuelve un canvas con la carta enderezada (y el rectángulo que la
 * cubre entera); si no, la fuente tal cual con la caja detectada.
 */
export function rectifyCard(source: Source, det: Detection, maxWidth = 1400): { source: Source; rect: PixelRect } {
  if (Math.abs(det.card.tilt) < MIN_TILT) return { source, rect: det.rect };
  const k = Math.min(1, maxWidth / det.card.w);
  const cw = Math.max(8, Math.round(det.card.w * k));
  const ch = Math.max(8, Math.round(det.card.h * k));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D no disponible');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(cw / 2, ch / 2);
  ctx.scale(k, k);
  ctx.rotate(-det.card.tilt);
  ctx.translate(-det.card.cx, -det.card.cy);
  const size = sourceSize(source);
  ctx.drawImage(source, 0, 0, size.w, size.h);
  return { source: canvas, rect: { x: 0, y: 0, w: cw, h: ch } };
}

// ---------------------------------------------------------------------------------------------
// Localización de las franjas de texto dentro de la carta detectada
// ---------------------------------------------------------------------------------------------

interface TextRun {
  /** Filas (en píxeles del recorte) donde empieza y termina (exclusivo) la franja. */
  start: number;
  end: number;
  /** Energía media de la franja. */
  mean: number;
}

/**
 * Energía de texto por fila de un recorte: fracción de píxeles con una transición horizontal
 * fuerte. Las filas con letras tienen muchas (trazos verticales); los bordes del marco, casi
 * ninguna (son horizontales); el fondo liso, ninguna.
 */
function rowTextEnergy(source: Source, rect: PixelRect, width: number, cols?: { from: number; to: number }) {
  const canvas = cropToCanvas(source, rect, width);
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D no disponible');
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) g[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  const x0 = Math.max(1, Math.round((cols?.from ?? 0) * w));
  const x1 = Math.min(w - 1, Math.round((cols?.to ?? 1) * w));
  const raw = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    const row = y * w;
    for (let x = x0; x < x1; x++) if (Math.abs(g[row + x + 1] - g[row + x - 1]) > 34) count++;
    raw[y] = count / Math.max(1, x1 - x0);
  }
  const energy = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const a = raw[Math.max(0, y - 1)];
    const b = raw[y];
    const c = raw[Math.min(h - 1, y + 1)];
    energy[y] = (a + b + c) / 3;
  }
  return { energy, w, h };
}

function textRuns(energy: Float32Array, threshold: number, maxGap: number): TextRun[] {
  const runs: TextRun[] = [];
  let start = -1;
  let gap = 0;
  let sum = 0;
  let count = 0;
  for (let y = 0; y <= energy.length; y++) {
    const on = y < energy.length && energy[y] >= threshold;
    if (on) {
      if (start < 0) {
        start = y;
        sum = 0;
        count = 0;
      }
      gap = 0;
      sum += energy[y];
      count++;
    } else if (start >= 0) {
      gap++;
      if (gap > maxGap || y === energy.length) {
        runs.push({ start, end: y - gap + 1, mean: sum / Math.max(1, count) });
        start = -1;
      }
    }
  }
  return runs;
}

const TITLE_SEARCH: Region = { x: 0.035, y: 0, w: 0.79, h: 0.18 };

function titleRuns(source: Source, card: PixelRect) {
  const region = subRegion(card, TITLE_SEARCH);
  const { energy, h } = rowTextEnergy(source, region, 360);
  const pxPerCard = h / TITLE_SEARCH.h;
  let max = 0;
  for (let y = 0; y < h; y++) if (energy[y] > max) max = energy[y];
  const threshold = Math.max(0.05, max * 0.3);
  const runs = textRuns(energy, threshold, Math.max(1, Math.round(pxPerCard * 0.008)));
  // Un renglón de título mide entre el 1.2 % y el 8 % de la altura de la carta.
  const minH = pxPerCard * 0.012;
  const maxH = pxPerCard * 0.08;
  const pick = runs.find((r) => r.end - r.start >= minH && r.end - r.start <= maxH && r.start >= pxPerCard * 0.005 && r.mean >= 0.07);
  return { region, energy, h, pxPerCard, threshold, runs, minH, maxH, pick };
}

/** Perfil de energía de la zona del nombre, para depurar la búsqueda de la franja (mtgScan.inspect). */
export function debugTitleProfile(source: Source, card: PixelRect) {
  const t = titleRuns(source, card);
  return {
    h: t.h,
    pxPerCard: Math.round(t.pxPerCard),
    threshold: +t.threshold.toFixed(3),
    minH: +t.minH.toFixed(1),
    maxH: +t.maxH.toFixed(1),
    energy: Array.from(t.energy, (v) => Math.round(v * 100)),
    runs: t.runs.map((r) => ({ start: r.start, end: r.end, mean: +r.mean.toFixed(3) })),
    pick: t.pick ? { start: t.pick.start, end: t.pick.end } : null,
  };
}

/** Zona por defecto del nombre si el perfil de texto no encuentra nada claro. */
export const TITLE_FALLBACK: Region = { x: 0.04, y: 0.035, w: 0.8, h: 0.08 };

/**
 * Franja del nombre: la primera franja de texto desde arriba con altura de un renglón de título.
 * Funciona tanto si el rectángulo es el borde exterior como si es el marco interior (el título
 * queda más arriba en ese caso).
 */
export function findTitleBand(source: Source, card: PixelRect): { rect: PixelRect; found: boolean } {
  const { region, h, pick } = titleRuns(source, card);
  if (!pick) return { rect: subRegion(card, TITLE_FALLBACK), found: false };
  const scaleY = region.h / h;
  const pad = (pick.end - pick.start) * 0.45;
  const y0 = region.y + Math.max(0, pick.start - pad) * scaleY;
  const y1 = region.y + Math.min(h, pick.end + pad) * scaleY;
  return { rect: { x: region.x, y: y0, w: region.w, h: y1 - y0 }, found: true };
}

export interface CornerBands {
  /** Mitad izquierda de la franja (marcos desde 2014: "123/274 C · SET • EN"). */
  left: PixelRect;
  /** Franja completa (marcos viejos: el número va al final de la línea del copyright). */
  full: PixelRect;
  found: boolean;
}

/** Recorta un rectángulo a los límites de la fuente. */
export function clampRect(r: PixelRect, size: { w: number; h: number }): PixelRect {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const x1 = Math.min(size.w, r.x + r.w);
  const y1 = Math.min(size.h, r.y + r.h);
  return { x, y, w: Math.max(1, x1 - x), h: Math.max(1, y1 - y) };
}

/**
 * Franja del número de coleccionista: las líneas de texto diminuto del borde inferior. Se busca
 * también por debajo del rectángulo (hasta +9 % de la altura) por si se detectó el marco
 * interior, ya que en marcos modernos ese texto va sobre el borde negro, fuera del marco.
 */
export function findCornerBands(source: Source, card: PixelRect, outer: boolean): CornerBands {
  const size = sourceSize(source);
  // Siempre se mira también un poco por debajo del rectángulo: si lo detectado fue el marco
  // interior (p. ej. borde negro sobre fondo oscuro), el texto queda fuera de él.
  const region = clampRect(subRegion(card, { x: 0, y: 0.845, w: 1, h: 0.25 }), size);
  const { energy, h } = rowTextEnergy(source, region, 520, { from: 0.02, to: 0.6 });
  const pxPerCard = (card.h / region.h) * h;
  let max = 0;
  for (let y = 0; y < h; y++) if (energy[y] > max) max = energy[y];
  const runs = textRuns(energy, Math.max(0.04, max * 0.28), Math.max(1, Math.round(pxPerCard * 0.014)));
  const minH = pxPerCard * 0.012;
  const maxH = pxPerCard * 0.075;
  // Nos quedamos con la franja de texto más baja con altura de renglón pequeño (la información
  // del coleccionista es lo último que hay en la carta).
  const candidates = runs.filter((r) => r.end - r.start >= minH && r.end - r.start <= maxH);
  let run = candidates.length ? candidates[candidates.length - 1] : null;
  // Son dos renglones (número y set): si justo encima hay otro renglón pequeño, se incluye.
  const prev = candidates.length > 1 ? candidates[candidates.length - 2] : null;
  if (run && prev && run.start - prev.end <= pxPerCard * 0.035) run = { start: prev.start, end: run.end, mean: run.mean };
  const fallback = (): CornerBands => ({
    left: clampRect(subRegion(card, outer ? { x: 0.02, y: 0.9, w: 0.55, h: 0.085 } : { x: 0.0, y: 0.93, w: 0.56, h: 0.13 }), size),
    full: clampRect(subRegion(card, outer ? { x: 0.02, y: 0.9, w: 0.96, h: 0.09 } : { x: 0.0, y: 0.93, w: 1, h: 0.13 }), size),
    found: false,
  });
  if (!run) return fallback();
  const scaleY = region.h / h;
  const lineH = run.end - run.start;
  const pad = Math.max(lineH * 0.45, pxPerCard * 0.006);
  // Por arriba se deja sitio para un renglón más: el del número suele ser más tenue que el del
  // set y a veces no pasa el umbral de energía.
  const padTop = prev && run.start === prev.start ? pad : Math.max(pad, lineH * 1.3 + pxPerCard * 0.004);
  const y0 = region.y + Math.max(0, run.start - padTop) * scaleY;
  const y1 = region.y + Math.min(h, run.end + pad) * scaleY;
  const band = { y: y0, h: y1 - y0 };
  return {
    left: clampRect({ x: card.x, y: band.y, w: card.w * 0.56, h: band.h }, size),
    full: clampRect({ x: card.x, y: band.y, w: card.w, h: band.h }, size),
    found: true,
  };
}

/** Intersección sobre unión de dos rectángulos (0..1), para saber si una detección "es la misma". */
export function iou(a: PixelRect, b: PixelRect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}
