import type { Condition, Finish, InventoryItem, ScryfallCard } from '../types';
import { cardImage, unitPrice } from './scryfall';
import { supabase } from './supabaseClient';
import { getItemById, itemToRow, refreshInventory, rowToItem } from './inventoryStore';

export interface AddOptions {
  finish: Finish;
  condition: Condition;
  lang: string;
  quantity: number;
  /** Carta de la que tomar el precio (las impresiones en otros idiomas no traen precio en Scryfall). */
  priceCard?: ScryfallCard;
}

export function buildItem(card: ScryfallCard, o: AddOptions, now = Date.now()): InventoryItem {
  const priceSrc = o.priceCard ?? card;
  return {
    scryfallId: card.id,
    oracleId: card.oracle_id ?? '',
    name: card.name,
    printedName: card.printed_name ?? null,
    setCode: card.set,
    setName: card.set_name,
    collectorNumber: card.collector_number,
    rarity: card.rarity,
    lang: o.lang,
    finish: o.finish,
    condition: o.condition,
    quantity: o.quantity,
    priceUsd: unitPrice(priceSrc, o.finish, 'usd'),
    priceEur: unitPrice(priceSrc, o.finish, 'eur'),
    imageSmall: cardImage(card, 'small'),
    imageNormal: cardImage(card, 'normal'),
    releasedAt: card.released_at,
    typeLine: card.type_line ?? card.card_faces?.map((f) => f.type_line ?? '').join(' // ') ?? '',
    colors: (card.colors ?? card.color_identity ?? []).join(''),
    scryfallUri: card.scryfall_uri,
    notes: '',
    addedAt: now,
    updatedAt: now,
  };
}

async function findTwin(key: { scryfallId: string; finish: Finish; condition: Condition; lang: string }, excludeId?: number) {
  let q = supabase
    .from('inventory_items')
    .select('*')
    .eq('scryfall_id', key.scryfallId)
    .eq('finish', key.finish)
    .eq('condition', key.condition)
    .eq('lang', key.lang);
  if (excludeId != null) q = q.neq('id', excludeId);
  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return data ? rowToItem(data) : null;
}

async function fetchItem(id: number): Promise<InventoryItem | null> {
  const local = getItemById(id);
  if (local) return local;
  const { data, error } = await supabase.from('inventory_items').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? rowToItem(data) : null;
}

async function logScan(item: InventoryItem, delta: number, at: number) {
  if (item.id == null) return;
  const { error } = await supabase.from('scan_events').insert({
    at,
    item_id: item.id,
    name: item.name,
    set_code: item.setCode,
    collector_number: item.collectorNumber,
    finish: item.finish,
    condition: item.condition,
    lang: item.lang,
    delta,
  });
  if (error) throw error;
}

/** Suma `o.quantity` copias; si ya existe la misma impresión+acabado+estado+idioma, incrementa. */
export async function addToInventory(
  card: ScryfallCard,
  o: AddOptions,
): Promise<{ item: InventoryItem; created: boolean }> {
  const now = Date.now();
  const fresh = buildItem(card, o, now);
  const existing = await findTwin(fresh);
  let item: InventoryItem;
  let created = false;
  if (existing) {
    const quantity = existing.quantity + o.quantity;
    const priceUsd = fresh.priceUsd ?? existing.priceUsd;
    const priceEur = fresh.priceEur ?? existing.priceEur;
    const { data, error } = await supabase
      .from('inventory_items')
      .update({ quantity, price_usd: priceUsd, price_eur: priceEur, updated_at: now })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    item = rowToItem(data);
  } else {
    const { data, error } = await supabase.from('inventory_items').insert(itemToRow(fresh)).select().single();
    if (error) throw error;
    item = rowToItem(data);
    created = true;
  }
  await logScan(item, o.quantity, now);
  await refreshInventory();
  return { item, created };
}

