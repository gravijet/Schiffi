/**
 * The exchange: fixed-price listings and running auctions.
 *
 * Goods leave the hold the moment a lot is listed, so this screen only ever
 * shows lots the auction house actually holds. Prices, bids and end times are
 * the server's; the client sorts and counts down, nothing more.
 */
import { h, add, clear, tabs, toast, modal, virtualList } from '../dom.js';
import { t, tc } from '../../state/i18n.js';
import { api } from '../../net/api.js';
import { countdown } from './missions.js';
import { goodById } from '@schiffi/shared/data/goods.js';
import { currentLocale } from '../../state/i18n.js';
import { COMMISSION, MIN_AUCTION_MS, MAX_AUCTION_MS } from '@schiffi/shared/data/costs.js';

const goodName = (goodId) => {
  const good = goodById(Number(goodId));
  return good ? (good.names[currentLocale()] ?? good.names.en) : `#${goodId}`;
};

export function exchangeView(ctx) {
  const root = h('div.stack');
  const pane = h('div.stack');
  let tab = 'listings';
  let data = null;

  const header = tabs([
    { key: 'listings', label: t('market.globalMarket') },
    { key: 'auctions', label: t('market.auction') },
    { key: 'mine', label: t('market.yourListings') },
  ], tab, (key) => { tab = key; renderPane(); });

  add(root,
    h('div.row', null,
      h('button.primary', { onClick: () => listDialog(ctx, refresh) }, t('market.createListing')),
      h('button.ghost', { onClick: () => refresh() }, t('common.refresh'))),
    header, pane);

  async function refresh() {
    clear(pane);
    pane.append(h('p.small.muted', null, t('common.loading')));
    try {
      data = await api.market(ctx.character.worldId, { limit: 200 });
      renderPane();
    } catch (error) {
      clear(pane);
      pane.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    }
  }

  async function act(name, payload, successKey) {
    try {
      await ctx.socket.action(name, payload);
      toast(t(successKey), 'good');
      ctx.refreshCharacter?.();
      await refresh();
    } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
  }

  function listingRow(listing) {
    const mine = listing.seller === ctx.character?.name;
    return h('div.row.row--between', { style: { padding: '4px 2px' } },
      h('div.grow', { style: { overflow: 'hidden' } },
        h('div', { style: { whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } },
          `${listing.qty}× ${goodName(listing.goodId)}`),
        h('div.small.muted', null, `${t('market.seller')}: ${listing.seller}`)),
      h('div.mono.right', { style: { width: '68px' } }, tc(listing.unitPrice)),
      mine
        ? h('button.ghost', { onClick: () => act('market.cancel', { listingId: listing.id }, 'market.cancelled') },
          t('common.cancel'))
        : h('button.ghost', { onClick: () => buyDialog(ctx, listing, refresh) }, t('trade.buyOne')));
  }

  function auctionRow(auction) {
    const mine = auction.seller === ctx.character?.name;
    const left = countdown(auction.endsAt - Date.now());
    const price = auction.currentBid ?? auction.startPrice;
    return h('div.row.row--between', { style: { padding: '4px 2px' } },
      h('div.grow', { style: { overflow: 'hidden' } },
        h('div', { style: { whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } },
          `${auction.qty}× ${goodName(auction.goodId)}`),
        h('div.small.muted', null,
          `${auction.currentBid ? t('market.highestBid') : t('market.startBid')} ${tc(price)}`
          + ` · ${left ? t('market.endsIn', { time: left }) : t('mission.expired')}`)),
      auction.buyoutPrice
        ? h('button.ghost', {
          disabled: mine,
          onClick: () => act('market.buyout', { auctionId: auction.id }, 'market.bought'),
        }, `${t('market.buyout')} ${tc(auction.buyoutPrice)}`)
        : null,
      h('button.ghost', {
        disabled: mine,
        onClick: () => bidDialog(ctx, auction, refresh),
      }, t('market.bid')));
  }

  function renderPane() {
    clear(pane);
    if (!data) return;

    if (tab === 'mine') {
      const own = [
        ...data.listings.filter((row) => row.seller === ctx.character?.name).map(listingRow),
        ...data.auctions.filter((row) => row.seller === ctx.character?.name).map(auctionRow),
      ];
      if (!own.length) pane.append(h('p.small.muted', null, t('market.none')));
      else add(pane, ...own);
      return;
    }

    const rows = tab === 'listings' ? data.listings : data.auctions;
    if (!rows.length) { pane.append(h('p.small.muted', null, t('market.none'))); return; }

    // The exchange can hold a couple of hundred lots; virtualise so scrolling
    // stays cheap on the weak hardware this has to run on.
    const container = h('div', { style: { maxHeight: '46vh', overflow: 'auto', position: 'relative' } });
    virtualList({
      container, items: rows, rowHeight: 42,
      renderRow: (row) => (tab === 'listings' ? listingRow(row) : auctionRow(row)),
    });
    pane.append(container);
  }

  refresh();
  return root;
}

