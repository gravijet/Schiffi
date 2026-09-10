/**
 * Sea combat.
 *
 * The target list is built from the entities the server is already sending in
 * snapshots, so it can only ever contain ships the player can genuinely see.
 * Range, reload and ammunition are shown from the server's own numbers; the
 * buttons disable on the same conditions the server enforces, so a disabled
 * button and a rejected action always agree.
 */
import { h, add, clear, toast, modal, bar } from '../dom.js';
import { t, tc } from '../../state/i18n.js';
import { api } from '../../net/api.js';
import { goodById } from '@schiffi/shared/data/goods.js';
import { currentLocale } from '../../state/i18n.js';
import {
  GUN_RANGE, BOARDING_RANGE, SALVAGE_RANGE, CANNON_PRICE, SHOT_PRICE, MIN_BOUNTY,
} from '@schiffi/shared/data/costs.js';

const goodName = (goodId, fallback) => {
  const good = goodById(Number(goodId));
  return good ? (good.names[currentLocale()] ?? good.names.en) : fallback;
};

/** What to call a sail that has no name of its own. */
const describeKind = (target) =>
  t(`npcKind.${target.kind === 1 ? 'player' : (target.npcKind ?? 'merchant')}`);

/** Ships in range of the player's guns, nearest first. */
export function targetsInRange(ctx) {
  const self = ctx.socket.self;
  if (!self) return [];
  const out = [];
  for (const buffer of ctx.socket.entities.values()) {
    const sample = buffer.samples[buffer.samples.length - 1];
    if (!sample) continue;
    const range = Math.hypot(sample.x - self.x, sample.y - self.y);
    if (range > GUN_RANGE) continue;
    out.push({ id: buffer.id, name: buffer.name, kind: buffer.kind, npcKind: buffer.npcKind,
      faction: buffer.faction, hp: buffer.hp, range });
  }
  return out.sort((a, b) => a.range - b.range);
}

/** Wrecks close enough to salvage. */
export function wrecksInReach(ctx) {
  const self = ctx.socket.self;
  if (!self) return [];
  return (ctx.socket.wrecks ?? [])
    .map((wreck) => ({ ...wreck, range: Math.hypot(wreck.x - self.x, wreck.y - self.y) }))
    .filter((wreck) => wreck.range <= SALVAGE_RANGE)
    .sort((a, b) => a.range - b.range);
}

