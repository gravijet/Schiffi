/**
 * Trade between two players.
 *
 * The whole point is that it settles or it does not: coins and goods change
 * hands inside one transaction, and if any part of it fails - a hold that
 * filled up in the meantime, coins that were spent elsewhere - nothing moves
 * at all. Neither side can end up having paid for nothing.
 *
 * Both sides also have to confirm the *same* offer. Every change to either
 * side's half clears both confirmations, so an offer cannot be edited after
 * the other player has agreed to it.
 */
import { getDatabase } from '../db/index.js';
import { HttpError } from '../http/respond.js';
import { dist } from '@schiffi/shared/util/math.js';
import { goodById } from '@schiffi/shared/data/goods.js';
// The client greys the trade button out at the same distance rather than
// offering a trade the server will refuse.
import { TRADE_RANGE } from '@schiffi/shared/data/costs.js';
import { addCargo, removeCargo, cargoUsage } from './characters.js';

/** An offer nobody touches expires rather than sitting open forever. */
const OFFER_TTL_MS = 10 * 60_000;
const MAX_LOTS = 8;

const fail = (code, message = code) => new HttpError(400, code, message);

/** Normalise a client's list of goods to [{goodId, qty}], with no duplicates. */
function normaliseLots(list) {
  if (!Array.isArray(list)) return [];
  const byGood = new Map();
  for (const entry of list.slice(0, MAX_LOTS * 2)) {
    const goodId = Number(entry?.goodId);
    const qty = Math.floor(Number(entry?.qty));
    if (!goodById(goodId) || !Number.isFinite(qty) || qty <= 0) continue;
    byGood.set(goodId, (byGood.get(goodId) ?? 0) + qty);
  }
  return [...byGood.entries()].slice(0, MAX_LOTS).map(([goodId, qty]) => ({ goodId, qty }));
}

const parseLots = (json) => normaliseLots(JSON.parse(json || '[]'));
const volumeOf = (lots) =>
  lots.reduce((sum, lot) => sum + (goodById(lot.goodId)?.vol ?? 1) * lot.qty, 0);

/** The other party's id, or null when this character is not in the offer. */
function counterpart(offer, characterId) {
  if (String(offer.from_id) === String(characterId)) return offer.to_id;
  if (String(offer.to_id) === String(characterId)) return offer.from_id;
  return null;
}

function describe(offer) {
  return {
    id: offer.id,
    fromId: offer.from_id,
    toId: offer.to_id,
    offerGoods: parseLots(offer.offer_goods),
    offerCoins: Number(offer.offer_coins),
    requestGoods: parseLots(offer.request_goods),
    requestCoins: Number(offer.request_coins),
    fromConfirmed: Number(offer.from_confirmed) === 1,
    toConfirmed: Number(offer.to_confirmed) === 1,
    status: offer.status,
    createdAt: Number(offer.created_at),
    settledAt: offer.settled_at ? Number(offer.settled_at) : null,
  };
}

/** Tell both parties that the offer changed, so neither has to poll. */
function notify(instance, offer, kind) {
  const payload = { t: 'event', kind, offer: describe(offer) };
  for (const id of [offer.from_id, offer.to_id]) {
    instance?.players.get(`p${id}`)?.send?.(payload);
  }
}

// ---------------------------------------------------------------------------

/** Open an offer to another captain who is close enough to hail. */
export async function propose({ instance, characterId, userId, payload }) {
  const targetId = String(payload.targetId ?? '').replace(/^p/, '');
  if (!targetId || targetId === String(characterId)) throw fail('error.validation');

  const me = instance.players.get(`p${characterId}`);
  const them = instance.players.get(`p${targetId}`);
  if (!me || !them) throw fail('trade.partnerGone');
  if (dist(me.x, me.y, them.x, them.y) > TRADE_RANGE) throw fail('error.tooFar');

  const db = getDatabase();
  return db.tx(async (tx) => {
    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');

    // One live offer per pair: a second is a duplicate, not a new negotiation.
    const existing = await tx.get(
      "SELECT * FROM trade_offers WHERE world_id = ? AND status = 'open' " +
      'AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))',
      [instance.id, characterId, targetId, targetId, characterId]);
    if (existing) return describe(existing);

    // A block in either direction ends it here, before anyone is bothered.
    const target = await tx.get('SELECT user_id FROM characters WHERE id = ?', [targetId]);
    if (!target) throw new HttpError(404, 'error.notFound');
    const blocked = await tx.get(
      'SELECT 1 AS x FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)',
      [character.user_id, target.user_id, target.user_id, character.user_id]);
    if (blocked) throw fail('chat.blocked');

    const id = await tx.insert('trade_offers', {
      world_id: instance.id, from_id: characterId, to_id: targetId,
      offer_goods: '[]', offer_coins: 0, request_goods: '[]', request_coins: 0,
      from_confirmed: 0, to_confirmed: 0, status: 'open', created_at: Date.now(),
    });
    const offer = await tx.get('SELECT * FROM trade_offers WHERE id = ?', [id]);
    notify(instance, offer, 'tradeProposed');
    return describe(offer);
  });
}

