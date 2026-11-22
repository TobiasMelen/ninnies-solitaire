import type { Lang } from '../i18n';

/** Card face styles: one big suit symbol, or pips laid out like a real card. Names are in i18n. */
export const DECKS = [
  { id: 'simple' },
  { id: 'pips' },
] as const;

export const BACKS = [
  { id: 'crimson' },
  { id: 'navy' },
  { id: 'forest' },
  { id: 'plum' },
  { id: 'gold' },
] as const;

export const COURTS = [
  { id: 'knoll' },
  { id: 'kennard' },
  { id: 'atlas' },
  { id: 'letters' },
] as const;

export const TABLES = [
  { id: 'felt' },
  { id: 'ocean' },
  { id: 'wine' },
  { id: 'midnight' },
  { id: 'linen' },
] as const;

export interface Settings {
  deck: (typeof DECKS)[number]['id'];
  back: (typeof BACKS)[number]['id'];
  table: (typeof TABLES)[number]['id'];
  courts: (typeof COURTS)[number]['id'];
  /** Easier-to-read cards, with either face style. */
  fourColour: boolean;
  largePrint: boolean;
  noMovesAlert: boolean;
  tapToMove: boolean;
  singleTap: boolean;
  showTargets: boolean;
  dimLocked: boolean;
  dealWithEmpty: boolean;
  sound: boolean;
  haptics: boolean;
  bunny: boolean;
  heartsPassing: boolean;
  heartsShort: boolean;
  heartsMoonSubtract: boolean;
  heartsFast: boolean;
  heartsOneTap: boolean;
  spiteShort: boolean;
  spiteFast: boolean;
  landscaperFarmers: boolean;
  landscaperFast: boolean;
  landscaperRiver: boolean;
  /** 'auto' follows the device's language. */
  lang: 'auto' | Lang;
  /** Skip the setup step when starting that game (the "Remember" box). */
  rememberSpider: boolean;
  rememberHearts: boolean;
  rememberSpite: boolean;
  rememberFreecell: boolean;
  rememberLandscaper: boolean;
}

const KEY = 'ninnies.settings.v1';

const DEFAULTS: Settings = {
  deck: 'simple',
  back: 'crimson',
  table: 'felt',
  courts: 'knoll',
  fourColour: false,
  largePrint: false,
  noMovesAlert: true,
  tapToMove: true,
  singleTap: false,
  showTargets: true,
  dimLocked: true,
  dealWithEmpty: false,
  sound: true,
  haptics: true,
  bunny: true,
  heartsPassing: true,
  heartsShort: false,
  heartsMoonSubtract: false,
  heartsFast: false,
  heartsOneTap: false,
  spiteShort: false,
  spiteFast: false,
  landscaperFarmers: true,
  landscaperFast: false,
  landscaperRiver: true,
  lang: 'auto',
  rememberSpider: false,
  rememberHearts: false,
  rememberSpite: false,
  rememberFreecell: false,
  rememberLandscaper: false,
};

type Listener = (s: Settings) => void;
const listeners = new Set<Listener>();

function load(): Settings {
  try {
    const s: Settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    // A saved choice may point at an option that has since been replaced or removed.
    if ((s.courts as string) === 'english') s.courts = 'kennard';
    if (!COURTS.some((c) => c.id === s.courts)) s.courts = DEFAULTS.courts;
    // The old four-colour and large-print decks are now switches on either face style.
    const deck = s.deck as string;
    if (deck === 'four' || deck === 'bold') s.fourColour = true;
    if (deck === 'bold') s.largePrint = true;
    if (!DECKS.some((d) => d.id === s.deck)) s.deck = DEFAULTS.deck;
    return s;
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
