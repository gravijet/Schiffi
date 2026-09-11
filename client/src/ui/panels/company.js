/**
 * Trading firm: automatic routes and outposts.
 *
 * A route is a real standing order - the server buys the ship, sails it
 * between the ports on the list and books the profit, whether or not anyone
 * is watching. This screen sets one up and reports what it has actually
 * earned; it never simulates a run of its own.
 */
import { h, add, clear, tabs, toast, modal, confirmDialog } from '../dom.js';
import { t, tc } from '../../state/i18n.js';
import { api } from '../../net/api.js';
import { countdown } from './missions.js';
import { SHIP_CLASSES } from '@schiffi/shared/data/ships.js';
import {
  OUTPOST_COST, BUILDING_COST, ROUTE_SHIP_COST_MULTIPLIER, buildingCost,
} from '@schiffi/shared/data/costs.js';
import { currentLocale } from '../../state/i18n.js';

const routeShipCost = (cls) => Math.round(cls.price * ROUTE_SHIP_COST_MULTIPLIER);

export function companyView(ctx) {
  const root = h('div.stack');
  const pane = h('div.stack');
  let tab = 'routes';

  const header = tabs([
    { key: 'routes', label: t('company.routes') },
    { key: 'outposts', label: t('company.outposts') },
  ], tab, (key) => { tab = key; refresh(); });

  add(root, header, pane);

  async function refresh() {
    clear(pane);
    pane.append(h('p.small.muted', null, t('common.loading')));
    try {
      if (tab === 'routes') {
        const { routes } = await api.routes(ctx.character.id);
        clear(pane);
        pane.append(h('div.row', null,
          h('button.primary', { onClick: () => routeDialog(ctx, refresh) }, t('company.createRoute'))));
        if (!routes.length) { pane.append(h('p.small.muted', null, t('company.noRoutes'))); return; }
        for (const route of routes) pane.append(routeCard(ctx, route, refresh));
      } else {
        const [outposts, control] = await Promise.all([
          api.outposts(ctx.character.worldId, ctx.character.id),
          api.seaControl(ctx.character.worldId),
        ]);
        clear(pane);
        pane.append(controlCard(control));
        pane.append(h('div.row', null,
          h('button.primary', { onClick: () => outpostDialog(ctx, refresh) },
            `${t('company.buildOutpost')} · ${tc(OUTPOST_COST)}`)));
        const own = outposts.outposts ?? outposts;
        if (!own.length) { pane.append(h('p.small.muted', null, t('company.noOutposts'))); return; }
        for (const outpost of own) pane.append(outpostCard(ctx, outpost, refresh));
      }
    } catch (error) {
      clear(pane);
      pane.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    }
  }

  refresh();
  return root;
}

/** The public race is deliberately shown beside the build action, not hidden in a menu. */
function controlCard(control) {
  const objective = control.objective ?? {};
  const rows = (control.rankings ?? []).slice(0, 5);
  return h('div.card', null,
    h('div.card__title', null, t('company.seaControl')),
    h('div.small.muted', null, t('company.controlTarget', { percent: objective.targetPercent ?? 40 })),
    h('div.small.muted', null, t('company.controlClaimed', {
      claimed: objective.claimedIslands ?? 0, total: objective.totalIslands ?? 0,
    })),
    rows.length
      ? h('table', null, h('tbody', null, ...rows.map((entry) => h('tr', null,
        h('td.mono', null, `#${entry.rank}`),
        h('td', null, entry.name),
        h('td.right.mono', null, `${entry.share}%`)))))
      : h('p.small.muted', null, t('company.noOutposts')));
}

export function routeCard(ctx, route, refresh) {
  const eta = route.nextArrivalAt ? countdown(route.nextArrivalAt - Date.now()) : null;
  const ports = route.waypoints
    .map((portId) => ctx.world?.ports.find((port) => port.id === portId)?.name ?? portId)
    .join(' → ');

  return h('div.card', null,
    h('div.row.row--between', null,
      h('div.grow', null,
        h('div', null, route.name),
        h('div.small.muted', null, ports)),
      h('button.ghost.danger', {
        onClick: async () => {
          const yes = await confirmDialog({
            title: t('company.routeDeleted'), message: route.name,
            confirmLabel: t('common.delete'), danger: true,
          });
          if (!yes) return;
          try {
            await ctx.socket.action('route.delete', { routeId: route.id });
            toast(t('company.routeDeleted'), 'info');
            ctx.refreshCharacter?.();
            ctx.refreshRoutes?.();
            refresh();
          } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
        },
      }, t('common.delete'))),
    h('dl.kv', null,
      h('dt', null, t('ship.class')), h('dd', null, t(`shipClass.${route.shipClass}`)),
      h('dt', null, t('company.profitPerRun')),
      h('dd', null, route.runs > 0 ? tc(Math.round(route.totalProfit / route.runs)) : '—'),
      h('dt', null, t('common.total')), h('dd', null, tc(route.totalProfit)),
      h('dt', null, t('mission.progress')), h('dd', null, `${route.runs}`),
      ...(eta ? [h('dt', null, t('mission.timeLeft', { time: '' }).trim()), h('dd', null, eta)] : [])));
}

