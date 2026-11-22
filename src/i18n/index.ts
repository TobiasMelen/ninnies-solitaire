import en from './en.json';
import sv from './sv.json';

/**
 * Translations. Every piece of text the player sees lives in one JSON file per language
 * (en.json is the reference; other files must have the same keys). Code asks for text with
 * t('key', { name: value }); the page's static text is marked with data-i18n attributes and
 * filled in by translatePage().
 */

export type Key = keyof typeof en;
export const LANGS = { en, sv } satisfies Record<string, Record<Key, string>>;
export type Lang = keyof typeof LANGS;

/** The language the device prefers, if we have it; otherwise English. */
export function deviceLang(): Lang {
  for (const l of navigator.languages ?? [navigator.language]) {
    const base = l.toLowerCase().split('-')[0];
    if (base in LANGS) return base as Lang;
  }
  return 'en';
}

let current: Lang = 'en';
let strings: Record<Key, string> = en;

export function setLang(lang: Lang) {
  current = lang;
  strings = LANGS[lang];
  document.documentElement.lang = lang;
}

export const lang = () => current;

/** The text for `key`, with {placeholders} filled from `vars`. Missing text falls back to English. */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const text = strings[key] ?? en[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text;
}

/** Whether there's text for `key` (some settings have no hint line). */
export const has = (key: string): key is Key => key in en;

/** For counts: `key.one` for 1, `key.other` otherwise, with {n} filled in. */
export function tn(key: 'moves' | 'spider.suits' | 'landscaper.opponents', n: number, vars?: Record<string, string | number>): string {
  return t(`${key}.${n === 1 ? 'one' : 'other'}` as Key, { n, ...vars });
}

/**
 * Fill in the page's static text: data-i18n sets an element's text, data-i18n-aria its
 * aria-label. Run again after switching language.
 */
export function translatePage(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n as Key)));
  root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria as Key)));
  document.title = t('app.title');
}
