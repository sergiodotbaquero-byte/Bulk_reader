import type { InventoryItem, ScryfallCard } from '../types';
import type { AddState } from '../components/AddControls';
import { addToInventory } from './inventory';
import { getCardBySetNumber } from './scryfall';

/**
 * Agrega una carta respetando el idioma elegido: si no es inglés, busca la impresión
 * en ese idioma (misma edición y número) para guardar el nombre impreso; el precio
 * se toma siempre de la versión en inglés porque Scryfall no cotiza las demás.
 */
export async function addCard(card: ScryfallCard, a: AddState): Promise<{ item: InventoryItem; created: boolean }> {
  let target = card;
  if (a.lang !== 'en' && card.lang !== a.lang) {
    try {
      target = await getCardBySetNumber(card.set, card.collector_number, a.lang);
    } catch {
      // Scryfall no tiene esa impresión en ese idioma: se guarda la inglesa marcada con el idioma.
    }
  }
  return addToInventory(target, {
    finish: a.finish,
    condition: a.condition,
    lang: a.lang,
    quantity: a.quantity,
    priceCard: card.lang === 'en' ? card : undefined,
  });
}
