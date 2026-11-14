import type { Finish, ScryfallCard, ScryfallList, ScryfallSet } from '../types';
import { ocrDistance, setCodeVariants } from './collector';
import { db } from './db';

const API = 'https://api.scryfall.com';
/** Scryfall pide 50-100 ms entre peticiones; dejamos un poco más de margen. */
const MIN_GAP_MS = 110;
const CARD_TTL = 24 * 3600e3;
const PRINTS_TTL = 12 * 3600e3;
const CATALOG_TTL = 24 * 3600e3;

export class ScryfallError extends Error {
  status: number;
  code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ScryfallError';
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  };
  const p = queue.then(run, run);
  queue = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

interface ScryfallErrorBody {
  object: 'error';
  code: string;
  status: number;
  details: string;
}

export async function api<T>(pathOrUrl: string): Promise<T> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
  return throttled(async () => {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = body as ScryfallErrorBody | null;
      throw new ScryfallError(res.status, err?.details ?? `Scryfall respondió ${res.status}`, err?.code);
    }
    return body as T;
  });
}

async function kvGet<T>(key: string, ttl: number): Promise<{ value: T; fresh: boolean } | null> {
  const row = await db.kv.get(key);
  if (!row) return null;
  return { value: row.value as T, fresh: Date.now() - row.updatedAt < ttl };
}

/** Todos los nombres de cartas en inglés (≈35k, ~1 MB). Se guarda en IndexedDB y se refresca a diario. */
export async function fetchCardNames(force = false): Promise<string[]> {
  const cached = await kvGet<string[]>('card-names', CATALOG_TTL);
  if (cached?.fresh && !force) return cached.value;
  try {
    const res = await api<{ data: string[] }>('/catalog/card-names');
    await db.kv.put({ key: 'card-names', value: res.data, updatedAt: Date.now() });
    return res.data;
  } catch (e) {
    if (cached) return cached.value;
    throw e;
  }
}

export interface SetInfo {
  code: string;
  name: string;
  setType: string;
  cardCount: number;
  printedSize: number | null;
  releasedAt: string | null;
  digital: boolean;
}

/** Lista de sets (para cruzar el "123/274" impreso con el tamaño del set). */
export async function fetchSets(): Promise<Map<string, SetInfo>> {
  const cached = await kvGet<SetInfo[]>('sets:2', CATALOG_TTL);
  let list = cached?.value;
  if (!cached?.fresh) {
    try {
      const res = await api<ScryfallList<ScryfallSet>>('/sets');
      list = res.data.map((s) => ({
        code: s.code,
        name: s.name,
        setType: s.set_type,
        cardCount: s.card_count,
        printedSize: s.printed_size ?? null,
        releasedAt: s.released_at ?? null,
        digital: Boolean(s.digital),
      }));
      await db.kv.put({ key: 'sets:2', value: list, updatedAt: Date.now() });
    } catch (e) {
      if (!list) throw e;
    }
  }
  return new Map((list ?? []).map((s) => [s.code, s]));
}

async function cacheCard(card: ScryfallCard): Promise<void> {
  await db.cardCache.put({ id: card.id, card, fetchedAt: Date.now() });
}

export async function getCardById(id: string): Promise<ScryfallCard> {
  const c = await db.cardCache.get(id);
  if (c && Date.now() - c.fetchedAt < CARD_TTL) return c.card;
  const card = await api<ScryfallCard>(`/cards/${encodeURIComponent(id)}`);
  await cacheCard(card);
  return card;
}

export async function getCardByExactName(name: string): Promise<ScryfallCard> {
  const card = await api<ScryfallCard>(`/cards/named?exact=${encodeURIComponent(name)}`);
  await cacheCard(card);
  return card;
}

export async function getCardBySetNumber(set: string, number: string, lang?: string): Promise<ScryfallCard> {
  let path = `/cards/${encodeURIComponent(set.toLowerCase())}/${encodeURIComponent(number.toLowerCase())}`;
  if (lang && lang !== 'en') path += `/${encodeURIComponent(lang)}`;
  const card = await api<ScryfallCard>(path);
  await cacheCard(card);
  return card;
}

/** Todas las impresiones (en inglés, sin digitales) de la misma carta, de la más nueva a la más vieja. */
export async function getPrintings(card: ScryfallCard): Promise<ScryfallCard[]> {
  const key = card.oracle_id ?? card.id;
  const cached = await db.printsCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PRINTS_TTL) return cached.cards;
  const out: ScryfallCard[] = [];
  let url: string | undefined = card.prints_search_uri;
  while (url && out.length < 600) {
    const page: ScryfallList<ScryfallCard> = await api(url);
    out.push(...page.data);
    url = page.has_more ? page.next_page : undefined;
  }
  const cards = out.filter((c) => !c.digital);
  if (!card.digital && !cards.some((c) => c.id === card.id)) cards.unshift(card);
  await db.printsCache.put({ oracleId: key, cards, fetchedAt: Date.now() });
  return cards;
}