export async function changeQuantity(id: number, delta: number): Promise<InventoryItem | null> {
  const item = await fetchItem(id);
  if (!item) return null;
  const now = Date.now();
  const quantity = Math.max(0, item.quantity + delta);
  const applied = quantity - item.quantity;
  if (applied === 0) return item;
  if (quantity === 0) {
    const { error } = await supabase.from('inventory_items').delete().eq('id', id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('inventory_items').update({ quantity, updated_at: now }).eq('id', id);
    if (error) throw error;
  }
  await logScan(item, applied, now);
  await refreshInventory();
  return { ...item, quantity, updatedAt: now };
}

/** Cambia acabado/estado/idioma/notas. Si el cambio choca con otra fila igual, las fusiona. */
export async function updateItem(
  id: number,
  patch: Partial<Pick<InventoryItem, 'finish' | 'condition' | 'lang' | 'notes' | 'quantity'>>,
): Promise<void> {
  const item = await fetchItem(id);
  if (!item) return;
  const now = Date.now();
  const next: InventoryItem = { ...item, ...patch, updatedAt: now };
  if (next.quantity <= 0) {
    const { error } = await supabase.from('inventory_items').delete().eq('id', id);
    if (error) throw error;
    await logScan(item, -item.quantity, now);
    await refreshInventory();
    return;
  }
  const twin = await findTwin(next, id);
  if (twin) {
    const { error: upErr } = await supabase
      .from('inventory_items')
      .update({ quantity: twin.quantity + next.quantity, updated_at: now })
      .eq('id', twin.id);
    if (upErr) throw upErr;
    const { error: delErr } = await supabase.from('inventory_items').delete().eq('id', id);
    if (delErr) throw delErr;
  } else {
    const { error } = await supabase.from('inventory_items').update(itemToRow(next)).eq('id', id);
    if (error) throw error;
  }
  await refreshInventory();
}

export async function removeItem(id: number): Promise<void> {
  const item = await fetchItem(id);
  if (!item) return;
  const { error } = await supabase.from('inventory_items').delete().eq('id', id);
  if (error) throw error;
  await logScan(item, -item.quantity, Date.now());
  await refreshInventory();
}

/** Revierte el último movimiento registrado (p. ej. un escaneo accidental). */
export async function undoLastScan(): Promise<string | null> {
  const { data: last, error } = await supabase
    .from('scan_events')
    .select('*')
    .order('at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!last) return null;
  const item = await fetchItem(last.item_id);
  if (item) {
    const quantity = item.quantity - last.delta;
    if (quantity <= 0) {
      const { error: delErr } = await supabase.from('inventory_items').delete().eq('id', item.id);
      if (delErr) throw delErr;
    } else {
      const { error: upErr } = await supabase
        .from('inventory_items')
        .update({ quantity, updated_at: Date.now() })
        .eq('id', item.id);
      if (upErr) throw upErr;
    }
  }
  const { error: delScanErr } = await supabase.from('scan_events').delete().eq('id', last.id);
  if (delScanErr) throw delScanErr;
  await refreshInventory();
  return `${last.name} (${String(last.set_code).toUpperCase()} #${last.collector_number}) ×${last.delta}`;
}

export async function clearInventory(): Promise<void> {
  const { error } = await supabase.from('inventory_items').delete().gte('id', 0);
  if (error) throw error;
  const { error: scanErr } = await supabase.from('scan_events').delete().gte('id', 0);
  if (scanErr) throw scanErr;
  await refreshInventory();
}

export interface Totals {
  rows: number;
  cards: number;
  valueUsd: number;
  valueEur: number;
  priced: number;
}

export function totals(items: InventoryItem[]): Totals {
  const t: Totals = { rows: items.length, cards: 0, valueUsd: 0, valueEur: 0, priced: 0 };
  for (const i of items) {
    t.cards += i.quantity;
    if (i.priceUsd != null) {
      t.valueUsd += i.priceUsd * i.quantity;
      t.priced += i.quantity;
    }
    if (i.priceEur != null) t.valueEur += i.priceEur * i.quantity;
  }
  return t;
}
