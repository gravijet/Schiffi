/**
 * Fleet overview: everything the player owns, in one place.
 *
 * "Your ship" is the one live vessel the server actually simulates.
 * "Route ships" are the automated trade routes from the Company panel -
 * real server economy state (real waypoints, a real ETA), just not a
 * physical ship with a position. This screen is the fast glance at both;
 * Company remains the place to create, edit or delete them.
 */
import { h, add, clear, bar } from '../dom.js';
import { t } from '../../state/i18n.js';
import { api } from '../../net/api.js';
import { settings } from '../../state/settings.js';
import { routeCard } from './company.js';

export function fleetView(ctx, close) {
  const root = h('div.stack');
  add(root, hintCard(), yourShipCard(ctx), h('div.card__title', null, t('fleet.routeShips')));

  const routesPane = h('div.stack');
  add(root, routesPane);
  add(root, h('div.row', null,
    h('button.ghost', { onClick: () => { close?.(); ctx.openCompany(); } }, t('fleet.manageCompany'))));

  async function refresh() {
    clear(routesPane);
    routesPane.append(h('p.small.muted', null, t('common.loading')));
    try {
      const { routes } = await api.routes(ctx.character.id);
      clear(routesPane);
      if (!routes.length) { routesPane.append(h('p.small.muted', null, t('company.noRoutes'))); return; }
      for (const route of routes) routesPane.append(routeCard(ctx, route, refresh));
    } catch (error) {
      clear(routesPane);
      routesPane.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    }
  }

  refresh();
  return root;
}

function hintCard() {
  if (settings.get('fleetHintSeen')) return null;
  const card = h('div.card', null,
    h('div.row.row--between', null,
      h('p.small.muted', { style: { margin: 0 } }, t('fleet.hint')),
      h('button.icon-btn', {
        title: t('common.close'),
        onClick: () => { settings.set('fleetHintSeen', true); card.remove(); },
      }, '✕')));
  return card;
}

function yourShipCard(ctx) {
  const ship = ctx.character?.ship;
  if (!ship) return null;
  const stats = ship.stats ?? {};
  const used = (ctx.character.cargo ?? []).reduce((sum, lot) => sum + lot.vol * lot.qty, 0);

  return h('div.card', null,
    h('div.card__title', null, `${ship.name} · ${t('fleet.yourShip')}`),
    h('dl.kv', null,
      h('dt', null, t('ship.class')), h('dd', null, t(`shipClass.${ship.classKey}`)),
      h('dt', null, t('ship.speed')), h('dd', null, String(Math.round(stats.speed ?? 0))),
      h('dt', null, t('ship.cargo')), h('dd', null, `${used}/${stats.cargo ?? 0}`)),
    h('div', null,
      h('div.small.muted', null, t('ship.hull')),
      bar(ship.hull, ship.maxHull)));
}
