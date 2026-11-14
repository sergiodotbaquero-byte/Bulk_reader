import Dexie, { type EntityTable, type Table } from 'dexie';
import type { InventoryItem, ScanEvent, ScryfallCard } from '../types';

export interface CachedCard {
  id: string;
  card: ScryfallCard;
  fetchedAt: number;
}

export interface CachedPrints {
  oracleId: string;
  cards: ScryfallCard[];
  fetchedAt: number;
}

export interface KV {
  key: string;
  value: unknown;
  updatedAt: number;
}

export class ScannerDB extends Dexie {
  inventory!: EntityTable<InventoryItem, 'id'>;
  scans!: EntityTable<ScanEvent, 'id'>;
  cardCache!: Table<CachedCard, string>;
  printsCache!: Table<CachedPrints, string>;
  kv!: Table<KV, string>;

  constructor() {
    super('mtg-bulk-scanner');
    this.version(1).stores({
      inventory: '++id, scryfallId, oracleId, name, setCode, updatedAt, addedAt, [scryfallId+finish+condition+lang]',
      scans: '++id, at, itemId',
      cardCache: 'id, fetchedAt',
      printsCache: 'oracleId, fetchedAt',
      kv: 'key',
    });
  }
}

export const db = new ScannerDB();
