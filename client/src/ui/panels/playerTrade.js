/**
 * Trading with another captain.
 *
 * The panel is a view of one server-held offer. Every edit and every
 * confirmation is an action; the swap itself happens on the server in a single
 * transaction, so there is no point at which this screen could show one side
 * as paid and the other as not. Changing either half clears both
 * confirmations, and the panel says so.
 */
import { h, add, clear, toast, modal } from '../dom.js';
import { icon } from '../icons.js';
import { t, tc } from '../../state/i18n.js';
import { api } from '../../net/api.js';
import { goodById } from '@schiffi/shared/data/goods.js';
import { currentLocale } from '../../state/i18n.js';
import { TRADE_RANGE } from '@schiffi/shared/data/costs.js';

const goodName = (goodId) => {
  const good = goodById(Number(goodId));
  return good ? (good.names[currentLocale()] ?? good.names.en) : `#${goodId}`;
};

/** Other players close enough to hail, nearest first. */
export function partnersInHail(ctx) {
  const self = ctx.socket.self;
  if (!self) return [];
  const out = [];
  for (const buffer of ctx.socket.entities.values()) {
    if (buffer.kind !== 1) continue;
    const sample = buffer.samples[buffer.samples.length - 1];
    if (!sample) continue;
    const range = Math.hypot(sample.x - self.x, sample.y - self.y);
    if (range <= TRADE_RANGE) out.push({ id: buffer.id, name: buffer.name, range });
  }
  return out.sort((a, b) => a.range - b.range);
}

/** Pick somebody nearby and open an offer with them. */
export function openTradePicker(ctx) {
  const partners = partnersInHail(ctx);
  if (!partners.length) { toast(t('trade.nobodyNear'), 'info'); return; }

  const dialog = modal({
    title: t('trade.propose'),
    body: h('div.stack', null, ...partners.map((partner) =>
      h('button.ghost', {
        onClick: async () => {
          dialog.close();
          try {
            const offer = await ctx.socket.action('trade.propose', { targetId: partner.id });
            openTrade(ctx, offer);
          } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
        },
      }, `${partner.name} · ${Math.round(partner.range)}`))),
    actions: [{ label: t('common.cancel') }],
  });
}

/**
 * The trade window itself.
 *
 * `offer` is whatever the server last said. The window re-renders from the
 * events the server pushes when the other side changes something, so the two
 * players are always looking at the same offer.
 */
