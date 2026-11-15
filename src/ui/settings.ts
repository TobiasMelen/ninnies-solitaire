export const DECKS = [
  { id: 'classic', label: 'Classic' },
  { id: 'four', label: 'Four colour' },
  { id: 'bold', label: 'Large print' },
  { id: 'night', label: 'Night' },
] as const;

export const BACKS = [
  { id: 'crimson', label: 'Crimson' },
  { id: 'navy', label: 'Navy' },
  { id: 'forest', label: 'Forest' },
  { id: 'plum', label: 'Plum' },
  { id: 'gold', label: 'Gold' },
] as const;

export const TABLES = [
  { id: 'felt', label: 'Green felt' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'wine', label: 'Wine' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'linen', label: 'Linen' },
] as const;

export interface Settings {
  deck: (typeof DECKS)[number]['id'];
  back: (typeof BACKS)[number]['id'];
  table: (typeof TABLES)[number]['id'];
  noMovesAlert: boolean;
  tapToMove: boolean;
  showTargets: boolean;
  sound: boolean;
  haptics: boolean;
}

const KEY = 'ninnies.settings.v1';

const DEFAULTS: Settings = {
  deck: 'classic',
  back: 'crimson',
  table: 'felt',
  noMovesAlert: true,
  tapToMove: true,
  showTargets: true,
  sound: true,
  haptics: true,
};

type Listener = (s: Settings) => void;
const listeners = new Set<Listener>();

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings: Settings = load();

export function updateSettings(patch: Partial<Settings>) {
  Object.assign(settings, patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode: settings just won't persist */
  }
  listeners.forEach((fn) => fn(settings));
}

export function onSettings(fn: Listener) {
  listeners.add(fn);
  fn(settings);
}