export function combatView(ctx) {
  const root = h('div.stack');
  const status = h('div.stack');
  const targetList = h('div.stack');
  const wreckList = h('div.stack');
  const bountyList = h('div.stack');
  let aim = 'hull';
  let reloadedAt = 0;
  let ticker = null;

  const shot = () => ctx.character?.ship?.ammunition ?? 0;
  const guns = () => ctx.character?.ship?.cannons ?? 0;

  function renderStatus() {
    clear(status);
    const ship = ctx.character?.ship;
    const slots = ship?.stats?.cannonSlots ?? 0;
    const left = Math.max(0, reloadedAt - Date.now());

    add(status,
      h('dl.kv', null,
        h('dt', null, t('combat.cannons')), h('dd', null, `${guns()} / ${slots}`),
        h('dt', null, t('combat.ammunition')), h('dd', null, String(shot()))),
      left > 0
        ? h('div.small.warn', null, `${t('combat.reloading')} ${(left / 1000).toFixed(1)} s`)
        : null,
      h('div.row', null,
        h(`button.tab${aim === 'hull' ? '.is-active' : ''}`,
          { onClick: () => { aim = 'hull'; renderStatus(); } }, t('combat.aimHull')),
        h(`button.tab${aim === 'sails' ? '.is-active' : ''}`,
          { onClick: () => { aim = 'sails'; renderStatus(); } }, t('combat.aimSails'))),
      // Guns are bought at a shipyard, which the server insists on too, so at
      // sea the button says why instead of failing when pressed.
      slots === 0
        ? h('p.small.muted', null, t('combat.noGunPorts'))
        : h('div.row', null,
          h('button.ghost', {
            disabled: !ctx.character?.docked,
            onClick: () => armDialog(ctx, render),
          }, t('combat.arm')),
          ctx.character?.docked ? null : h('span.small.muted', null, t('combat.armInPort'))));
  }

  async function act(name, payload, onDone) {
    try {
      const result = await ctx.socket.action(name, payload);
      onDone?.(result);
      ctx.refreshCharacter?.();
    } catch (error) {
      toast(t(error.code ?? 'error.generic'), 'bad');
    }
    render();
  }

  function renderTargets() {
    clear(targetList);
    const targets = targetsInRange(ctx);
    if (!targets.length) {
      targetList.append(h('p.small.muted', null, t('combat.noTargets')));
      return;
    }
    const reloading = Date.now() < reloadedAt;

    for (const target of targets) {
      const boardable = target.range <= BOARDING_RANGE;
      targetList.append(h('div.card', null,
        h('div.row.row--between', null,
          h('div.grow', null,
            h('div', null, target.name ?? describeKind(target)),
            h('div.small.muted', null,
              `${describeKind(target)} · ${t('combat.distance')} ${Math.round(target.range)}`)),
          target.hp !== null && target.hp !== undefined
            ? h('div', { style: { width: '58px' } }, bar(target.hp, 100))
            : null),
        h('div.row', null,
          h('button.primary', {
            disabled: reloading || guns() <= 0 || shot() <= 0,
            onClick: () => act('combat.fire', { targetId: target.id, aim }, (result) => {
              reloadedAt = Date.now() + (result.reloadMs ?? 0);
              toast(result.hullDamage + result.sailDamage > 0
                ? t('combat.hit', { damage: result.hullDamage + result.sailDamage })
                : t('combat.missed'), result.sunk ? 'good' : 'info');
              if (result.sunk) toast(t('combat.victory'), 'good');
            }),
          }, t('combat.fire')),
          h('button.ghost', {
            disabled: !boardable,
            onClick: () => act('combat.board', { targetId: target.id }, (result) => {
              if (!result.boarded) return toast(t('combat.boarding'), 'info');
              toast(`${t('combat.boarding')}: ${result.taken.length}`, 'good');
            }),
          }, t('combat.board')),
          h('button.ghost', {
            onClick: () => act('combat.flee', { targetId: target.id }, (result) => {
              toast(result.escaped ? t('combat.fled') : `${t('combat.flee')} ${Math.round(result.chance * 100)} %`,
                result.escaped ? 'good' : 'warn');
            }),
          }, t('combat.flee')),
          target.kind === 1
            ? h('button.ghost', { onClick: () => bountyDialog(ctx, target, render) }, t('combat.placeBounty'))
            : null)));
    }
  }

  function renderWrecks() {
    clear(wreckList);
    const wrecks = wrecksInReach(ctx);
    if (!wrecks.length) return;
    wreckList.append(h('div.card__title', null, t('cartography.wrecks')));
    for (const wreck of wrecks) {
      wreckList.append(h('div.row.row--between', null,
        h('span.small.muted', null, `${t('combat.distance')} ${Math.round(wreck.range)}`),
        h('button.ghost', {
          onClick: () => act('combat.salvage', { wreckId: wreck.id }, (result) => {
            if (!result.taken.length) return toast(t('explore.nothingFound'), 'info');
            toast(`${t('combat.salvaged')} ${result.taken
              .map((entry) => `${entry.qty}× ${goodName(entry.goodId, entry.key)}`).join(', ')}`, 'good');
          }),
        }, t('combat.salvage'))));
    }
  }

  async function renderBounties() {
    clear(bountyList);
    bountyList.append(h('div.card__title', null, t('combat.bounty')));
    try {
      const { bounties } = await api.bounties(ctx.character.worldId);
      if (!bounties.length) {
        bountyList.append(h('p.small.muted', null, t('combat.noBounties')));
        return;
      }
      for (const bounty of bounties.slice(0, 20)) {
        bountyList.append(h('div.row.row--between', null,
          h('span', null, bounty.target),
          h('span.mono', null, tc(bounty.amount))));
      }
    } catch {
      clear(bountyList);
    }
  }

  function render() {
    renderStatus();
    renderTargets();
    renderWrecks();
  }

  add(root, status, h('div.card__title', null, t('combat.targets')), targetList, wreckList, bountyList);
  render();
  renderBounties();

  // Targets move; the list has to follow or the ranges shown are a lie.
  ticker = setInterval(() => { renderStatus(); renderTargets(); renderWrecks(); }, 700);
  root.addEventListener('panel-closed', () => clearInterval(ticker));
  root.stopTicking = () => clearInterval(ticker);
  return root;
}

