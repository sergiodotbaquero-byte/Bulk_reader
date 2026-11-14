import { db } from './db';
import { importJsonBackup } from './export';

const FLAG = 'mtg-scanner.migrated-to-supabase.v1';

/**
 * Antes de este cambio el inventario vivía solo en IndexedDB (por dispositivo). Esta
 * migración de una sola vez sube lo que haya ahí a Supabase (sumando cantidades si ya
 * existe) y no borra el respaldo local. Se salta en cuanto corre una vez, con o sin datos.
 */
export async function migrateLocalInventory(): Promise<void> {
  if (localStorage.getItem(FLAG)) return;
  try {
    const items = await db.inventory.toArray();
    if (items.length) {
      await importJsonBackup(JSON.stringify({ app: 'mtg-bulk-scanner', version: 1, items }));
    }
  } catch {
    // Sin IndexedDB previa (instalación nueva) o sin red: no hay nada que migrar ahora.
    return;
  }
  localStorage.setItem(FLAG, '1');
}
