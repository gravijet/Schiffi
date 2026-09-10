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

/** One line describing what a contract asks for, per type. */
function requirement(mission) {
  const data = mission.data ?? {};
  switch (mission.type) {
    case 'delivery':
    case 'supply':
    case 'smuggle':
      return `${data.qty}× ${goodName(data.goodId)} → ${data.toPortName}`;
    case 'passenger':
      return `${data.count}× ${t('passenger.title')} → ${data.toPortName}`;
    case 'escort':
      return `→ ${data.toPortName}`;
    case 'exploration':
      return `${t('explore.title')} · ${Math.round(data.hintX)} / ${Math.round(data.hintY)} ±${data.radius}`;
    case 'salvage':
      return `${t('combat.salvage')} · ${Math.round(data.x)} / ${Math.round(data.y)}`;
    case 'bounty':
      return `${data.kills}× ${t('mission.types.bounty')}`;
    default:
      return '';
  }
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

function missionCard(mission, { character, onAccept, onAbandon, onComplete }) {
  const deadline = remaining(mission.deadline);
  const ready = onComplete ? readyToComplete(mission, character) : false;

  return h('div.card.card--tight', null,
    h('div.row.row--between', null,
      h('div.grow', null,
        h('div', null, t(`mission.types.${mission.type}`),
          mission.data?.risk ? h('span.bad.small', null, ' ⚑') : null),
        h('div.small.muted', null, requirement(mission))),
      h('div.right', null,
        h('div.mono', null, tc(mission.reward)),
        deadline ? h('div.small.muted', null, deadline) : null)),
    ready ? h('div.small.good', null, t('mission.readyToComplete')) : null,
    h('div.row', null,
      onAccept ? h('button.ghost', { onClick: () => onAccept(mission) }, t('mission.accept')) : null,
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
        const { missions } = await api.portMissions(character.worldId, character.portId);
        clear(list);
        if (!missions.length) {
          list.append(h('p.small.muted', null, t('mission.noneAtPort')));
          return;
        }
        for (const mission of missions) {
          list.append(missionCard(mission, {
            character,
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