/** Buy guns and shot. Only at a shipyard, which the server enforces too. */
export function armDialog(ctx, onDone) {
  const ship = ctx.character?.ship;
  const slots = ship?.stats?.cannonSlots ?? 0;
  const freeSlots = Math.max(0, slots - (ship?.cannons ?? 0));

  const cannons = h('input', { type: 'number', min: 0, max: freeSlots, value: 0 });
  const ammunition = h('input', { type: 'number', min: 0, max: 500, value: 0 });
  const total = h('div.mono');
  const update = () => {
    const cost = (Number(cannons.value) || 0) * CANNON_PRICE + (Number(ammunition.value) || 0) * SHOT_PRICE;
    total.textContent = `${tc(cost)} ${t('unit.coins')}`;
  };
  cannons.addEventListener('input', update);
  ammunition.addEventListener('input', update);
  update();

  modal({
    title: t('combat.arm'),
    body: h('div.stack', null,
      h('p.small.muted', null, `${t('combat.cannons')} ${ship?.cannons ?? 0} / ${slots}`),
      h('div.field', null, h('label', null, t('combat.buyCannon')), cannons),
      h('div.field', null, h('label', null, t('combat.buyAmmo')), ammunition),
      h('div.row.row--between', null, h('span', null, t('common.total')), total)),
    actions: [
      { label: t('common.cancel') },
      {
        label: t('common.confirm'), primary: true,
        onClick: async () => {
          try {
            await ctx.socket.action('ship.arm', {
              cannons: Number(cannons.value) || 0,
              ammunition: Number(ammunition.value) || 0,
            });
            toast(t('combat.arm'), 'good');
            ctx.refreshCharacter?.();
            onDone?.();
          } catch (error) {
            toast(t(error.code ?? 'error.generic'), 'bad');
            return false;
          }
          return true;
        },
      },
    ],
  });
}

export function bountyDialog(ctx, target, onDone) {
  const amount = h('input', { type: 'number', min: MIN_BOUNTY, step: 100, value: 500 });
  const reason = h('input', { maxLength: 120, placeholder: t('common.name') });

  modal({
    title: t('combat.bountyOn', { name: target.name ?? '' }),
    body: h('div.stack', null,
      h('div.field', null, h('label', null, t('unit.coins')), amount),
      h('div.field', null, h('label', null, t('chat.reportUser')), reason)),
    actions: [
      { label: t('common.cancel') },
      {
        label: t('combat.placeBounty'), primary: true,
        onClick: async () => {
          try {
            await ctx.socket.action('combat.bounty', {
              targetId: target.id, amount: Number(amount.value) || 0, reason: reason.value.trim(),
            });
            toast(t('combat.bountyPlaced'), 'good');
            ctx.refreshCharacter?.();
            onDone?.();
          } catch (error) {
            toast(t(error.code ?? 'error.generic'), 'bad');
            return false;
          }
          return true;
        },
      },
    ],
  });
}
