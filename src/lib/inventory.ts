import type { Condition, Finish, InventoryItem, ScryfallCard } from '../types';
import { db } from './db';
import { cardImage, unitPrice } from './scryfall';

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

function compoundKey(i: { scryfallId: string; finish: Finish; condition: Condition; lang: string }) {
  return [i.scryfallId, i.finish, i.condition, i.lang];
}

async function logScan(item: InventoryItem, delta: number, at: number) {
  if (item.id == null) return;
  await db.scans.add({
    at,
    itemId: item.id,
    name: item.name,
    setCode: item.setCode,
    collectorNumber: item.collectorNumber,
    finish: item.finish,
    condition: item.condition,
    lang: item.lang,
    delta,
  });
}

/** Suma `o.quantity` copias; si ya existe la misma impresión+acabado+estado+idioma, incrementa. */
export async function addToInventory(
  card: ScryfallCard,
  o: AddOptions,
): Promise<{ item: InventoryItem; created: boolean }> {
  return db.transaction('rw', db.inventory, db.scans, async () => {
    const now = Date.now();
    const fresh = buildItem(card, o, now);
    const existing = await db.inventory
      .where('[scryfallId+finish+condition+lang]')
      .equals(compoundKey(fresh))
      .first();
    let item: InventoryItem;
    let created = false;
    if (existing) {
      item = {
        ...existing,
        quantity: existing.quantity + o.quantity,
        priceUsd: fresh.priceUsd ?? existing.priceUsd,
        priceEur: fresh.priceEur ?? existing.priceEur,
        updatedAt: now,
      };
      await db.inventory.put(item);
    } else {
      const id = await db.inventory.add(fresh);
      item = { ...fresh, id: id as number };
      created = true;
    }
    await logScan(item, o.quantity, now);
    return { item, created };
  });
}

export async function changeQuantity(id: number, delta: number): Promise<InventoryItem | null> {
  return db.transaction('rw', db.inventory, db.scans, async () => {
    const item = await db.inventory.get(id);
    if (!item) return null;
    const now = Date.now();
    const quantity = Math.max(0, item.quantity + delta);
    const applied = quantity - item.quantity;
    if (applied === 0) return item;
    if (quantity === 0) {
      await db.inventory.delete(id);
    } else {
      await db.inventory.update(id, { quantity, updatedAt: now });
    }
    await logScan(item, applied, now);
    return { ...item, quantity, updatedAt: now };
  });
}

/** Cambia acabado/estado/idioma/notas. Si el cambio choca con otra fila igual, las fusiona. */
export async function updateItem(
  id: number,
  patch: Partial<Pick<InventoryItem, 'finish' | 'condition' | 'lang' | 'notes' | 'quantity'>>,
): Promise<void> {
  await db.transaction('rw', db.inventory, db.scans, async () => {
    const item = await db.inventory.get(id);
    if (!item) return;
    const now = Date.now();
    const next: InventoryItem = { ...item, ...patch, updatedAt: now };
    if (next.quantity <= 0) {
      await db.inventory.delete(id);
      await logScan(item, -item.quantity, now);
      return;
    }
    const twin = await db.inventory
      .where('[scryfallId+finish+condition+lang]')
      .equals(compoundKey(next))
      .first();
    if (twin && twin.id !== id) {
      await db.inventory.update(twin.id!, { quantity: twin.quantity + next.quantity, updatedAt: now });
      await db.inventory.delete(id);
      return;
    }
    await db.inventory.put(next);
  });
}

export async function removeItem(id: number): Promise<void> {
  await db.transaction('rw', db.inventory, db.scans, async () => {
    const item = await db.inventory.get(id);
    if (!item) return;
    await db.inventory.delete(id);
    await logScan(item, -item.quantity, Date.now());
  });
}

/** Revierte el último movimiento registrado (p. ej. un escaneo accidental). */
export async function undoLastScan(): Promise<string | null> {
  return db.transaction('rw', db.inventory, db.scans, async () => {
    const last = await db.scans.orderBy('at').last();
    if (!last) return null;
    const item = await db.inventory.get(last.itemId);
    if (item) {
      const quantity = item.quantity - last.delta;
      if (quantity <= 0) await db.inventory.delete(item.id!);
      else await db.inventory.update(item.id!, { quantity, updatedAt: Date.now() });
    }
    await db.scans.delete(last.id!);
    return `${last.name} (${last.setCode.toUpperCase()} #${last.collectorNumber}) ×${last.delta}`;
  });
}

export async function clearInventory(): Promise<void> {
  await db.transaction('rw', db.inventory, db.scans, async () => {
    await db.inventory.clear();
    await db.scans.clear();
  });
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