/**
 * Put goods and coins on your side of the table.
 *
 * Both confirmations are cleared: whoever already agreed agreed to something
 * else, and has to look again.
 */
export async function setOffer({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const offer = await liveOffer(tx, instance, payload.offerId, characterId, userId);
    const goods = normaliseLots(payload.goods);
    const coins = Math.max(0, Math.floor(Number(payload.coins ?? 0)));

    const mine = String(offer.from_id) === String(characterId);
    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (Number(character.coins) < coins) throw fail('trade.notEnoughCoins');

    // Only promise what is actually in the hold right now.
    for (const lot of goods) {
      const held = await tx.get(
        'SELECT SUM(qty) AS n FROM cargo WHERE ship_id = ? AND good_id = ?',
        [character.active_ship_id, lot.goodId]);
      if (Number(held?.n ?? 0) < lot.qty) throw fail('trade.nothingToSell');
    }

    await tx.run(
      `UPDATE trade_offers SET ${mine ? 'offer_goods' : 'request_goods'} = ?, ` +
      `${mine ? 'offer_coins' : 'request_coins'} = ?, from_confirmed = 0, to_confirmed = 0 ` +
      'WHERE id = ?',
      [JSON.stringify(goods), coins, offer.id]);

    const updated = await tx.get('SELECT * FROM trade_offers WHERE id = ?', [offer.id]);
    notify(instance, updated, 'tradeUpdated');
    return describe(updated);
  });
}

/**
 * Confirm your side. When both sides have confirmed, the swap runs here, in
 * this same transaction: there is no moment where one side has paid and the
 * other has not.
 */
export async function confirm({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const offer = await liveOffer(tx, instance, payload.offerId, characterId, userId);
    const mine = String(offer.from_id) === String(characterId);

    await tx.run(`UPDATE trade_offers SET ${mine ? 'from_confirmed' : 'to_confirmed'} = 1 WHERE id = ?`,
      [offer.id]);
    const current = await tx.get('SELECT * FROM trade_offers WHERE id = ?', [offer.id]);

    if (Number(current.from_confirmed) !== 1 || Number(current.to_confirmed) !== 1) {
      notify(instance, current, 'tradeUpdated');
      return { ...describe(current), settled: false };
    }

    const result = await settle(tx, instance, current);
    const settled = await tx.get('SELECT * FROM trade_offers WHERE id = ?', [offer.id]);
    notify(instance, settled, 'tradeSettled');
    return { ...describe(settled), settled: true, ...result };
  });
}

export async function cancel({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const offer = await liveOffer(tx, instance, payload.offerId, characterId, userId);
    await tx.run("UPDATE trade_offers SET status = 'cancelled', settled_at = ? WHERE id = ?",
      [Date.now(), offer.id]);
    const closed = await tx.get('SELECT * FROM trade_offers WHERE id = ?', [offer.id]);
    notify(instance, closed, 'tradeCancelled');
    return describe(closed);
  });
}

/** Open offers this character is part of. */
export async function offersFor(characterId) {
  const db = getDatabase();
  const rows = await db.all(
    "SELECT * FROM trade_offers WHERE status = 'open' AND (from_id = ? OR to_id = ?) " +
    'ORDER BY created_at DESC LIMIT 10', [characterId, characterId]);
  return rows.filter((row) => Date.now() - Number(row.created_at) < OFFER_TTL_MS).map(describe);
}