function buyDialog(ctx, listing, refresh) {
  const qty = h('input', { type: 'number', min: 1, max: listing.qty, value: listing.qty });
  const total = h('div.mono');
  const update = () => {
    const count = Math.max(0, Math.min(listing.qty, Number(qty.value) || 0));
    total.textContent = `${tc(count * listing.unitPrice)} ${t('unit.coins')}`;
  };
  qty.addEventListener('input', update);
  update();

  modal({
    title: goodName(listing.goodId),
    body: h('div.stack', null,
      h('dl.kv', null,
        h('dt', null, t('market.seller')), h('dd', null, listing.seller),
        h('dt', null, t('market.fixedPrice')), h('dd', null, tc(listing.unitPrice))),
      h('div.field', null, h('label', null, t('market.quantity')), qty),
      h('div.row.row--between', null, h('span', null, t('common.total')), total)),
    actions: [
      { label: t('common.cancel') },
      {
        label: t('trade.buyOne'), primary: true,
        onClick: async () => {
          try {
            await ctx.socket.action('market.buy', {
              listingId: listing.id, qty: Math.max(1, Number(qty.value) || 0),
            });
            toast(t('market.bought'), 'good');
            ctx.refreshCharacter?.();
            refresh();
          } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); return false; }
          return true;
        },
      },
    ],
  });
}

function bidDialog(ctx, auction, refresh) {
  const floor = (auction.currentBid ?? auction.startPrice) + 1;
  const amount = h('input', { type: 'number', min: floor, value: floor });

  modal({
    title: `${auction.qty}× ${goodName(auction.goodId)}`,
    body: h('div.stack', null,
      h('dl.kv', null,
        h('dt', null, t('market.seller')), h('dd', null, auction.seller),
        h('dt', null, auction.currentBid ? t('market.highestBid') : t('market.startBid')),
        h('dd', null, tc(auction.currentBid ?? auction.startPrice))),
      h('div.field', null, h('label', null, t('market.yourBid')), amount)),
    actions: [
      { label: t('common.cancel') },
      {
        label: t('market.bid'), primary: true,
        onClick: async () => {
          try {
            await ctx.socket.action('market.bid', {
              auctionId: auction.id, amount: Number(amount.value) || 0,
            });
            toast(t('market.bidPlaced'), 'good');
            ctx.refreshCharacter?.();
            refresh();
          } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); return false; }
          return true;
        },
      },
    ],
  });
}

/** List cargo out of the hold, either at a fixed price or as an auction. */
function listDialog(ctx, refresh) {
  const cargo = ctx.character?.cargo ?? [];
  if (!cargo.length) { toast(t('cargo.empty'), 'info'); return; }

  const goodSelect = h('select', null,
    ...cargo.map((lot) => h('option', { value: String(lot.goodId) },
      `${goodName(lot.goodId)} (${lot.qty})`)));
  const qty = h('input', { type: 'number', min: 1, value: 1 });
  const auction = h('input', { type: 'checkbox' });
  const price = h('input', { type: 'number', min: 1, value: 10 });
  const buyout = h('input', { type: 'number', min: 0, value: 0 });
  const hours = h('input', {
    type: 'number',
    min: Math.ceil(MIN_AUCTION_MS / 3_600_000 * 60) / 60,
    max: MAX_AUCTION_MS / 3_600_000,
    value: 6,
  });

  const auctionOnly = h('div.stack', { hidden: true },
    h('div.field', null, h('label', null, t('market.buyout')), buyout),
    h('div.field', null, h('label', null, `${t('market.duration')} (${t('unit.hours')})`), hours));
  auction.addEventListener('change', () => { auctionOnly.hidden = !auction.checked; updateLabels(); });

  const priceLabel = h('label', null, t('market.fixedPrice'));
  const fee = h('div.small.muted');
  const updateLabels = () => {
    priceLabel.textContent = auction.checked ? t('market.startBid') : t('market.fixedPrice');
    const gross = auction.checked
      ? Number(price.value) || 0
      : (Number(price.value) || 0) * (Number(qty.value) || 0);
    fee.textContent = t('market.fee', { amount: tc(Math.ceil(gross * COMMISSION)) });
  };
  price.addEventListener('input', updateLabels);
  qty.addEventListener('input', updateLabels);

  const syncMax = () => {
    const lot = cargo.find((entry) => String(entry.goodId) === goodSelect.value);
    qty.max = String(lot?.qty ?? 1);
    if (Number(qty.value) > (lot?.qty ?? 1)) qty.value = String(lot?.qty ?? 1);
    updateLabels();
  };
  goodSelect.addEventListener('change', syncMax);
  syncMax();

  modal({
    title: t('market.createListing'),
    body: h('div.stack', null,
      h('div.field', null, h('label', null, t('market.lot')), goodSelect),
      h('div.field', null, h('label', null, t('market.quantity')), qty),
      h('label.row', null, auction, h('span', null, t('market.auction'))),
      h('div.field', null, priceLabel, price),
      auctionOnly,
      fee),
    actions: [
      { label: t('common.cancel') },
      {
        label: t('market.createListing'), primary: true,
        onClick: async () => {
          const payload = {
            goodId: Number(goodSelect.value),
            qty: Math.max(1, Number(qty.value) || 0),
            auction: auction.checked,
          };
          if (auction.checked) {
            payload.startPrice = Math.max(1, Number(price.value) || 0);
            const buy = Number(buyout.value) || 0;
            if (buy > 0) payload.buyoutPrice = buy;
            payload.durationMs = Math.round((Number(hours.value) || 1) * 3_600_000);
          } else {
            payload.unitPrice = Math.max(1, Number(price.value) || 0);
          }
          try {
            await ctx.socket.action('market.list', payload);
            toast(t('market.listed'), 'good');
            ctx.refreshCharacter?.();
            refresh();
          } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); return false; }
          return true;
        },
      },
    ],
  });
}
