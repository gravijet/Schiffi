/**
 * Port storage and the tavern's talk.
 *
 * Both belong to the port rather than to the ship, which is why they share a
 * screen: a captain who has just docked wants to know what can be left behind
 * and what is being said. Rent, capacity and prices all come from the server.
 */
import { h, add, clear, tabs, toast, modal } from '../dom.js';
import { t, tc } from '../../state/i18n.js';
import { api } from '../../net/api.js';
import { countdown } from './missions.js';
import { goodById } from '@schiffi/shared/data/goods.js';
import { WAREHOUSE_BASE_CAPACITY, WAREHOUSE_DEPOSIT, warehouseRent }
  from '@schiffi/shared/data/costs.js';
import { currentLocale } from '../../state/i18n.js';

const goodName = (goodId) => {
  const good = goodById(Number(goodId));
  return good ? (good.names[currentLocale()] ?? good.names.en) : `#${goodId}`;
};

export function portServicesView(ctx) {
  const root = h('div.stack');
  const pane = h('div.stack');
  let tab = 'warehouse';

  const header = tabs([
    { key: 'warehouse', label: t('warehouse.title') },
    { key: 'rumours', label: t('rumour.title') },
    { key: 'charts', label: t('treasure.chart') },
  ], tab, (key) => { tab = key; render(); });

  add(root, header, pane);

  async function act(name, payload, successKey, then) {
    try {
      await ctx.socket.action(name, payload);
      toast(t(successKey), 'good');
      ctx.refreshCharacter?.();
      then?.();
    } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
  }

  async function render() {
    clear(pane);
    pane.append(h('p.small.muted', null, t('common.loading')));
    const character = ctx.character;
    try {
      if (tab === 'warehouse') pane.replaceChildren(await warehousePane(ctx, character, act, render));
      else if (tab === 'rumours') pane.replaceChildren(await rumourPane(ctx, character, act, render));
      else pane.replaceChildren(await chartPane(character));
    } catch (error) {
      clear(pane);
      pane.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    }
  }

  render();
  return root;
}

async function warehousePane(ctx, character, act, refresh) {
  const root = h('div.stack');
  const { warehouses } = await api.warehouses(character.id);
  const here = warehouses.find((store) => store.portId === character.portId);

  if (!character.docked) {
    root.append(h('p.small.muted', null, t('error.notInPort')));
    return root;
  }

  if (!here) {
    // Say what it costs before it is pressed, not after it is refused.
    add(root,
      h('p.small.muted', null, t('warehouse.none')),
      h('dl.kv', null,
        h('dt', null, t('warehouse.capacity')), h('dd', null, String(WAREHOUSE_BASE_CAPACITY)),
        h('dt', null, t('warehouse.deposit')), h('dd', null, tc(WAREHOUSE_DEPOSIT)),
        h('dt', null, t('warehouse.rentPerDay')),
        h('dd', null, tc(warehouseRent(WAREHOUSE_BASE_CAPACITY)))),
      h('p.small.muted', null, t('warehouse.arrears')),
      h('button.primary', {
        disabled: (ctx.character?.coins ?? 0) < WAREHOUSE_DEPOSIT,
        onClick: () => act('warehouse.rent', { capacity: WAREHOUSE_BASE_CAPACITY },
          'warehouse.rented', refresh),
      }, `${t('warehouse.rent')} · ${tc(WAREHOUSE_DEPOSIT)}`));
    return root;
  }

  const move = (goodId, qty, direction) =>
    act('warehouse.move', { goodId, qty, direction }, 'common.ok', refresh);

  add(root,
    h('dl.kv', null,
      h('dt', null, t('warehouse.capacity')), h('dd', null, `${here.used} / ${here.capacity}`),
      h('dt', null, t('warehouse.rentPerDay')), h('dd', null, tc(here.rentPerDay))),
    h('div.card__title', null, t('warehouse.title')));

  if (!here.cargo.length) root.append(h('p.small.muted', null, t('cargo.empty')));
  for (const lot of here.cargo) {
    root.append(h('div.row.row--between', null,
      h('span', null, `${lot.qty}× ${goodName(lot.goodId)}`),
      h('button.ghost', { onClick: () => move(lot.goodId, lot.qty, 'load') }, t('warehouse.load'))));
  }

  root.append(h('div.card__title', null, t('cargo.title')));
  const hold = character.cargo ?? [];
  if (!hold.length) root.append(h('p.small.muted', null, t('cargo.empty')));
  for (const lot of hold) {
    root.append(h('div.row.row--between', null,
      h('span', null, `${lot.qty}× ${goodName(lot.goodId)}`),
      h('button.ghost', { onClick: () => move(lot.goodId, lot.qty, 'store') }, t('warehouse.store'))));
  }
  return root;
}

async function rumourPane(ctx, character, act, refresh) {
  const root = h('div.stack');
  if (!character.docked || !character.portId) {
    root.append(h('p.small.muted', null, t('error.notInPort')));
    return root;
  }

  const { rumours } = await api.rumours(character.worldId, character.portId);
  if (!rumours.length) {
    root.append(h('p.small.muted', null, t('rumour.none')));
    return root;
  }

  for (const rumour of rumours) {
    root.append(h('div.card', null,
      h('div.row.row--between', null,
        h('div.grow', null,
          h('div', null, t(`rumour.kinds.${rumour.kind}`)),
          h('div.small.muted', null,
            `${t(`rumour.confidence.${rumour.confidence}`)}`
            + ` · ${t('market.endsIn', { time: countdown(rumour.expiresAt - Date.now()) ?? '—' })}`)),
        h('button.ghost', {
          onClick: () => act('rumour.buy', { rumourId: rumour.id }, 'rumour.bought', refresh),
        }, `${t('rumour.buy')} · ${tc(rumour.price)}`))));
  }
  return root;
}

async function chartPane(character) {
  const root = h('div.stack');
  const { charts } = await api.charts(character.id);
  if (!charts.length) {
    root.append(h('p.small.muted', null, t('treasure.noCharts')));
    return root;
  }
  for (const chart of charts) {
    const data = chart.data ?? {};
    const where = data.x !== undefined
      ? `${Math.round(data.x)} / ${Math.round(data.y)} ±${data.radius ?? 0}`
      : (data.portName ?? data.regionName ?? '');
    root.append(h('div.row.row--between', null,
      h('div', null,
        h('div', null, t(`rumour.kinds.${chart.kind}`)),
        h('div.small.muted', null, where)),
      h('span.small.muted', null,
        new Date(chart.createdAt).toLocaleDateString(currentLocale()))));
  }
  return root;
}

/** Confirm and dig a hoard the expedition report has found. */
export function digDialog(ctx, treasure, onDone) {
  modal({
    title: t('treasure.title'),
    body: h('div.stack', null, h('p', null, t('treasure.here'))),
    actions: [
      { label: t('common.cancel') },
      {
        label: t('treasure.dig'), primary: true,
        onClick: async () => {
          try {
            const result = await ctx.socket.action('treasure.dig', { treasureId: treasure.id });
            toast(`${t('treasure.found')} ${result.taken
              .map((entry) => `${entry.qty}× ${goodName(entry.goodId)}`).join(', ')}`, 'good');
            ctx.refreshCharacter?.();
            onDone?.();
          } catch (error) {
            toast(t(error.code === 'market.noSpace' ? 'treasure.needSpace'
              : (error.code ?? 'error.generic')), 'bad');
            return false;
          }
          return true;
        },
      },
    ],
  });
}
