import type { Condition, Finish, InventoryItem } from '../types';
import { db } from './db';

const MANABOX_HEADER = [
  'Name',
  'Set code',
  'Set name',
  'Collector number',
  'Foil',
  'Rarity',
  'Quantity',
  'ManaBox ID',
  'Scryfall ID',
  'Purchase price',
  'Misprint',
  'Altered',
  'Condition',
  'Language',
  'Purchase price currency',
];

const CONDITION_MANABOX: Record<Condition, string> = {
  NM: 'near_mint',
  LP: 'lightly_played',
  MP: 'moderately_played',
  HP: 'heavily_played',
  DMG: 'damaged',
};

const FOIL_MANABOX: Record<Finish, string> = { nonfoil: 'normal', foil: 'foil', etched: 'etched' };

function cell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rows(lines: unknown[][]): string {
  return lines.map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** CSV con el formato que importa ManaBox. */
export function toManaBoxCsv(items: InventoryItem[]): string {
  const body = items.map((i) => [
    i.name,
    i.setCode.toUpperCase(),
    i.setName,
    i.collectorNumber,
    FOIL_MANABOX[i.finish],
    i.rarity,
    i.quantity,
    '',
    i.scryfallId,
    i.priceUsd ?? '',
    'false',
    'false',
    CONDITION_MANABOX[i.condition],
    i.lang,
    'USD',
  ]);
  return rows([MANABOX_HEADER, ...body]);
}

/** CSV legible en Excel / Sheets (con BOM para que respete los acentos). */
export function toSimpleCsv(items: InventoryItem[]): string {
  const header = [
    'Nombre',
    'Nombre impreso',
    'Set',
    'Código set',
    'Número',
    'Rareza',
    'Acabado',
    'Estado',
    'Idioma',
    'Cantidad',
    'Precio USD',
    'Total USD',
    'Tipo',
    'Scryfall ID',
    'Agregada',
  ];
  const body = items.map((i) => [
    i.name,
    i.printedName ?? '',
    i.setName,
    i.setCode.toUpperCase(),
    i.collectorNumber,
    i.rarity,
    i.finish,
    i.condition,
    i.lang,
    i.quantity,
    i.priceUsd ?? '',
    i.priceUsd != null ? (i.priceUsd * i.quantity).toFixed(2) : '',
    i.typeLine,
    i.scryfallId,
    new Date(i.addedAt).toISOString(),
  ]);
  return '﻿' + rows([header, ...body]);
}

export interface Backup {
  app: 'mtg-bulk-scanner';
  version: 1;
  exportedAt: string;
  items: InventoryItem[];
}

export function toJsonBackup(items: InventoryItem[]): string {
  const backup: Backup = { app: 'mtg-bulk-scanner', version: 1, exportedAt: new Date().toISOString(), items };
  return JSON.stringify(backup, null, 2);
}

/** Importa un respaldo JSON sumando cantidades a lo que ya existe. */
export async function importJsonBackup(text: string): Promise<{ added: number; merged: number }> {
  const parsed = JSON.parse(text) as Partial<Backup> | InventoryItem[];
  const items = Array.isArray(parsed) ? parsed : parsed.items;
  if (!Array.isArray(items)) throw new Error('El archivo no tiene el formato de respaldo esperado.');
  let added = 0;
  let merged = 0;
  await db.transaction('rw', db.inventory, async () => {
    for (const raw of items) {
      if (!raw || typeof raw.scryfallId !== 'string' || typeof raw.quantity !== 'number') continue;
      const { id: _id, ...item } = raw;
      void _id;
      const twin = await db.inventory
        .where('[scryfallId+finish+condition+lang]')
        .equals([item.scryfallId, item.finish, item.condition, item.lang])
        .first();
      if (twin) {
        await db.inventory.update(twin.id!, { quantity: twin.quantity + item.quantity, updatedAt: Date.now() });
        merged++;
      } else {
        await db.inventory.add({ ...item, notes: item.notes ?? '', updatedAt: Date.now() });
        added++;
      }
    }
  });
  return { added, merged };
}

/** Comparte el archivo (Android/iOS) o lo descarga (escritorio). */
export async function saveOrShare(filename: string, content: string, mime: string): Promise<'shared' | 'downloaded'> {
  const blob = new Blob([content], { type: mime });
  const file = new File([blob], filename, { type: mime });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'shared';
      // si el share falla, cae a descarga
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

export function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
