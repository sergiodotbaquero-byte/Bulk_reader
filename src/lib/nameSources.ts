/**
 * De dónde salen los nombres del índice:
 *  - inglés: catálogo de Scryfall (/catalog/card-names), siempre al día;
 *  - otros idiomas: public/names/<lang>.json, generado con `npm run names` (nombres impresos →
 *    nombre en inglés), más un "delta" que la app baja sola para los sets publicados después de
 *    generar ese archivo, así los sets más nuevos también se reconocen en español/portugués.
 * Todo se guarda en IndexedDB para que la app arranque sin red.
 */
import type { ScryfallCard, ScryfallList } from '../types';
import { db } from './db';
import { NameIndex } from './names';
import { ScryfallError, api, fetchCardNames, fetchSets } from './scryfall';

export type NamePair = [printed: string, english: string];

interface NameFile {
  lang: string;
  builtAt: string;
  pairs: NamePair[];
}

interface CachedNames {
  pairs: NamePair[];
  builtAt: string;
  version: string;
}

interface CachedDelta {
  pairs: NamePair[];
}

const STATIC_TTL = 30 * 24 * 3600e3;
const DELTA_TTL = 3 * 24 * 3600e3;
/** Días antes de la fecha del archivo estático desde los que se vuelven a mirar los sets. */
const DELTA_WINDOW_DAYS = 14;
const MAX_DELTA_SETS = 16;
const SKIP_SET_TYPES = new Set(['token', 'memorabilia', 'minigame', 'alchemy']);

/** Pares (nombre impreso, nombre en inglés) de una carta; omite lo que coincide con el inglés. */
export function pairsOfCard(card: ScryfallCard): NamePair[] {
  const out: NamePair[] = [];
  const push = (printed: string | undefined, english: string) => {
    const p = printed?.trim();
    if (!p || p === english) return;
    out.push([p, english]);
  };
  push(card.printed_name, card.name);
  if (card.card_faces) for (const f of card.card_faces) push(f.printed_name, card.name);
  return out;
}

async function loadStaticNames(lang: string, force: boolean): Promise<CachedNames | null> {
  const key = `names:${lang}`;
  const row = await db.kv.get(key);
  const cached = row?.value as CachedNames | undefined;
  const version = __APP_VERSION__;
  if (cached && !force && cached.version === version && row && Date.now() - row.updatedAt < STATIC_TTL) return cached;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}names/${lang}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`names/${lang}.json respondió ${res.status}`);
    const file = (await res.json()) as NameFile;
    if (!Array.isArray(file.pairs)) throw new Error(`names/${lang}.json no tiene el formato esperado`);
    const value: CachedNames = { pairs: file.pairs, builtAt: file.builtAt, version };
    await db.kv.put({ key, value, updatedAt: Date.now() });
    return value;
  } catch (e) {
    if (cached) return cached;
    console.warn('[names]', e);
    return null;
  }
}

export interface NameIndexBuild {
  index: NameIndex;
  /** Fecha (YYYY-MM-DD) del archivo estático de cada idioma cargado. */
  builtAt: Record<string, string>;
  /** Idiomas pedidos para los que no hubo archivo. */
  missing: string[];
}

/** Construye el índice: inglés + los idiomas pedidos (archivo estático + deltas ya guardados). */
export async function buildNameIndex(
  langs: string[],
  onStatus?: (s: string) => void,
  force = false,
): Promise<NameIndexBuild> {
  onStatus?.('Cargando catálogo de nombres…');
  const english = await fetchCardNames(force);
  const index = new NameIndex(english);
  const builtAt: Record<string, string> = {};
  const missing: string[] = [];
  for (const lang of langs) {
    if (lang === 'en') continue;
    onStatus?.(`Cargando nombres en ${lang.toUpperCase()}…`);
    const data = await loadStaticNames(lang, force);
    if (data) {
      index.addPairs(data.pairs, lang);
      builtAt[lang] = data.builtAt;
    } else {
      missing.push(lang);
    }
    const deltas = await db.kv.where('key').startsWith(`names-delta:${lang}:`).toArray();
    for (const d of deltas) index.addPairs((d.value as CachedDelta).pairs, lang);
  }
  return { index, builtAt, missing };
}

async function fetchSetPairs(set: string, lang: string): Promise<NamePair[]> {
  const out = new Map<string, NamePair>();
  let url: string | undefined = `/cards/search?q=${encodeURIComponent(`set:${set} lang:${lang}`)}&unique=prints`;
  try {
    while (url) {
      const page: ScryfallList<ScryfallCard> = await api(url);
      for (const c of page.data) for (const p of pairsOfCard(c)) out.set(`${p[0]}\u0000${p[1]}`, p);
      url = page.has_more ? page.next_page : undefined;
    }
  } catch (e) {
    // 404 = ese set no tiene cartas en ese idioma (todavía).
    if (e instanceof ScryfallError && e.status === 404) return [];
    throw e;
  }
  return [...out.values()];
}

/**
 * Completa el índice con los sets publicados desde que se generaron los archivos de nombres
 * (y los que están por salir). Guarda cada set en IndexedDB para no volver a bajarlo.
 */
export async function updateRecentSetNames(
  index: NameIndex,
  langs: string[],
  builtAt: Record<string, string>,
): Promise<{ added: number; sets: string[] }> {
  const sets = await fetchSets();
  let added = 0;
  const touched: string[] = [];
  for (const lang of langs) {
    const base = builtAt[lang];
    if (lang === 'en' || !base) continue;
    const cutoff = new Date(new Date(base).getTime() - DELTA_WINDOW_DAYS * 86400e3).toISOString().slice(0, 10);
    const recent = [...sets.values()]
      .filter(
        (s) =>
          s.releasedAt != null &&
          s.releasedAt >= cutoff &&
          s.cardCount > 0 &&
          !s.digital &&
          !SKIP_SET_TYPES.has(s.setType),
      )
      .sort((a, b) => (a.releasedAt! < b.releasedAt! ? 1 : -1))
      .slice(0, MAX_DELTA_SETS);
    for (const s of recent) {
      const key = `names-delta:${lang}:${s.code}`;
      const row = await db.kv.get(key);
      const age = row ? Date.now() - row.updatedAt : Number.POSITIVE_INFINITY;
      const releasedDaysAgo = (Date.now() - new Date(s.releasedAt!).getTime()) / 86400e3;
      // Los sets recién salidos van ganando idiomas en Scryfall durante semanas: se revisan cada
      // pocos días; los que ya tienen más de mes y medio se dan por completos.
      if (row && (age < DELTA_TTL || releasedDaysAgo > 45)) continue;
      const pairs = await fetchSetPairs(s.code, lang);
      await db.kv.put({ key, value: { pairs } satisfies CachedDelta, updatedAt: Date.now() });
      added += index.addPairs(pairs, lang);
      touched.push(s.code);
    }
  }
  return { added, sets: touched };
}
