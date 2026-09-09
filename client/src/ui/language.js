/**
 * Language selection.
 *
 * Shown once on the first visit, and reachable at any time from the menu.
 * Choosing a language re-renders everything immediately and, when signed in,
 * stores the choice on the account so it follows the player to another device.
 */
import { h, modal } from './dom.js';
import { LOCALES } from '@schiffi/shared/i18n/index.js';
import { loadLocale, t, detectLocale } from '../state/i18n.js';
import { settings } from '../state/settings.js';
import { api } from '../net/api.js';

export function languageGrid(current, onPick) {
  return h('div.lang-grid', null, ...LOCALES.map((locale) =>
    h(`button.btn.lang-btn${locale.code === current ? '.is-active' : ''}`, {
      onClick: () => onPick(locale.code),
      lang: locale.code.startsWith('de-') || locale.code === 'pirate' ? 'de' : locale.code,
    },
    h('span.native', null, locale.nativeName),
    h('span.english', null, locale.name))));
}

/** First-visit picker. Resolves once a language has been chosen. */
export async function chooseLanguage({ force = false } = {}) {
  const stored = settings.get('locale');
  if (stored && !force) {
    await loadLocale(stored);
    return stored;
  }

  // Pre-load the browser's best guess so the dialog itself is translated.
  const guess = detectLocale();
  await loadLocale(guess);

  return new Promise((resolve) => {
    const handle = modal({
      title: t('lang.title'),
      dismissable: false,
      body: h('div', null,
        h('p.muted', null, t('lang.subtitle')),
        languageGrid(guess, async (code) => {
          settings.set('locale', code);
          await loadLocale(code);
          // Only sync to the account when there is one; a signed-out visitor
          // keeps the choice locally.
          if (api.isAuthenticated()) await api.updateMe({ locale: code }).catch(() => {});
          handle.close(code);
          resolve(code);
        })),
    });
  });
}

/** Change the language later, from the settings or the menu. */
export async function setLocale(code) {
  settings.set('locale', code);
  await loadLocale(code);
  if (api.isAuthenticated()) await api.updateMe({ locale: code }).catch(() => {});
}
