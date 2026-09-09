/**
 * Client localisation.
 *
 * Locale catalogues are loaded on demand, so a player downloads one language
 * rather than nine. English is always present as the fallback, and the three
 * stylised German variants pull the German catalogue and transform it.
 *
 * Switching language re-renders the whole interface immediately: every piece
 * of UI text goes through `t()` at render time, and `applyTranslations` walks
 * any already-rendered `data-i18n` nodes.
 */
import { Translator, LOCALES, isValidLocale, negotiateLocale, flatten, DEFAULT_LOCALE } from '@schiffi/shared/i18n/index.js';

const LOADERS = {
  de: () => import('@schiffi/shared/i18n/locales/de.js'),
  en: () => import('@schiffi/shared/i18n/locales/en.js'),
  it: () => import('@schiffi/shared/i18n/locales/it.js'),
  fr: () => import('@schiffi/shared/i18n/locales/fr.js'),
  zh: () => import('@schiffi/shared/i18n/locales/zh.js'),
  ru: () => import('@schiffi/shared/i18n/locales/ru.js'),
};

const catalogues = {};
export const translator = new Translator(catalogues, DEFAULT_LOCALE);
const listeners = new Set();

/** Which source catalogue a locale needs. */
function sourceFor(locale) {
  const meta = LOCALES.find((l) => l.code === locale);
  return meta?.base ?? locale;
}

export async function loadLocale(locale) {
  const code = isValidLocale(locale) ? locale : DEFAULT_LOCALE;
  const source = sourceFor(code);
  const needed = new Set([source, 'en']);

  await Promise.all([...needed].map(async (key) => {
    if (catalogues[key]) return;
    const loader = LOADERS[key];
    if (!loader) return;
    const module = await loader();
    catalogues[key] = flatten(module.default);
  }));

  translator.setLocale(code);
  document.documentElement.lang = code.startsWith('de-') || code === 'pirate' ? 'de' : code;
  document.documentElement.dir = translator.dir;
  for (const listener of listeners) listener(code);
  return code;
}

export function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const t = (key, params) => translator.t(key, params);
export const tn = (value, options) => translator.number(value, options);
export const tc = (value) => translator.coins(value);
export const td = (value, options) => translator.date(value, options);
export const currentLocale = () => translator.locale;

/** The locale to use before the player has chosen: the browser's preference. */
export function detectLocale() {
  return negotiateLocale(navigator.languages ?? [navigator.language]);
}

/**
 * Translate a DOM subtree.
 *   data-i18n="key"          -> textContent
 *   data-i18n-attr="title:key;placeholder:key"
 */
export function applyTranslations(root = document) {
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of element.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':');
      if (attr && key) element.setAttribute(attr.trim(), t(key.trim()));
    }
  }
}

export { LOCALES, isValidLocale };
