import { useSyncExternalStore } from 'react';
import type { InventoryItem } from '../types';
import { supabase } from './supabaseClient';

/** Fila tal como vive en la tabla `inventory_items` de Supabase (snake_case). */
interface Row {
  id: number;
  scryfall_id: string;
  oracle_id: string;
  name: string;
  printed_name: string | null;
  set_code: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  lang: string;
  finish: string;
  condition: string;
  quantity: number;
  price_usd: string | number | null;
  price_eur: string | number | null;
  image_small: string | null;
  image_normal: string | null;
  released_at: string;
  type_line: string;
  colors: string;
  scryfall_uri: string;
  notes: string;
  added_at: number;
  updated_at: number;
}

function num(v: string | number | null): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function rowToItem(row: Row): InventoryItem {
  return {
    id: row.id,
    scryfallId: row.scryfall_id,
    oracleId: row.oracle_id,
    name: row.name,
    printedName: row.printed_name,
    setCode: row.set_code,
    setName: row.set_name,
    collectorNumber: row.collector_number,
    rarity: row.rarity,
    lang: row.lang,
    finish: row.finish as InventoryItem['finish'],
    condition: row.condition as InventoryItem['condition'],
    quantity: row.quantity,
    priceUsd: num(row.price_usd),
    priceEur: num(row.price_eur),
    imageSmall: row.image_small,
    imageNormal: row.image_normal,
    releasedAt: row.released_at,
    typeLine: row.type_line,
    colors: row.colors,
    scryfallUri: row.scryfall_uri,
    notes: row.notes,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  };
}

/** Misma fila pero para insert/update (sin `id`, que lo pone la base). */
export function itemToRow(item: InventoryItem): Omit<Row, 'id'> {
  return {
    scryfall_id: item.scryfallId,
    oracle_id: item.oracleId,
    name: item.name,
    printed_name: item.printedName,
    set_code: item.setCode,
    set_name: item.setName,
    collector_number: item.collectorNumber,
    rarity: item.rarity,
    lang: item.lang,
    finish: item.finish,
    condition: item.condition,
    quantity: item.quantity,
    price_usd: item.priceUsd,
    price_eur: item.priceEur,
    image_small: item.imageSmall,
    image_normal: item.imageNormal,
    released_at: item.releasedAt,
    type_line: item.typeLine,
    colors: item.colors,
    scryfall_uri: item.scryfallUri,
    notes: item.notes,
    added_at: item.addedAt,
    updated_at: item.updatedAt,
  };
}

let items: InventoryItem[] = [];
let loaded = false;
let loadError: string | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export async function refreshInventory(): Promise<void> {
  const { data, error } = await supabase
    .from('inventory_items')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) {
    loadError = error.message;
  } else {
    items = (data as Row[]).map(rowToItem);
    loadError = null;
  }
  loaded = true;
  notify();
}

let started = false;
function ensureStarted() {
  if (started) return;
  started = true;
  void refreshInventory();
  supabase
    .channel('inventory_items_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_items' }, () => {
      void refreshInventory();
    })
    .subscribe();
}

function subscribe(listener: () => void): () => void {
  ensureStarted();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `undefined` mientras carga (como antes con useLiveQuery), o la lista (puede estar vacía). */
export function useInventoryItems(): InventoryItem[] | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (loaded ? items : undefined),
    () => (loaded ? items : undefined),
  );
}

export function useInventoryLoadError(): string | null {
  return useSyncExternalStore(subscribe, () => loadError, () => loadError);
}

export function getInventorySnapshot(): InventoryItem[] {
  return items;
}

export function getItemById(id: number): InventoryItem | undefined {
  return items.find((i) => i.id === id);
}
