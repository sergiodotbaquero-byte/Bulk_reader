import { useSyncExternalStore } from 'react';
import type { Condition, Finish } from '../types';

export interface Settings {
  defaultCondition: Condition;
  defaultFinish: Finish;
  defaultLang: string;
  /** Agregar la carta al inventario apenas se reconozca (modo ManaBox). */
  autoAdd: boolean;
  /** En modo automático, agregar aunque no se haya podido leer la edición (usa la impresión más reciente). */
  autoAddUnconfirmed: boolean;
  sound: boolean;
  vibrate: boolean;
  /** Leer también el número de coleccionista y el código del set (esquina inferior izquierda). */
  readCollectorCode: boolean;
  /** Ancho del marco de la carta como fracción del ancho de la cámara. */
  frameScale: number;
  currency: 'usd' | 'eur';
  showOcrDebug: boolean;
  /** Idiomas (además del inglés) cuyos nombres impresos se cargan para reconocer la carta. */
  nameLangs: string[];
  /** Zoom de la cámara elegido la última vez (si la cámara lo permite). */
  cameraZoom: number | null;
  /** Resolución pedida a la cámara: 1080p (ligera) o 4K (más detalle para la esquina del número). */
  cameraRes: '1080p' | '4k';
}

export const DEFAULT_SETTINGS: Settings = {
  defaultCondition: 'NM',
  defaultFinish: 'nonfoil',
  defaultLang: 'en',
  autoAdd: false,
  autoAddUnconfirmed: false,
  sound: true,
  vibrate: true,
  readCollectorCode: true,
  frameScale: 0.84,
  currency: 'usd',
  showOcrDebug: false,
  nameLangs: ['es', 'pt'],
  cameraZoom: null,
  cameraRes: '1080p',
};

const KEY = 'mtg-scanner.settings.v1';
const listeners = new Set<() => void>();
let current: Settings = load();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // sin almacenamiento disponible: los ajustes viven solo en memoria
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const s = useSyncExternalStore(subscribe, getSettings, getSettings);
  return [s, updateSettings];
}
