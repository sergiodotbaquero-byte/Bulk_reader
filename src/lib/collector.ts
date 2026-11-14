/**
 * Lectura de la esquina inferior izquierda de la carta:
 *   0123/0274 R        → número de coleccionista / tamaño del set, rareza   (2014–2024)
 *   C 0145  ·  FIN • SP → rareza y número sin total; set e idioma            (desde 2025)
 *   MOM • EN           → código del set e idioma
 * En cartas más viejas solo aparece "123/249" (sin set) o nada.
 */

export interface CollectorInfo {
  number: string | null;
  total: number | null;
  rarity: string | null;
  set: string | null;
  lang: string | null;
  raw: string;
}

const LANG_CODES: Record<string, string> = {
  EN: 'en',
  ES: 'es',
  SP: 'es',
  FR: 'fr',
  DE: 'de',
  IT: 'it',
  PT: 'pt',
  JA: 'ja',
  JP: 'ja',
  KO: 'ko',
  KR: 'ko',
  RU: 'ru',
  ZHS: 'zhs',
  ZHT: 'zht',
  CS: 'zhs',
  CT: 'zht',
  PH: 'ph',
};

// El idioma se valida corrigiendo dígitos que el OCR mete por letras ("5P" → "SP", "1T" → "IT").
const DIGIT_TO_LETTER: Record<string, string> = { '5': 'S', '0': 'O', '1': 'I', '8': 'B', '2': 'Z', '4': 'A', '7': 'T' };

function langFromToken(token: string): string | null {
  const direct = LANG_CODES[token];
  if (direct) return direct;
  const fixed = token.replace(/[0-9]/g, (d) => DIGIT_TO_LETTER[d] ?? d);
  return LANG_CODES[fixed] ?? null;
}

/** Combina dos lecturas: conserva lo que ya se tenía y rellena lo que falte. */
export function mergeCollectorInfo(a: CollectorInfo, b: CollectorInfo): CollectorInfo {
  return {
    number: a.number ?? b.number,
    total: a.total ?? b.total,
    rarity: a.rarity ?? b.rarity,
    set: a.set ?? b.set,
    lang: a.lang ?? b.lang,
    raw: [a.raw, b.raw].filter(Boolean).join('\n'),
  };
}

export const EMPTY_COLLECTOR_INFO: CollectorInfo = { number: null, total: null, rarity: null, set: null, lang: null, raw: '' };

interface NumberCandidate {
  number: string;
  rarity: string | null;
  total: number | null;
  /** Mayor = más fiable: fracción completa > número con ceros a la izquierda > número suelto. */
  weight: number;
}

const RARITY = '[CURMSTL]';

