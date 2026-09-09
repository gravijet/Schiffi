/**
 * Static locale registry.
 *
 * The server needs every catalogue at once (for localised e-mail); the client
 * imports this module lazily per locale via `loadCatalogue`.
 */
import de from './de.js';
import en from './en.js';
import it from './it.js';
import fr from './fr.js';
import zh from './zh.js';
import ru from './ru.js';
import { flatten } from '../index.js';

export const SOURCE_MESSAGES = { de, en, it, fr, zh, ru };

let _flat = null;

/** All source catalogues, flattened to dotted keys. */
export function catalogues() {
  if (!_flat) {
    _flat = {};
    for (const [code, messages] of Object.entries(SOURCE_MESSAGES)) {
      _flat[code] = flatten(messages);
    }
  }
  return _flat;
}

/**
 * Catalogue for one locale.  Stylised German variants resolve to German here;
 * the Translator applies the stylisation at lookup time so a variant never
 * needs its own file.
 */
export function catalogueFor(locale) {
  const all = catalogues();
  if (all[locale]) return { [locale]: all[locale], en: all.en };
  if (locale.startsWith('de-') || locale === 'pirate') return { de: all.de, en: all.en };
  return { en: all.en };
}
