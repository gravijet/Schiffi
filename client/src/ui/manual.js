/**
 * The manual.
 *
 * Written as structured content and rendered through the translator, so it
 * appears in whichever of the nine variants the player has chosen rather than
 * being a slab of untranslatable HTML.
 */
import { h } from './dom.js';
import { t } from '../state/i18n.js';

/** Section keys map onto locale keys that already exist for the UI. */
const SECTIONS = [
  {
    title: 'mode.title',
    lines: ['mode.traderDesc', 'mode.explorerDesc'],
  },
  {
    title: 'hud.setSail',
    lines: ['settings.keyboard', 'settings.gamepad', 'settings.touch'],
    extra: [
      { term: '← ↑ → ↓ / W A S D', detail: 'hud.heading' },
      { term: 'Q / E', detail: 'hud.map' },
      { term: 'Enter', detail: 'chat.send' },
      { term: 'M', detail: 'hud.map' },
      { term: 'F3', detail: 'settings.perfOverlay' },
    ],
  },
  {
    title: 'trade.buy',
    lines: ['trade.buyPrice', 'trade.sellPrice', 'trade.demand', 'trade.supply', 'trade.tariff'],
  },
  {
    title: 'cargo.title',
    lines: ['cargo.perishable', 'cargo.lossNoRefund', 'ship.cargoProtect', 'ship.cooling'],
  },
  {
    title: 'crew.title',
    lines: ['crew.morale', 'crew.health', 'crew.wage', 'crew.understaffed'],
  },
  {
    title: 'weather.storm',
    lines: ['weather.stormApproaching', 'weather.iceField', 'ship.stormResist'],
  },
  {
    title: 'explore.title',
    lines: ['explore.undiscovered', 'explore.firstDiscovery', 'explore.nameIsland', 'cartography.title'],
  },
  {
    title: 'pvp.protected',
    lines: ['hazard.pvpOff', 'hazard.pvpOn', 'pvp.bounty'],
  },
  {
    title: 'bank.title',
    lines: ['bank.ingameOnly', 'bank.loan', 'bank.creditLimit', 'insurance.title'],
  },
];

export function manualView() {
  return h('div', null,
    h('h2', null, t('menu.manual')),
    h('p.lede', null, t('app.tagline')),
    ...SECTIONS.map((section) =>
      h('div.card', null,
        h('div.card__title', null, t(section.title)),
        h('ul', { style: { margin: '0', paddingLeft: '18px' } },
          ...section.lines.map((key) => h('li', null, t(key)))),
        section.extra
          ? h('dl.kv', { style: { marginTop: '10px' } },
            ...section.extra.flatMap((row) => [
              h('dt.mono', null, row.term),
              h('dd', null, t(row.detail)),
            ]))
          : null)),
  );
}
