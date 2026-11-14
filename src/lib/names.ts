/**
 * Índice local de nombres de cartas para corregir lo que lee el OCR, en varios idiomas.
 * Cada entrada es un nombre normalizado (como se ve impreso) con las opciones que lo explican:
 * el nombre oficial en inglés y el idioma. Con ~100k nombres (inglés + español + portugués),
 * una preselección por bigramas y Levenshtein sobre los mejores candidatos tarda pocos
 * milisegundos incluso en un celular.
 */

export function normalizeName(s: string): string {
  return s
    .replace(/æ/gi, 'ae')
    .replace(/œ/gi, 'oe')
    .replace(/ß/g, 'ss')
    .replace(/ø/gi, 'o')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshtein(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[b.length];
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Una forma de leer un nombre impreso: a qué carta (nombre oficial en inglés) y en qué idioma corresponde. */
export interface NameOption {
  /** Nombre oficial en inglés (completo, p. ej. "Fire // Ice" aunque se haya leído "Fire"). */
  name: string;
  /** Nombre tal como está impreso en ese idioma (en inglés, el mismo nombre). */
  printed: string;
  lang: string;
}

export interface NameMatch extends NameOption {
  /** 0..1 */
  score: number;
  norm: string;
  query: string;
  /** Todas las lecturas posibles de ese nombre impreso (p. ej. el mismo nombre en es y pt). */
  options?: NameOption[];
}

interface Entry {
  norm: string;
  options: NameOption[];
}

export function similarity(q: string, n: string): number {
  const maxLen = Math.max(q.length, n.length);
  const maxDist = Math.ceil(maxLen * 0.45);
  const d = levenshtein(q, n, maxDist);
  let s = d > maxDist ? 0 : 1 - d / maxLen;
  // El OCR suele pegar basura al final (los símbolos de maná): compara también solo el inicio.
  if (q.length > n.length + 1) {
    const head = q.slice(0, n.length);
    const d2 = levenshtein(head, n, Math.ceil(n.length * 0.45));
    const s2 = d2 > n.length ? 0 : (1 - d2 / n.length) * 0.96;
    if (s2 > s) s = s2;
  }
  return s;
}

function minScoreFor(len: number): number {
  if (len <= 4) return 0.99;
  if (len <= 6) return 0.8;
  if (len <= 10) return 0.75;
  return 0.7;
}

export class NameIndex {
  private entries: Entry[] = [];
  private byNorm = new Map<string, number>();
  private grams = new Map<string, number[]>();
  private counts = new Map<string, number>();

  constructor(englishNames: string[] = []) {
    if (englishNames.length) this.addEnglish(englishNames);
  }

  /** Catálogo de nombres en inglés (Scryfall /catalog/card-names). */
  addEnglish(names: string[]): number {
    let added = 0;
    for (const full of names) if (this.add(full, full, 'en')) added++;
    // Caras de cartas dobles o divididas: en la carta física solo se ve el nombre de la cara.
    for (const full of names) {
      if (full.includes(' // ')) for (const face of full.split(' // ')) if (this.add(face, full, 'en', face)) added++;
    }
    return added;
  }

  /** Pares [nombre impreso, nombre en inglés] de otro idioma. */
  addPairs(pairs: [string, string][], lang: string): number {
    let added = 0;
    for (const [printed, english] of pairs) {
      if (this.add(printed, english, lang)) added++;
      if (printed.includes(' // ')) for (const face of printed.split(' // ')) if (this.add(face, english, lang, face)) added++;
    }
    return added;
  }

  private add(label: string, name: string, lang: string, printed = label): boolean {
    const norm = normalizeName(label);
    if (norm.length < 2) return false;
    let idx = this.byNorm.get(norm);
    if (idx === undefined) {
      idx = this.entries.push({ norm, options: [] }) - 1;
      this.byNorm.set(norm, idx);
      for (const g of new Set(bigrams(norm))) {
        let arr = this.grams.get(g);
        if (!arr) {
          arr = [];
          this.grams.set(g, arr);
        }
        arr.push(idx);
      }
    }
    const opts = this.entries[idx].options;
    if (opts.some((o) => o.name === name && o.lang === lang)) return false;
    opts.push({ name, printed, lang });
    this.counts.set(lang, (this.counts.get(lang) ?? 0) + 1);
    return true;
  }

  /** Nombres distintos (normalizados) en el índice. */
  get size(): number {
    return this.entries.length;
  }

  /** Cuántos nombres impresos hay de un idioma. */
  countFor(lang: string): number {
    return this.counts.get(lang) ?? 0;
  }

  get langs(): string[] {
    return [...this.counts.keys()];
  }

  private pick(entry: Entry, preferLang?: string): NameOption {
    const o = entry.options;
    return (preferLang ? o.find((x) => x.lang === preferLang) : undefined) ?? o.find((x) => x.lang === 'en') ?? o[0];
  }

  private toMatch(entry: Entry, score: number, q: string, preferLang?: string): NameMatch {
    const o = this.pick(entry, preferLang);
    return { ...o, score, norm: entry.norm, query: q, options: entry.options.length > 1 ? entry.options : undefined };
  }

  private shortlist(q: string, limit: number): number[] {
    const qg = [...new Set(bigrams(q))];
    const counts = new Map<number, number>();
    for (const g of qg) {
      const arr = this.grams.get(g);
      if (!arr) continue;
      for (const i of arr) counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    const need = Math.min(2, qg.length);
    const list: { i: number; s: number }[] = [];
    for (const [i, c] of counts) {
      if (c < need) continue;
      const len = this.entries[i].norm.length;
      list.push({ i, s: c / Math.max(qg.length, len - 1) });
    }
    list.sort((a, b) => b.s - a.s);
    return list.slice(0, limit).map((x) => x.i);
  }

  /**
   * Mejor coincidencia para un texto leído por el OCR, o null si no hay nada fiable.
   * `preferLang` decide el idioma cuando el mismo nombre impreso existe en varios.
   */
  match(raw: string, preferLang?: string): NameMatch | null {
    const q = normalizeName(raw);
    if (q.length < 3) return null;
    const exactIdx = this.byNorm.get(q);
    if (exactIdx !== undefined) return this.toMatch(this.entries[exactIdx], 1, q, preferLang);

    let best: { e: Entry; score: number } | null = null;
    let second: { e: Entry; score: number } | null = null;
    for (const i of this.shortlist(q, 80)) {
      const e = this.entries[i];
      const score = similarity(q, e.norm);
      if (!best || score > best.score) {
        if (best) second = best;
        best = { e, score };
      } else if (!second || score > second.score) {
        second = { e, score };
      }
    }
    if (!best) return null;
    if (best.score < minScoreFor(best.e.norm.length)) return null;
    // Dos candidatos casi iguales que son cartas distintas: mejor no adivinar.
    if (second && best.score < 0.9 && best.score - second.score < 0.03) {
      const names = new Set(best.e.options.map((o) => o.name));
      if (!second.e.options.every((o) => names.has(o.name))) return null;
    }
    return this.toMatch(best.e, best.score, q, preferLang);
  }

  /** Prueba cada línea de un texto (para fotos completas) y devuelve la mejor coincidencia. */
  matchLines(text: string, preferLang?: string): NameMatch | null {
    let best: NameMatch | null = null;
    for (const line of text.split(/\n+/)) {
      const m = this.match(line, preferLang);
      if (m && (!best || m.score > best.score)) best = m;
    }
    return best;
  }

  /** Sugerencias para el buscador: primero por prefijo, luego parecidos. */
  suggest(raw: string, limit = 8, preferLang?: string): NameOption[] {
    const q = normalizeName(raw);
    if (q.length < 2) return [];
    const out: NameOption[] = [];
    const seen = new Set<string>();
    const push = (e: Entry) => {
      const sorted = [...e.options].sort((a, b) => rank(a) - rank(b));
      for (const o of sorted) {
        const key = `${o.name}|${o.printed}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(o);
      }
    };
    const rank = (o: NameOption) => (o.lang === preferLang ? 0 : o.lang === 'en' ? 1 : 2);
    const prefix: Entry[] = [];
    for (const e of this.entries) {
      if (e.norm.startsWith(q)) {
        prefix.push(e);
        if (prefix.length >= limit * 3) break;
      }
    }
    prefix.sort((a, b) => a.norm.length - b.norm.length || a.norm.localeCompare(b.norm));
    for (const e of prefix) {
      push(e);
      if (out.length >= limit) break;
    }
    if (out.length < limit) {
      const fuzzy = this.shortlist(q, 40)
        .map((i) => ({ e: this.entries[i], s: similarity(q, this.entries[i].norm) }))
        .filter((x) => x.s >= 0.6)
        .sort((a, b) => b.s - a.s);
      for (const { e } of fuzzy) {
        push(e);
        if (out.length >= limit) break;
      }
    }
    return out.slice(0, limit);
  }
}

/**
 * Mejor similitud (0..1) entre un texto leído y cualquiera de los nombres dados. Sirve para
 * validar la carta hallada por set + número contra lo que se leyó en el título.
 */
export function textSimilarity(raw: string, candidates: string[]): number {
  const q = normalizeName(raw);
  if (q.length < 3) return 0;
  let best = 0;
  for (const c of candidates) {
    const n = normalizeName(c);
    if (n.length < 2) continue;
    const s = similarity(q, n);
    if (s > best) best = s;
  }
  return best;
}