export function parseCollectorText(raw: string): CollectorInfo {
  const info: CollectorInfo = { number: null, total: null, rarity: null, set: null, lang: null, raw };
  const text = raw
    .toUpperCase()
    // "|" y "!" pegados a dígitos son unos ("|68/269"); sueltos son ruido, no se tocan.
    .replace(/(?<=\d)[|!]|[|!](?=\d)/g, '1')
    .replace(/(?<=\d)[)\]}](?=[^A-Z0-9]|$)/g, '1')
    .replace(/[—–]/g, '-');

  const candidates: NumberCandidate[] = [];

  // 168/269 C   (también "168.269" o "168,269" si el OCR se come la barra)
  for (const m of text.matchAll(new RegExp(`(\\d{1,4})([A-Z†★]?)\\s*[\\/.,]\\s*(\\d{2,4})(?:\\s*(${RARITY}))?(?![A-Z0-9])`, 'g'))) {
    let num = String(parseInt(m[1], 10));
    const total = parseInt(m[3], 10);
    // "51/264" leído como "510/264" o "513/264": si el número supera el total, prueba quitando
    // el último dígito (lo más común) y luego el primero. Un número así reparado nunca confirma
    // la edición por sí solo: hace falta que el total cuadre con el tamaño del set.
    if (parseInt(num, 10) > total && num.length >= 2) {
      const alt = [num.slice(0, -1), num.slice(1)].find((c) => parseInt(c, 10) >= 1 && parseInt(c, 10) <= total);
      num = alt ?? '';
    }
    if (!num) continue;
    candidates.push({ number: num + (m[2] ? m[2].toLowerCase() : ''), rarity: m[4] ?? null, total, weight: 3 + (m[0].includes('/') ? 1 : 0) });
  }
  // 0145 C   (número y rareza)
  for (const m of text.matchAll(new RegExp(`(?:^|[^A-Z0-9])(0*)(\\d{1,4})([A-Z†★]?)\\s+(${RARITY})(?![A-Z0-9])`, 'g'))) {
    candidates.push({ number: m[2] + (m[3] ? m[3].toLowerCase() : ''), rarity: m[4], total: null, weight: 1 + (m[1] ? 1 : 0) + (m[2].length >= 3 ? 0.5 : 0) });
  }
  // C 0145   (rareza y número, marcos desde 2025, sin total)
  for (const m of text.matchAll(new RegExp(`(?:^|[^A-Z0-9])(${RARITY})\\s+(0*)(\\d{1,4})([A-Z†★]?)(?![A-Z0-9])`, 'g'))) {
    candidates.push({ number: m[3] + (m[4] ? m[4].toLowerCase() : ''), rarity: m[1], total: null, weight: 1.2 + (m[2] ? 1 : 0) + (m[3].length >= 3 ? 0.5 : 0) });
  }
  // 0145 a secas (marcos nuevos cuando la letra de rareza no se leyó)
  for (const m of text.matchAll(/(?:^|[^A-Z0-9])0(\d{2,3})(?![A-Z0-9])/g)) {
    candidates.push({ number: String(parseInt(m[1], 10)), rarity: null, total: null, weight: 1 });
  }
  candidates.sort((a, b) => b.weight - a.weight);
  const best = candidates[0];
  if (best) {
    info.number = best.number;
    info.total = best.total;
    info.rarity = best.rarity;
  }

  // "SET • EN": dos fichas alfanuméricas seguidas (3-4 letras y 2-3 letras) en el mismo renglón,
  // separadas por como mucho 4 caracteres (el punto "•" sale como +, *, «, ¢, ' o nada).
  const tokens = [...text.matchAll(/[A-Z0-9]+/g)].map((m) => ({ t: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (a.t.length < 3 || a.t.length > 4 || b.t.length < 2 || b.t.length > 3) continue;
    const gap = text.slice(a.end, b.start);
    if (gap.length > 4 || gap.includes('\n')) continue;
    // Un código de set no es solo dígitos (eso sería el número de coleccionista).
    if (/^\d+$/.test(a.t)) continue;
    const lang = langFromToken(b.t);
    if (!lang) continue;
    info.set = a.t.toLowerCase();
    info.lang = lang;
    break;
  }
  return info;
}

/**
 * Caracteres que el OCR confunde entre sí en el texto diminuto de la esquina. Sustituir uno por
 * otro del mismo grupo cuesta la mitad que una sustitución cualquiera.
 */
const CONFUSABLE = ['0od', '1ilj', '5s', '8b', '2z', '6g', '7t', 'uv', 'mn', 'ce', 'kx', 'vy', 'fe', 'rp'];
const CONFUSION = new Map<string, number>();
for (const group of CONFUSABLE) {
  for (const a of group) for (const b of group) if (a !== b) CONFUSION.set(a + b, 0.5);
}

/**
 * Distancia entre un código leído por el OCR y uno real, con sustituciones baratas entre
 * caracteres que se confunden ("dex" → "dsk" cuesta 1, no 2). Las inserciones y borrados cuestan 1.
 */
export function ocrDistance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 0;
  let prev = new Array<number>(y.length + 1);
  let cur = new Array<number>(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const ca = x[i - 1];
      const cb = y[j - 1];
      const sub = ca === cb ? 0 : (CONFUSION.get(ca + cb) ?? 1);
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + sub);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[y.length];
}

/** Variantes del código de set para corregir confusiones típicas del OCR (0/O/D, 1/I, 5/S, 8/B, 2/Z). */
export function setCodeVariants(code: string): string[] {
  const swaps: Record<string, string[]> = {
    '0': ['o'],
    o: ['0', 'd'],
    d: ['o'],
    '1': ['i'],
    i: ['1'],
    l: ['1', 'i'],
    '5': ['s'],
    s: ['5'],
    '8': ['b'],
    b: ['8'],
    '2': ['z'],
    z: ['2'],
  };
  const out = new Set<string>([code]);
  for (let i = 0; i < code.length; i++) {
    for (const alt of swaps[code[i]] ?? []) out.add(code.slice(0, i) + alt + code.slice(i + 1));
  }
  return [...out].slice(0, 7);
}