export function openTrade(ctx, offer) {
  let current = offer;
  const body = h('div.stack');

  const mine = () => String(current.fromId) === String(ctx.character.id);
  const myGoods = () => (mine() ? current.offerGoods : current.requestGoods);
  const myCoins = () => (mine() ? current.offerCoins : current.requestCoins);
  const theirGoods = () => (mine() ? current.requestGoods : current.offerGoods);
  const theirCoins = () => (mine() ? current.requestCoins : current.offerCoins);
  const myConfirm = () => (mine() ? current.fromConfirmed : current.toConfirmed);
  const theirConfirm = () => (mine() ? current.toConfirmed : current.fromConfirmed);

  async function push(goods, coins) {
    try {
      current = await ctx.socket.action('trade.set', { offerId: current.id, goods, coins });
      render();
    } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
  }

  function sideList(goods, coins, editable) {
    const rows = goods.map((lot) =>
      h('div.row.row--between', null,
        h('span', null, `${lot.qty}× ${goodName(lot.goodId)}`),
        editable
          ? h('button.icon-btn', {
            onClick: () => push(goods.filter((entry) => entry.goodId !== lot.goodId), coins),
          }, icon('close'))
          : null));
    if (coins > 0) {
      rows.unshift(h('div.row.row--between', null,
        h('span', null, t('unit.coins')), h('span.mono', null, tc(coins))));
    }
    if (!rows.length) rows.push(h('p.small.muted', null, t('common.empty')));
    return h('div.stack', null, ...rows);
  }

  function addGoodDialog() {
    const cargo = (ctx.character.cargo ?? []).filter((lot) =>
      !myGoods().some((entry) => entry.goodId === lot.goodId));
    if (!cargo.length) { toast(t('cargo.empty'), 'info'); return; }

    const select = h('select', null, ...cargo.map((lot) =>
      h('option', { value: String(lot.goodId) }, `${goodName(lot.goodId)} (${lot.qty})`)));
    const qty = h('input', { type: 'number', min: 1, value: 1 });
    const sync = () => {
      const lot = cargo.find((entry) => String(entry.goodId) === select.value);
      qty.max = String(lot?.qty ?? 1);
    };
    select.addEventListener('change', sync);
    sync();

    modal({
      title: t('trade.addGood'),
      body: h('div.stack', null,
        h('div.field', null, h('label', null, t('market.lot')), select),
        h('div.field', null, h('label', null, t('trade.quantity')), qty)),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('common.confirm'), primary: true,
          onClick: async () => {
            await push([...myGoods(),
              { goodId: Number(select.value), qty: Math.max(1, Number(qty.value) || 0) }], myCoins());
            return true;
          },
        },
      ],
    });
  }

  function render() {
    clear(body);
    const coins = h('input', { type: 'number', min: 0, value: String(myCoins()) });
    coins.addEventListener('change', () => push(myGoods(), Math.max(0, Number(coins.value) || 0)));

    add(body,
      current.status !== 'open'
        ? h('p.small.muted', null, t(current.status === 'settled' ? 'trade.settled' : 'trade.cancelled'))
        : null,
      h('div.grid-2', null,
        h('div.card', null,
          h('div.card__title', null, t('trade.yourSide')),
          sideList(myGoods(), myCoins(), current.status === 'open'),
          current.status === 'open'
            ? h('div.stack', null,
              h('div.field', null, h('label', null, t('unit.coins')), coins),
              h('button.ghost', { onClick: () => addGoodDialog() }, t('trade.addGood')))
            : null,
          myConfirm() ? h('div.small.good', null, t('trade.confirmed')) : null),
        h('div.card', null,
          h('div.card__title', null, t('trade.theirSide')),
          sideList(theirGoods(), theirCoins(), false),
          theirConfirm()
            ? h('div.small.good', null, t('trade.confirmed'))
            : h('div.small.muted', null, t('trade.waiting')))),
      h('p.small.muted', null, t('trade.changedWarning')));
  }

  const dialog = modal({
    title: t('trade.withPlayer', { player: partnerName(ctx, current) }),
    wide: true,
    body,
    actions: [
      {
        label: t('common.cancel'),
        onClick: async () => {
          try { await ctx.socket.action('trade.cancel', { offerId: current.id }); } catch { /* gone */ }
          return true;
        },
      },
      {
        label: t('trade.confirm'), primary: true,
        onClick: async () => {
          try {
            const result = await ctx.socket.action('trade.confirm', { offerId: current.id });
            current = result;
            if (result.settled) {
              toast(t('trade.settled'), 'good');
              ctx.refreshCharacter?.();
              return true;
            }
            render();
          } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
          // Stay open until the offer actually settles.
          return false;
        },
      },
    ],
    onClose: () => { ctx.activeTrade = null; },
  });

  // The server pushes every change to both sides; keep the window in step.
  ctx.activeTrade = {
    id: current.id,
    update(next) {
      current = next;
      render();
    },
    close(reason) {
      if (reason) toast(t(reason), 'info');
      dialog.close();
    },
  };

  render();
  return dialog;
}

function partnerName(ctx, offer) {
  const partnerId = String(offer.fromId) === String(ctx.character.id) ? offer.toId : offer.fromId;
  return ctx.socket.entities.get(`p${partnerId}`)?.name ?? '';
}

/** Handle a trade event pushed by the server. */
export function onTradeEvent(ctx, message) {
  const offer = message.offer;
  if (!offer) return;

  switch (message.kind) {
    case 'tradeProposed':
      // Only the receiving side is surprised by this one.
      if (String(offer.toId) !== String(ctx.character?.id)) return;
      if (ctx.activeTrade) return;
      toast(t('trade.incoming', { player: partnerName(ctx, offer) }), 'info');
      openTrade(ctx, offer);
      break;
    case 'tradeUpdated':
      ctx.activeTrade?.update(offer);
      break;
    case 'tradeSettled':
      ctx.activeTrade?.update(offer);
      ctx.activeTrade?.close('trade.settled');
      ctx.refreshCharacter?.();
      break;
    case 'tradeCancelled':
      ctx.activeTrade?.close('trade.cancelled');
      break;
    default:
      break;
  }
}
