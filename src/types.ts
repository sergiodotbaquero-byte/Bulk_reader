export type Finish = 'nonfoil' | 'foil' | 'etched';
export type Condition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';

export const CONDITIONS: Condition[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];
export const CONDITION_LABEL: Record<Condition, string> = {
  NM: 'Near Mint',
  LP: 'Lightly Played',
  MP: 'Moderately Played',
  HP: 'Heavily Played',
  DMG: 'Damaged',
};
export const FINISH_LABEL: Record<Finish, string> = { nonfoil: 'Normal', foil: 'Foil', etched: 'Etched' };

export const LANGS: { code: string; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'es', label: 'ES' },
  { code: 'pt', label: 'PT' },
  { code: 'fr', label: 'FR' },
  { code: 'de', label: 'DE' },
  { code: 'it', label: 'IT' },
  { code: 'ja', label: 'JA' },
  { code: 'ko', label: 'KO' },
  { code: 'ru', label: 'RU' },
  { code: 'zhs', label: 'ZHS' },
  { code: 'zht', label: 'ZHT' },
];

export interface ScryfallImageUris {
  small: string;
  normal: string;
  large: string;
  png: string;
  art_crop: string;
  border_crop: string;
}

export interface ScryfallCardFace {
  name: string;
  printed_name?: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  image_uris?: ScryfallImageUris;
}

export interface ScryfallPrices {
  usd: string | null;
  usd_foil: string | null;
  usd_etched: string | null;
  eur: string | null;
  eur_foil: string | null;
  tix: string | null;
}

export interface ScryfallCard {
  object: 'card';
  id: string;
  oracle_id?: string;
  name: string;
  printed_name?: string;
  lang: string;
  released_at: string;
  layout: string;
  set: string;
  set_name: string;
  set_type?: string;
  collector_number: string;
  rarity: string;
  type_line?: string;
  mana_cost?: string;
  colors?: string[];
  color_identity?: string[];
  image_uris?: ScryfallImageUris;
  card_faces?: ScryfallCardFace[];
  finishes?: Finish[];
  foil?: boolean;
  nonfoil?: boolean;
  promo?: boolean;
  digital?: boolean;
  prices: ScryfallPrices;
  prints_search_uri: string;
  scryfall_uri: string;
}

export interface ScryfallList<T> {
  object: 'list';
  total_cards?: number;
  has_more: boolean;
  next_page?: string;
  data: T[];
}

export interface ScryfallSet {
  object: 'set';
  id: string;
  code: string;
  name: string;
  set_type: string;
  released_at?: string;
  card_count: number;
  printed_size?: number;
  digital: boolean;
  icon_svg_uri: string;
}

/** Una fila del inventario: una carta concreta (impresión) con acabado, estado e idioma. */
export interface InventoryItem {
  id?: number;
  scryfallId: string;
  oracleId: string;
  name: string;
  printedName: string | null;
  setCode: string;
  setName: string;
  collectorNumber: string;
  rarity: string;
  lang: string;
  finish: Finish;
  condition: Condition;
  quantity: number;
  priceUsd: number | null;
  priceEur: number | null;
  imageSmall: string | null;
  imageNormal: string | null;
  releasedAt: string;
  typeLine: string;
  colors: string;
  scryfallUri: string;
  notes: string;
  addedAt: number;
  updatedAt: number;
}

/** Historial de movimientos (para deshacer y para ver el ritmo de escaneo). */
export interface ScanEvent {
  id?: number;
  at: number;
  itemId: number;
  name: string;
  setCode: string;
  collectorNumber: string;
  finish: Finish;
  condition: Condition;
  lang: string;
  delta: number;
}