function outpostCard(ctx, outpost, refresh) {
  const levels = new Map(outpost.buildings.map((building) => [building.kind, building.level]));

  return h('div.card', null,
    h('div.card__title', null, outpost.name),
    h('div.small.muted', null, `${Math.round(outpost.x)} / ${Math.round(outpost.y)}`),
    ...Object.keys(BUILDING_COST).map((kind) => {
      const level = levels.get(kind) ?? 0;
      const price = buildingCost(kind, level);
      return h('div.row.row--between', { style: { padding: '2px 0' } },
        h('div', null,
          h('div', null, t(`company.buildings.${kind}`)),
          h('div.small.muted', null, t('company.buildingLevel', { level }))),
        h('button.ghost', {
          onClick: async () => {
            try {
              await ctx.socket.action('outpost.building', { outpostId: outpost.id, kind });
              toast(t('company.buildingBuilt'), 'good');
              ctx.refreshCharacter?.();
              refresh();
            } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
          },
        }, tc(price)));
    }));
}

/** A route needs a name, a ship class and at least two ports in order. */
function routeDialog(ctx, refresh) {
  const ports = (ctx.world?.ports ?? []).slice().sort((a, b) => a.name.localeCompare(b.name, currentLocale()));
  const name = h('input', { placeholder: t('company.createRoute'), maxLength: 60 });

  const classSelect = h('select', null,
    ...SHIP_CLASSES.filter((cls) => cls.price > 0).map((cls) =>
      h('option', { value: cls.key }, `${t(`shipClass.${cls.key}`)} · ${tc(routeShipCost(cls))}`)));

  const portOptions = () => ports.map((port) => h('option', { value: port.id }, port.name));
  const from = h('select', null, ...portOptions());
  const to = h('select', null, ...portOptions());
  if (ports.length > 1) to.value = ports[1].id;

  const cost = h('div.mono');
  const update = () => {
    const cls = SHIP_CLASSES.find((entry) => entry.key === classSelect.value);
    cost.textContent = cls ? `${tc(routeShipCost(cls))} ${t('unit.coins')}` : '';
  };
  classSelect.addEventListener('change', update);
  update();

  modal({
    title: t('company.createRoute'),
    body: h('div.stack', null,
      h('div.field', null, h('label', null, t('common.name')), name),
      h('div.field', null, h('label', null, t('ship.class')), classSelect),
      h('div.field', null, h('label', null, t('company.routeFrom')), from),
      h('div.field', null, h('label', null, t('company.routeTo')), to),
      h('div.row.row--between', null, h('span', null, t('common.price')), cost)),
    actions: [
      { label: t('common.cancel') },
      {
        label: t('company.createRoute'), primary: true,
        onClick: async () => {
          if (from.value === to.value) { toast(t('error.validation'), 'bad'); return false; }
          try {
            await ctx.socket.action('route.create', {
              name: name.value.trim() || t('company.routes'),
              shipClass: classSelect.value,
              waypoints: [from.value, to.value],
            });
            toast(t('company.routeCreated'), 'good');
            ctx.refreshCharacter?.();
            ctx.refreshRoutes?.();
            refresh();
          } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); return false; }
          return true;
        },
      },
    ],
  });
}

/** Outposts go on islands, so this is only reachable from the water. */
function outpostDialog(ctx, refresh) {
  const name = h('input', { placeholder: t('company.buildOutpost'), maxLength: 40 });
  modal({
    title: t('company.buildOutpost'),
    body: h('div.stack', null,
      h('p.small.muted', null, `${t('common.price')}: ${tc(OUTPOST_COST)}`),
      h('div.field', null, h('label', null, t('common.name')), name)),
    actions: [
      { label: t('common.cancel') },
      {
        label: t('company.buildOutpost'), primary: true,
        onClick: async () => {
          try {
            await ctx.socket.action('outpost.build', { name: name.value.trim() });
            toast(t('company.outpostBuilt'), 'good');
            ctx.refreshCharacter?.();
            refresh();
          } catch (error) {
            toast(t(error.code === 'error.tooFar' ? 'explore.tooFar' : (error.code ?? 'error.generic')), 'bad');
            return false;
          }
          return true;
        },
      },
    ],
  });
}