// ---------------------------------------------------------------------------

/** Fetch an open offer this character belongs to, or explain why not. */
async function liveOffer(tx, instance, offerId, characterId, userId) {
  const offer = await tx.get("SELECT * FROM trade_offers WHERE id = ? AND status = 'open'", [offerId]);
  if (!offer) throw new HttpError(404, 'error.notFound');
  if (!counterpart(offer, characterId)) throw new HttpError(403, 'error.forbidden');
  if (Date.now() - Number(offer.created_at) > OFFER_TTL_MS) {
    await tx.run("UPDATE trade_offers SET status = 'expired' WHERE id = ?", [offer.id]);
    throw fail('trade.offerExpired');
  }

  const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
  if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');

  // Both ships still have to be within hail: a partner who sailed off cannot
  // be traded with, however agreeable the paperwork looks.
  const a = instance.players.get(`p${offer.from_id}`);
  const b = instance.players.get(`p${offer.to_id}`);
  if (!a || !b) throw fail('trade.partnerGone');
  if (dist(a.x, a.y, b.x, b.y) > TRADE_RANGE) throw fail('error.tooFar');

  return offer;
}

/**
 * Move everything, or throw and move nothing.
 *
 * Called inside the caller's transaction, so a failure anywhere below rolls
 * the whole exchange back.
 */
async function settle(tx, instance, offer) {
  const fromGoods = parseLots(offer.offer_goods);
  const toGoods = parseLots(offer.request_goods);
  const fromCoins = Number(offer.offer_coins);
  const toCoins = Number(offer.request_coins);

  const from = await tx.get('SELECT * FROM characters WHERE id = ?', [offer.from_id]);
  const to = await tx.get('SELECT * FROM characters WHERE id = ?', [offer.to_id]);
  if (!from || !to) throw fail('trade.partnerGone');

  if (Number(from.coins) < fromCoins || Number(to.coins) < toCoins) throw fail('trade.notEnoughCoins');

  // Each hold must take what is coming after what is leaving has left it.
  const fromUsage = await cargoUsage(from.active_ship_id, tx);
  const toUsage = await cargoUsage(to.active_ship_id, tx);
  const fromPlayer = instance.players.get(`p${from.id}`);
  const toPlayer = instance.players.get(`p${to.id}`);
  const fromCapacity = fromPlayer?.stats?.cargo ?? 0;
  const toCapacity = toPlayer?.stats?.cargo ?? 0;

  if (fromUsage.used - volumeOf(fromGoods) + volumeOf(toGoods) > fromCapacity) throw fail('market.noSpace');
  if (toUsage.used - volumeOf(toGoods) + volumeOf(fromGoods) > toCapacity) throw fail('market.noSpace');

  // Take from both sides first; only then hand anything over. A shortfall
  // discovered halfway through would otherwise leave goods duplicated.
  const taken = { from: [], to: [] };
  for (const [side, character, lots] of [['from', from, fromGoods], ['to', to, toGoods]]) {
    for (const lot of lots) {
      const { removed, freshness, costBasis } = await removeCargo(
        tx, character.active_ship_id, lot.goodId, lot.qty);
      if (removed < lot.qty) throw fail('trade.nothingToSell');
      taken[side].push({ ...lot, freshness, unitCost: costBasis / lot.qty });
    }
  }

  for (const lot of taken.from) {
    await addCargo(tx, to.active_ship_id, lot.goodId, lot.qty, lot.unitCost, lot.freshness);
  }
  for (const lot of taken.to) {
    await addCargo(tx, from.active_ship_id, lot.goodId, lot.qty, lot.unitCost, lot.freshness);
  }

  const net = fromCoins - toCoins;
  if (net !== 0) {
    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [net, from.id]);
    await tx.run('UPDATE characters SET coins = coins + ? WHERE id = ?', [net, to.id]);
  }

  await tx.run("UPDATE trade_offers SET status = 'settled', settled_at = ? WHERE id = ?",
    [Date.now(), offer.id]);

  return {
    goodsFrom: taken.from.length,
    goodsTo: taken.to.length,
    coinsFrom: fromCoins,
    coinsTo: toCoins,
  };
}