export async function autocompleteNames(q: string): Promise<string[]> {
  if (q.trim().length < 2) return [];
  const res = await api<{ data: string[] }>(`/cards/autocomplete?q=${encodeURIComponent(q.trim())}`);
  return res.data;
}

export async function searchCards(query: string): Promise<ScryfallCard[]> {
  try {
    const res = await api<ScryfallList<ScryfallCard>>(
      `/cards/search?q=${encodeURIComponent(query)}&unique=prints&order=released`,
    );
    return res.data.filter((c) => !c.digital);
  } catch (e) {
    if (e instanceof ScryfallError && e.status === 404) return [];
    throw e;
  }
}

/**
 * Códigos de set REALES parecidos a lo que leyó el OCR, del más probable al menos. Mirar la lista
 * de sets de Scryfall evita gastar peticiones en códigos que no existen ("dex") y permite llegar
 * al que sí existe ("dsk") aunque el OCR se haya comido dos letras.
 *
 * `maxDistance` 1 es casi seguro; 2 solo vale si algo más (el nombre de la carta, el número o la
 * rareza) respalda la lectura, porque a esa distancia puede haber varios sets candidatos.
 */
export async function setCodeCandidates(raw: string, maxDistance = 2, limit = 5): Promise<string[]> {
  const code = raw.trim().toLowerCase();
  if (!code) return [];
  let sets: Map<string, SetInfo>;
  try {
    sets = await fetchSets();
  } catch {
    // Sin conexión (o Scryfall caído): se vuelve a las variantes a ciegas.
    return setCodeVariants(code);
  }
  if (sets.has(code)) {
    const exact = [code];
    for (const v of setCodeVariants(code)) if (v !== code && sets.has(v)) exact.push(v);
    return exact.slice(0, limit);
  }
  const today = new Date().toISOString().slice(0, 10);
  const scored: { code: string; d: number; released: string }[] = [];
  for (const s of sets.values()) {
    // Los sets digitales no existen en papel y los que aún no salieron no pueden estar en la mano.
    if (s.digital || (s.releasedAt != null && s.releasedAt > today)) continue;
    if (Math.abs(s.code.length - code.length) > 1) continue;
    const d = ocrDistance(code, s.code);
    if (d <= maxDistance) scored.push({ code: s.code, d, released: s.releasedAt ?? '' });
  }
  // A igual distancia, primero el set más reciente (hay muchas más cartas en circulación).
  scored.sort((a, b) => a.d - b.d || (a.released < b.released ? 1 : -1));
  return scored.slice(0, limit).map((s) => s.code);
}

export function cardImage(card: ScryfallCard, size: 'small' | 'normal' | 'large' = 'normal'): string | null {
  return card.image_uris?.[size] ?? card.card_faces?.[0]?.image_uris?.[size] ?? null;
}

export function availableFinishes(card: ScryfallCard): Finish[] {
  if (card.finishes && card.finishes.length) return card.finishes;
  const f: Finish[] = [];
  if (card.nonfoil !== false) f.push('nonfoil');
  if (card.foil) f.push('foil');
  return f.length ? f : ['nonfoil'];
}

export function unitPrice(card: ScryfallCard, finish: Finish, currency: 'usd' | 'eur' = 'usd'): number | null {
  const p = card.prices;
  if (!p) return null;
  let raw: string | null | undefined;
  if (currency === 'usd') raw = finish === 'foil' ? p.usd_foil : finish === 'etched' ? p.usd_etched : p.usd;
  else raw = finish === 'nonfoil' ? p.eur : p.eur_foil;
  const n = raw == null ? NaN : parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** Nombres con los que puede aparecer impresa la carta (incluye caras de cartas dobles / divididas). */
export function cardFaceNames(card: ScryfallCard): string[] {
  const names = [card.name];
  if (card.card_faces) for (const f of card.card_faces) names.push(f.name);
  if (card.name.includes(' // ')) names.push(...card.name.split(' // '));
  return names;
}

export function displayName(card: ScryfallCard): string {
  const printed = printedName(card);
  return printed && card.lang !== 'en' && printed !== card.name ? `${printed} (${card.name})` : card.name;
}

/** Nombre impreso (en cartas dobles viene por cara). */
export function printedName(card: ScryfallCard): string | null {
  if (card.printed_name) return card.printed_name;
  const faces = card.card_faces?.map((f) => f.printed_name).filter((n): n is string => Boolean(n));
  return faces?.length ? faces.join(' // ') : null;
}

/** Nombres (inglés e impresos) con los que puede aparecer la carta, para cotejar con el OCR. */
export function allCardNames(card: ScryfallCard): string[] {
  const names = cardFaceNames(card);
  if (card.printed_name) names.push(card.printed_name);
  if (card.card_faces) for (const f of card.card_faces) if (f.printed_name) names.push(f.printed_name);
  return names;
}
