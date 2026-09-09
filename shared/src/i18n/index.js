/**
 * Localisation runtime.
 *
 * Nine language variants:
 *   de       Deutsch                 (source for the three stylised variants)
 *   en       English                 (fallback for everything)
 *   it       Italiano
 *   fr       Français
 *   zh       简体中文
 *   ru       Русский
 *   de-alt   stilisiertes Altdeutsch  ] derived from de where no explicit
 *   de-tirol Tiroler Dialekt          ] string is provided, so a new key is
 *   pirate   Piratensprache           ] never shown untranslated
 *
 * Keys are dotted paths ("trade.buy").  Lookup order is
 *   exact locale -> derivation from German -> English -> the key itself.
 */
import { STYLIZERS } from './stylize.js';

export const LOCALES = [
  { code: 'de', name: 'Deutsch', nativeName: 'Deutsch', dir: 'ltr', base: null },
  { code: 'en', name: 'English', nativeName: 'English', dir: 'ltr', base: null },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', dir: 'ltr', base: null },
  { code: 'fr', name: 'French', nativeName: 'Français', dir: 'ltr', base: null },
  { code: 'zh', name: 'Chinese (Simplified)', nativeName: '简体中文', dir: 'ltr', base: null },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', dir: 'ltr', base: null },
  { code: 'de-alt', name: 'Old German (stylised)', nativeName: 'Altdeutsch', dir: 'ltr', base: 'de' },
  { code: 'de-tirol', name: 'Tyrolean dialect', nativeName: 'Tirolerisch', dir: 'ltr', base: 'de' },
  { code: 'pirate', name: 'Pirate speak', nativeName: 'Piratensprache', dir: 'ltr', base: 'de' },
];

export const LOCALE_CODES = LOCALES.map((l) => l.code);
export const DEFAULT_LOCALE = 'en';
export const FALLBACK_LOCALE = 'en';

/** Intl plural category resolution, with German rules for derived variants. */
const PLURAL_LOCALE = {
  de: 'de', en: 'en', it: 'it', fr: 'fr', zh: 'zh', ru: 'ru',
  'de-alt': 'de', 'de-tirol': 'de', pirate: 'de',
};

const pluralCache = new Map();
function pluralRules(locale) {
  const tag = PLURAL_LOCALE[locale] ?? 'en';
  if (!pluralCache.has(tag)) pluralCache.set(tag, new Intl.PluralRules(tag));
  return pluralCache.get(tag);
}

export function isValidLocale(code) {
  return LOCALE_CODES.includes(code);
}

/** Best matching supported locale for a browser Accept-Language style list. */
export function negotiateLocale(preferences) {
  if (!preferences) return DEFAULT_LOCALE;
  const list = Array.isArray(preferences)
    ? preferences
    : String(preferences).split(',').map((p) => p.split(';')[0].trim());
  for (const raw of list) {
    const tag = raw.toLowerCase();
    if (isValidLocale(tag)) return tag;
    const primary = tag.split('-')[0];
    if (primary === 'zh') return 'zh';
    if (isValidLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}

/** Flatten a nested message object into dotted keys. */
export function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
}

/**
 * A translator bound to one locale.
 *
 * `catalogues` maps locale code -> flat message map.  Missing locales simply
 * fall through the chain, so the client can lazy-load only what it needs.
 */
export class Translator {
  constructor(catalogues, locale = DEFAULT_LOCALE) {
    this.catalogues = catalogues;
    this.setLocale(locale);
  }

  setLocale(locale) {
    this.locale = isValidLocale(locale) ? locale : DEFAULT_LOCALE;
    const meta = LOCALES.find((l) => l.code === this.locale);
    this.base = meta?.base ?? null;
    this.stylize = STYLIZERS[this.locale] ?? null;
    this.dir = meta?.dir ?? 'ltr';
    return this.locale;
  }

  /** Raw message lookup following the fallback chain. Returns null if absent. */
  raw(key) {
    const direct = this.catalogues[this.locale]?.[key];
    if (direct !== undefined) return direct;

    // Stylised variants derive from their German base.
    if (this.base) {
      const baseText = this.catalogues[this.base]?.[key];
      if (baseText !== undefined && this.stylize) return this.stylize(baseText);
      if (baseText !== undefined) return baseText;
    }

    const fallback = this.catalogues[FALLBACK_LOCALE]?.[key];
    return fallback !== undefined ? fallback : null;
  }

  /**
   * Translate. `params` fills {placeholders}; a numeric `params.count`
   * additionally selects a plural form from "key.one" / "key.other" etc.
   */
  t(key, params = null) {
    let message = null;

    if (params && typeof params.count === 'number') {
      const category = pluralRules(this.locale).select(params.count);
      message = this.raw(`${key}.${category}`) ?? this.raw(`${key}.other`);
    }
    if (message === null || message === undefined) message = this.raw(key);
    if (message === null || message === undefined) return key;
    return params ? interpolate(message, params, this.locale) : message;
  }

  /** True when the key exists anywhere in the chain. */
  has(key) {
    return this.raw(key) !== null;
  }

  number(value, options) {
    return new Intl.NumberFormat(PLURAL_LOCALE[this.locale] ?? 'en', options).format(value);
  }

  /** Coins are always integers and grouped; they can get very large. */
  coins(value) {
    return this.number(Math.trunc(value));
  }

  date(value, options = { dateStyle: 'medium', timeStyle: 'short' }) {
    return new Intl.DateTimeFormat(PLURAL_LOCALE[this.locale] ?? 'en', options).format(value);
  }
}

/** Replace {placeholders}; numbers are locale formatted automatically. */
export function interpolate(message, params, locale = 'en') {
  return String(message).replace(/\{(\w+)\}/g, (match, name) => {
    if (!(name in params)) return match;
    const value = params[name];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Intl.NumberFormat(PLURAL_LOCALE[locale] ?? 'en').format(value);
    }
    return String(value);
  });
}

/**
 * Report which keys a locale is missing relative to the reference locale.
 * Used by the test suite so an untranslated string cannot ship unnoticed.
 */
export function missingKeys(catalogues, locale, reference = 'de') {
  const ref = catalogues[reference] ?? {};
  const target = catalogues[locale] ?? {};
  return Object.keys(ref).filter((k) => target[k] === undefined);
}
