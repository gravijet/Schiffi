/**
 * Contract board and the contracts you are already carrying.
 *
 * Both lists come straight from the server: the board is whatever the port has
 * posted right now, the active list is what this character actually holds. The
 * "ready" marker is computed from the character's real cargo and port, so a
 * contract only looks completable when the server would in fact accept it.
 */
import { h, add, clear, tabs, toast, confirmDialog } from '../dom.js';
import { t, tc } from '../../state/i18n.js';
import { api } from '../../net/api.js';
import { goodById } from '@schiffi/shared/data/goods.js';
import { MAX_ACTIVE_CONTRACTS } from '@schiffi/shared/data/costs.js';
import { currentLocale } from '../../state/i18n.js';

const goodName = (goodId) => {
  const good = goodById(Number(goodId));
  return good ? (good.names[currentLocale()] ?? good.names.en) : `#${goodId}`;
};

/** "2 Std. 14 Min.", or the expired marker once the deadline has passed. */
export function remaining(deadline) {
  if (!deadline) return null;
  return countdown(deadline - Date.now()) ?? t('mission.expired');
}

/** A span in milliseconds as a short two-unit string, or null once it is up. */
export function countdown(ms) {
  if (ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.ceil(ms / 1000)} ${t('unit.seconds')}`;
  if (minutes < 60) return `${minutes} ${t('unit.minutes')}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${t('unit.hours')} ${minutes % 60} ${t('unit.minutes')}`;
  return `${Math.floor(hours / 24)} ${t('unit.days')} ${hours % 24} ${t('unit.hours')}`;
}

const COMPASS = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'];

/**
 * Where a search area lies, said the way a sailor would.
 *
 * Raw world coordinates mean nothing to a player looking at a map, so a
 * contract that sends you somewhere says how far and in which direction from
 * where the ship is now.
 */
function heading(fromX, fromY, toX, toY) {
  const dx = toX - fromX;
  const dy = toY - fromY;
  // Screen y grows downwards, so a positive dy is southward.
  const octant = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return {
    bearing: t(`bearing.${COMPASS[((octant % 8) + 8) % 8]}`),
    distance: `${Math.round(Math.hypot(dx, dy) / 100) / 10} km`,
  };
}

/**
 * Where the destination port actually is, said the way a sailor would.
 *
 * A contract only ever told the client a port's name, which means nothing
 * until the player has already visited it once. The world meta the client
 * already holds has every port's position and the island it sits on, so this
 * turns a bare name into a heading, a distance and - when the client bothered
 * to keep it - the island to look for it on.
 */
function toward(toPortId, toPortName, self, world) {
  const port = world?.ports?.find((p) => p.id === toPortId);
  const island = port ? world.islands?.find((isl) => isl.id === port.islandId) : null;
  const place = island?.name && island.name !== toPortName
    ? `${toPortName} (${island.name})` : toPortName;
  if (!self || !port) return place;
  const { bearing, distance } = heading(self.x, self.y, port.x, port.y);
  return `${place} · ${t('mission.heading', { bearing, distance })}`;
}

/** One line describing what a contract asks for, per type. */
function requirement(mission, self, world) {
  const data = mission.data ?? {};
  const area = (x, y) => {
    if (!self) return '';
    const { bearing, distance } = heading(self.x, self.y, x, y);
    return t('mission.searchArea', { bearing, distance });
  };

  switch (mission.type) {
    case 'delivery':
    case 'supply':
    case 'smuggle':
      return `${data.qty}× ${goodName(data.goodId)} → ${toward(data.toPortId, data.toPortName, self, world)}`;
    case 'passenger':
      return `${data.count}× ${t('passenger.title')} → ${toward(data.toPortId, data.toPortName, self, world)}`;
    case 'escort':
      return `→ ${toward(data.toPortId, data.toPortName, self, world)}`;
    case 'exploration':
      return `${t('explore.undiscovered')} · ${area(data.hintX, data.hintY)}`;
    case 'salvage':
      return `${t('cartography.wrecks')} · ${area(data.x, data.y)}`;
    case 'bounty':
      return `${data.kills}× ${t('mission.types.bounty')}`;
    default:
      return '';
  }
}

/**
 * Why this ship cannot take that contract, or null when it can.
 *
 * Only the reasons that are plain from the ship's own numbers - the hold, the
 * cabins, how many contracts are already in hand. The server checks all of
 * these again; the point here is not to offer a button that is certain to be
 * refused, and to say why instead.
 */
function blocker(mission, character, activeCount) {
  if (!character?.ship) return 'error.notInPort';
  if (activeCount >= MAX_ACTIVE_CONTRACTS) return 'mission.limitReached';

  const data = mission.data ?? {};
  const stats = character.ship.stats ?? {};

  if (data.goodId && data.qty) {
    const good = goodById(Number(data.goodId));
    const used = (character.cargo ?? []).reduce((sum, lot) => sum + lot.vol * lot.qty, 0);
    const free = (stats.cargo ?? 0) - used;
    if (good && good.vol * Number(data.qty) > free) return 'mission.missingCargo';
  }
  if (mission.type === 'passenger' && Number(data.count) > (stats.passengerBerths ?? 0)) {
    return 'passenger.berths';
  }
  return null;
}

/** Whether the server would accept a completion right now. */
function readyToComplete(mission, character) {
  const data = mission.data ?? {};
  if (!character?.docked) return false;
  if (data.toPortId && character.portId !== data.toPortId) return false;

  if (mission.type === 'delivery' || mission.type === 'supply' || mission.type === 'smuggle') {
    const held = (character.cargo ?? []).find((lot) => lot.goodId === Number(data.goodId));
    return (held?.qty ?? 0) >= Number(data.qty);
  }
  // Passenger, escort, exploration, salvage and bounty are settled by the
  // server from its own records; docking at the destination is what the
  // player controls, so that is what the marker reflects.
  return Boolean(data.toPortId);
}

function missionCard(mission, { character, self, world, activeCount = 0, onAccept, onAbandon, onComplete }) {
  const deadline = remaining(mission.deadline);
  const ready = onComplete ? readyToComplete(mission, character) : false;
  const blocked = onAccept ? blocker(mission, character, activeCount) : null;

  return h('div.card.card--tight', null,
    h('div.row.row--between', null,
      h('div.grow', null,
        h('div', null, t(`mission.types.${mission.type}`),
          mission.data?.risk ? h('span.bad.small', null, ' ⚑') : null),
        h('div.small.muted', null, requirement(mission, self, world))),
      h('div.right', null,
        h('div.mono', null, tc(mission.reward)),
        deadline ? h('div.small.muted', null, deadline) : null)),
    ready ? h('div.small.good', null, t('mission.readyToComplete')) : null,
    blocked ? h('div.small.muted', null, t(blocked)) : null,
    h('div.row', null,
      onAccept
        ? h('button.ghost', { disabled: Boolean(blocked), onClick: () => onAccept(mission) },
          t('mission.accept'))
        : null,
      onComplete
        ? h('button.primary', { disabled: !ready, onClick: () => onComplete(mission) }, t('mission.complete'))
        : null,
      onAbandon ? h('button.ghost.danger', { onClick: () => onAbandon(mission) }, t('mission.abandon')) : null));
}

/**
 * The mission view. `ctx` is the GameUI: it supplies the socket, the current
 * character and a refresh hook so the HUD follows a reward straight away.
 */
export function missionsView(ctx) {
  const root = h('div.stack');
  const list = h('div.stack');
  let tab = 'board';

  const header = tabs([
    { key: 'board', label: t('mission.board') },
    { key: 'active', label: t('mission.active') },
  ], tab, (key) => { tab = key; render(); });

  add(root, header, list);

  async function act(name, payload, successKey) {
    try {
      const result = await ctx.socket.action(name, payload);
      toast(successKey === 'mission.completed'
        ? t('mission.completed') + ` · ${tc(result.reward ?? 0)}`
        : t(successKey), 'good');
      await render();
    } catch (error) {
      toast(t(error.code ?? 'error.generic'), 'bad');
    }
  }

  async function render() {
    clear(list);
    list.append(h('p.small.muted', null, t('common.loading')));
    const character = ctx.character;
    if (!character) return;

    try {
      if (tab === 'board') {
        if (!character.docked || !character.portId) {
          clear(list);
          list.append(h('p.small.muted', null, t('error.notInPort')));
          return;
        }
        const [{ missions }, { missions: active }] = await Promise.all([
          api.portMissions(character.worldId, character.portId),
          api.activeMissions(character.id),
        ]);
        clear(list);
        if (!missions.length) {
          list.append(h('p.small.muted', null, t('mission.noneAtPort')));
          return;
        }
        for (const mission of missions) {
          list.append(missionCard(mission, {
            character,
            self: ctx.socket.self,
            world: ctx.world,
            activeCount: active.length,
            onAccept: (m) => act('mission.accept', { missionId: m.id }, 'mission.accepted'),
          }));
        }
      } else {
        const { missions } = await api.activeMissions(character.id);
        clear(list);
        if (!missions.length) {
          list.append(h('p.small.muted', null, t('mission.noneActive')));
          return;
        }
        for (const mission of missions) {
          list.append(missionCard(mission, {
            character,
            self: ctx.socket.self,
            world: ctx.world,
            onComplete: (m) => act('mission.complete', { missionId: m.id }, 'mission.completed'),
            onAbandon: async (m) => {
              const yes = await confirmDialog({
                title: t('mission.abandon'),
                message: t('mission.abandonWarning'),
                confirmLabel: t('mission.abandon'),
                danger: true,
              });
              if (yes) await act('mission.abandon', { missionId: m.id }, 'mission.abandoned');
            },
          }));
        }
      }
    } catch (error) {
      clear(list);
      list.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    }
  }

  render();
  return root;
}
