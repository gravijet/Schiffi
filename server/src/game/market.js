/**
 * Player-driven markets: auctions, fixed-price listings, direct trade,
 * insurance, automated trade routes and outposts.
 *
 * Everything settles inside one transaction, so a bid, a purchase or a swap
 * either happens completely or not at all. Goods leave the seller's hold when
 * a listing is created rather than when it sells - otherwise a seller could
 * list the same cargo twice and sell it in two places.
 */
import { getDatabase } from '../db/index.js';
import { HttpError } from '../http/respond.js';
import { goodById } from '@schiffi/shared/data/goods.js';
import { dist } from '@schiffi/shared/util/math.js';
import { CELL_SIZE, NAVIGABLE } from '@schiffi/shared/world/constants.js';
import { addCargo, removeCargo, cargoUsage } from './characters.js';
import { audit } from '../services/audit.js';
import { shipClass, effectiveStats } from '@schiffi/shared/data/ships.js';
import {
  COMMISSION, MIN_AUCTION_MS, MAX_AUCTION_MS, OUTPOST_COST, BUILDING_COST,
  ROUTE_SHIP_COST_MULTIPLIER, buildingCost,
} from '@schiffi/shared/data/costs.js';

const fail = (code, message = code) => new HttpError(400, code, message);

/** House cut on a completed sale, and the minimum auction duration. */

// ---------------------------------------------------------------------------
// listings and auctions
// ---------------------------------------------------------------------------

/**
 * Put cargo up for sale. The goods leave the hold now: they are in the
 * auction house's custody until the listing sells, expires or is cancelled.
 */
export async function createListing({ instance, characterId, userId, payload }) {
  const qty = Math.floor(Number(payload.qty));
  const unitPrice = Math.floor(Number(payload.unitPrice ?? 0));
  const good = goodById(Number(payload.goodId));
  if (!good) throw new HttpError(404, 'error.notFound');
  if (!Number.isFinite(qty) || qty <= 0) throw fail('error.validation');

  const auction = payload.auction === true;
  const durationMs = Math.min(MAX_AUCTION_MS, Math.max(MIN_AUCTION_MS, Number(payload.durationMs) || 3_600_000));

  const db = getDatabase();
  return db.tx(async (tx) => {
    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (!character) throw new HttpError(404, 'error.notFound');
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (character.docked !== 1) throw fail('error.notInPort');

    const port = instance.portsById.get(character.current_port_id);
    if (!port || port.size < 3) throw fail('error.validation', 'this port has no auction house');

    const { removed, costBasis } = await removeCargo(tx, character.active_ship_id, good.id, qty);
    if (removed < qty) {
      if (removed > 0) await addCargo(tx, character.active_ship_id, good.id, removed, 0, 1);
      throw fail('trade.nothingToSell');
    }

    if (auction) {
      const start = Math.max(1, Math.floor(Number(payload.startPrice ?? good.price * qty * 0.6)));
      const buyout = payload.buyoutPrice ? Math.floor(Number(payload.buyoutPrice)) : null;
      if (buyout !== null && buyout <= start) throw fail('error.validation', 'buyout must exceed the start price');

      const id = await tx.insert('auctions', {
        world_id: instance.id, seller_id: characterId, good_id: good.id, qty,
        freshness: 1, start_price: start, buyout_price: buyout,
        created_at: Date.now(), ends_at: Date.now() + durationMs, status: 'open',
      });
      return { auctionId: id, qty, startPrice: start, buyoutPrice: buyout, endsAt: Date.now() + durationMs };
    }

    if (unitPrice <= 0) throw fail('error.validation', 'set a price');
    const id = await tx.insert('market_listings', {
      world_id: instance.id, seller_id: characterId, good_id: good.id, qty,
      unit_price: unitPrice, freshness: 1, created_at: Date.now(), status: 'open',
    });
    return { listingId: id, qty, unitPrice, costBasis: Math.round(costBasis) };
  });
}

/** Buy a fixed-price listing outright, in whole or in part. */
export async function buyListing({ instance, characterId, userId, payload }) {
  const wanted = Math.floor(Number(payload.qty ?? 0));
  const db = getDatabase();

  return db.tx(async (tx) => {
    const listing = await tx.get(
      "SELECT * FROM market_listings WHERE id = ? AND world_id = ? AND status = 'open'",
      [payload.listingId, instance.id]);
    if (!listing) throw new HttpError(404, 'error.notFound');

    const buyer = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(buyer.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (String(listing.seller_id) === String(characterId)) throw fail('error.validation', 'that is your own listing');
    if (buyer.docked !== 1) throw fail('error.notInPort');

    const qty = wanted > 0 ? Math.min(wanted, Number(listing.qty)) : Number(listing.qty);
    const total = qty * Number(listing.unit_price);
    if (Number(buyer.coins) < total) throw fail('trade.notEnoughCoins');

    const good = goodById(Number(listing.good_id));
    const { used } = await cargoUsage(buyer.active_ship_id, tx);
    const player = instance.players.get(`p${characterId}`);
    if (used + good.vol * qty > (player?.stats?.cargo ?? 8)) throw fail('trade.notEnoughSpace');

    const commission = Math.ceil(total * COMMISSION);
    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [total, characterId]);
    await tx.run('UPDATE characters SET coins = coins + ? WHERE id = ?',
      [total - commission, listing.seller_id]);
    await addCargo(tx, buyer.active_ship_id, good.id, qty, Number(listing.unit_price), Number(listing.freshness));

    const remaining = Number(listing.qty) - qty;
    await tx.run(
      "UPDATE market_listings SET qty = ?, status = ? WHERE id = ?",
      [remaining, remaining > 0 ? 'open' : 'sold', listing.id]);

    return { listingId: listing.id, qty, total, commission, coins: Number(buyer.coins) - total };
  });
}

export async function cancelListing({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const listing = await tx.get(
      "SELECT * FROM market_listings WHERE id = ? AND seller_id = ? AND status = 'open'",
      [payload.listingId, characterId]);
    if (!listing) throw new HttpError(404, 'error.notFound');

    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (character.docked !== 1) throw fail('error.notInPort', 'collect it in a port');

    const good = goodById(Number(listing.good_id));
    const { used } = await cargoUsage(character.active_ship_id, tx);
    const player = instance.players.get(`p${characterId}`);
    if (used + good.vol * Number(listing.qty) > (player?.stats?.cargo ?? 8)) {
      throw fail('trade.notEnoughSpace', 'no room to take it back');
    }

    await addCargo(tx, character.active_ship_id, good.id, Number(listing.qty), 0, Number(listing.freshness));
    await tx.run("UPDATE market_listings SET status = 'cancelled' WHERE id = ?", [listing.id]);
    return { listingId: listing.id, returned: Number(listing.qty) };
  });
}

/**
 * Place a bid. The bid amount is held immediately and refunded to whoever is
 * outbid, so a bid is always backed by coins that exist.
 */
export async function bid({ instance, characterId, userId, payload }) {
  const amount = Math.floor(Number(payload.amount));
  const db = getDatabase();

  return db.tx(async (tx) => {
    const auction = await tx.get(
      "SELECT * FROM auctions WHERE id = ? AND world_id = ? AND status = 'open'",
      [payload.auctionId, instance.id]);
    if (!auction) throw new HttpError(404, 'error.notFound');
    if (Date.now() > Number(auction.ends_at)) throw fail('market.outbid', 'that auction has ended');
    if (String(auction.seller_id) === String(characterId)) throw fail('error.validation');

    const minimum = auction.current_bid
      ? Math.floor(Number(auction.current_bid) * 1.05) + 1
      : Number(auction.start_price);
    if (amount < minimum) throw fail('error.validation', `minimum bid is ${minimum}`);

    const bidder = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(bidder.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (Number(bidder.coins) < amount) throw fail('trade.notEnoughCoins');

    // Refund the previous leader before taking the new bid.
    if (auction.bidder_id) {
      await tx.run('UPDATE characters SET coins = coins + ? WHERE id = ?',
        [Number(auction.current_bid), auction.bidder_id]);
    }
    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [amount, characterId]);
    await tx.run('UPDATE auctions SET current_bid = ?, bidder_id = ? WHERE id = ?',
      [amount, characterId, auction.id]);
    await tx.insert('auction_bids', {
      auction_id: auction.id, bidder_id: characterId, amount, at: Date.now(),
    });

    // A late bid extends the auction, so sniping does not decide it.
    if (Number(auction.ends_at) - Date.now() < 120_000) {
      await tx.run('UPDATE auctions SET ends_at = ? WHERE id = ?', [Date.now() + 120_000, auction.id]);
    }

    return { auctionId: auction.id, amount, coins: Number(bidder.coins) - amount };
  });
}

export async function buyout({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const auction = await tx.get(
      "SELECT * FROM auctions WHERE id = ? AND world_id = ? AND status = 'open'",
      [payload.auctionId, instance.id]);
    if (!auction) throw new HttpError(404, 'error.notFound');
    if (!auction.buyout_price) throw fail('error.validation', 'no buyout price set');

    const buyer = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(buyer.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    const price = Number(auction.buyout_price);
    if (Number(buyer.coins) < price) throw fail('trade.notEnoughCoins');

    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [price, characterId]);
    await settleAuction(tx, auction, { winnerId: characterId, price });
    return { auctionId: auction.id, price, coins: Number(buyer.coins) - price };
  });
}

/** Pay out and deliver an auction; used by buyout and by the sweeper. */
async function settleAuction(tx, auction, { winnerId, price }) {
  const commission = Math.ceil(price * COMMISSION);
  await tx.run('UPDATE characters SET coins = coins + ? WHERE id = ?',
    [price - commission, auction.seller_id]);

  // The goods go to the winner's warehouse at their current port, because they
  // may be at sea when the auction closes.
  const winner = await tx.get('SELECT * FROM characters WHERE id = ?', [winnerId]);
  const portId = winner.current_port_id ?? 'unclaimed';
  let warehouse = await tx.get('SELECT * FROM warehouses WHERE character_id = ? AND port_id = ?',
    [winnerId, portId]);
  if (!warehouse) {
    const id = await tx.insert('warehouses', {
      character_id: winnerId, port_id: portId, capacity: 200,
      rent_per_day: 0, rent_due_at: null,
    });
    warehouse = { id };
  }
  await tx.insert('warehouse_cargo', {
    warehouse_id: warehouse.id, good_id: auction.good_id,
    qty: auction.qty, freshness: auction.freshness,
  });

  await tx.run("UPDATE auctions SET status = 'sold', settled_at = ?, bidder_id = ?, current_bid = ? WHERE id = ?",
    [Date.now(), winnerId, price, auction.id]);
}

/**
 * Close auctions that have run out of time.
 * Called from the world simulation, so it happens even with nobody watching.
 */
export async function sweepAuctions(instance) {
  const db = getDatabase();
  const due = await db.all(
    "SELECT * FROM auctions WHERE world_id = ? AND status = 'open' AND ends_at <= ?",
    [instance.id, Date.now()]);
  if (due.length === 0) return 0;

  for (const auction of due) {
    await db.tx(async (tx) => {
      if (auction.bidder_id) {
        await settleAuction(tx, auction, {
          winnerId: auction.bidder_id, price: Number(auction.current_bid),
        });
      } else {
        // Nobody bid: the goods go back to the seller's warehouse.
        await settleAuction(tx, { ...auction, seller_id: auction.seller_id },
          { winnerId: auction.seller_id, price: 0 });
        await tx.run("UPDATE auctions SET status = 'expired' WHERE id = ?", [auction.id]);
      }
    });
  }
  return due.length;
}

export async function listMarket(worldId, { goodId = null, limit = 60 } = {}) {
  const db = getDatabase();
  const params = [worldId];
  let sql = "SELECT l.*, c.name AS seller FROM market_listings l JOIN characters c ON c.id = l.seller_id " +
    "WHERE l.world_id = ? AND l.status = 'open'";
  if (goodId !== null) { sql += ' AND l.good_id = ?'; params.push(goodId); }
  sql += ' ORDER BY l.unit_price LIMIT ?';
  params.push(Math.min(200, limit));

  const listings = await db.all(sql, params);
  const auctions = await db.all(
    "SELECT a.*, c.name AS seller FROM auctions a JOIN characters c ON c.id = a.seller_id " +
    "WHERE a.world_id = ? AND a.status = 'open' ORDER BY a.ends_at LIMIT 60", [worldId]);

  return {
    listings: listings.map((row) => ({
      id: row.id, goodId: Number(row.good_id), qty: Number(row.qty),
      unitPrice: Number(row.unit_price), seller: row.seller, createdAt: Number(row.created_at),
    })),
    auctions: auctions.map((row) => ({
      id: row.id, goodId: Number(row.good_id), qty: Number(row.qty),
      startPrice: Number(row.start_price),
      currentBid: row.current_bid ? Number(row.current_bid) : null,
      buyoutPrice: row.buyout_price ? Number(row.buyout_price) : null,
      seller: row.seller, endsAt: Number(row.ends_at),
    })),
  };
}

// ---------------------------------------------------------------------------
// insurance
// ---------------------------------------------------------------------------

/** Premium scales with the ship's value and how dangerous the water is. */
export function premiumFor(classKey, coverageDays, hazard) {
  const cls = shipClass(classKey);
  if (!cls) return 0;
  const risk = { calm: 0.6, normal: 1, stormy: 1.5, pirate: 1.9, deepRisk: 2.4, ice: 1.7 }[hazard] ?? 1;
  return Math.ceil(cls.price * 0.012 * coverageDays * risk);
}

export async function buyInsurance({ instance, characterId, userId, payload }) {
  const days = Math.min(30, Math.max(1, Math.floor(Number(payload.days ?? 7))));
  const db = getDatabase();

  return db.tx(async (tx) => {
    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (character.docked !== 1) throw fail('error.notInPort');

    const port = instance.portsById.get(character.current_port_id);
    if (!port || port.size < 2) throw fail('error.validation', 'no insurer in this port');

    const ship = await tx.get('SELECT * FROM ships WHERE id = ?', [character.active_ship_id]);
    const existing = await tx.get(
      'SELECT id FROM insurance_policies WHERE ship_id = ? AND ends_at > ? AND claimed_at IS NULL',
      [ship.id, Date.now()]);
    if (existing) throw new HttpError(409, 'error.conflict', 'this ship is already insured');

    const premium = premiumFor(ship.class_key, days, port.hazard);
    if (Number(character.coins) < premium) throw fail('trade.notEnoughCoins');

    const coverage = Math.round(shipClass(ship.class_key).price * 0.7);
    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [premium, characterId]);
    const id = await tx.insert('insurance_policies', {
      character_id: characterId, ship_id: ship.id, premium, coverage,
      starts_at: Date.now(), ends_at: Date.now() + days * 86_400_000,
    });
    return { policyId: id, premium, coverage, endsAt: Date.now() + days * 86_400_000 };
  });
}

/**
 * Claim on a policy. Payable only against damage the server recorded: the
 * ship must actually be below half hull.
 */
export async function claimInsurance({ characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const policy = await tx.get(
      'SELECT * FROM insurance_policies WHERE id = ? AND character_id = ? AND claimed_at IS NULL',
      [payload.policyId, characterId]);
    if (!policy) throw new HttpError(404, 'error.notFound');
    if (Date.now() > Number(policy.ends_at)) throw fail('error.validation', 'the policy has lapsed');

    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');

    const ship = await tx.get('SELECT * FROM ships WHERE id = ?', [policy.ship_id]);
    // Measure against the hull the ship actually has, upgrades included: a
    // reinforced hull should not read as damaged just because it exceeds the
    // class baseline.
    const upgrades = typeof ship.upgrades === 'string'
      ? JSON.parse(ship.upgrades || '{}') : (ship.upgrades ?? {});
    const maxHull = effectiveStats(ship.class_key, upgrades)?.hull ?? shipClass(ship.class_key).hull;
    const damageFraction = 1 - Math.min(1, Number(ship.hull) / maxHull);
    if (damageFraction < 0.5) throw fail('error.validation', 'not enough damage to claim');

    const payout = Math.round(Number(policy.coverage) * damageFraction);
    await tx.run('UPDATE characters SET coins = coins + ? WHERE id = ?', [payout, characterId]);
    await tx.run('UPDATE insurance_policies SET claimed_at = ?, payout = ? WHERE id = ?',
      [Date.now(), payout, policy.id]);
    await audit({ userId }, 'insurance.claim', 'character', String(characterId),
      { policyId: policy.id, payout }, { db: tx });

    return { policyId: policy.id, payout, coins: Number(character.coins) + payout };
  });
}

// ---------------------------------------------------------------------------
// trade routes and outposts
// ---------------------------------------------------------------------------


export async function createRoute({ instance, characterId, userId, payload }) {
  const waypoints = Array.isArray(payload.waypoints) ? payload.waypoints.slice(0, 8) : [];
  if (waypoints.length < 2) throw fail('error.validation', 'a route needs at least two ports');
  for (const portId of waypoints) {
    if (!instance.portsById.has(portId)) throw fail('error.notFound', `unknown port ${portId}`);
  }
  const cls = shipClass(payload.shipClass);
  if (!cls) throw fail('error.validation', 'unknown ship class');

  const db = getDatabase();
  return db.tx(async (tx) => {
    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');

    let company = await tx.get('SELECT * FROM companies WHERE character_id = ?', [characterId]);
    if (!company) {
      const id = await tx.insert('companies', {
        world_id: instance.id, character_id: characterId,
        name: String(payload.companyName ?? `${character.name} & Co.`).slice(0, 60),
        capital: 0, created_at: Date.now(),
      });
      company = { id };
    }

    // The route buys its own ship, at a premium over the shipyard price.
    const cost = Math.round(cls.price * ROUTE_SHIP_COST_MULTIPLIER);
    if (Number(character.coins) < cost) throw fail('trade.notEnoughCoins');
    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [cost, characterId]);

    const id = await tx.insert('trade_routes', {
      company_id: company.id,
      name: String(payload.name ?? 'Route').slice(0, 60),
      ship_class: cls.key,
      waypoints: JSON.stringify(waypoints),
      cargo_plan: JSON.stringify(Array.isArray(payload.cargoPlan) ? payload.cargoPlan.slice(0, 8) : []),
      status: 'running', leg_index: 0,
      next_arrival_at: Date.now() + legDuration(instance, waypoints[0], waypoints[1], cls),
      total_profit: 0, runs: 0, created_at: Date.now(),
    });
    return { routeId: id, companyId: company.id, cost, coins: Number(character.coins) - cost };
  });
}

function legDuration(instance, fromId, toId, cls) {
  const from = instance.portsById.get(fromId);
  const to = instance.portsById.get(toId);
  if (!from || !to) return 10 * 60_000;
  const distance = dist(from.x, from.y, to.x, to.y);
  // Real seconds, from the ship's real speed, at a two-thirds cruise.
  return Math.max(60_000, (distance / (cls.speed * 0.66)) * 1000);
}

export async function deleteRoute({ characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const route = await tx.get(`
      SELECT r.* FROM trade_routes r JOIN companies c ON c.id = r.company_id
      WHERE r.id = ? AND c.character_id = ?`, [payload.routeId, characterId]);
    if (!route) throw new HttpError(404, 'error.notFound');

    const cls = shipClass(route.ship_class);
    // Selling the route's ship returns part of what it cost.
    const refund = Math.round(cls.price * 0.5);
    await tx.run('UPDATE characters SET coins = coins + ? WHERE id = ?', [refund, characterId]);
    await tx.run('DELETE FROM trade_routes WHERE id = ?', [route.id]);
    return { routeId: route.id, refund };
  });
}

/**
 * Advance automated routes. Each arrival buys at the origin and sells at the
 * destination using the *same* market functions a player would, so an NPC
 * route moves prices exactly as a player would.
 */
export async function stepRoutes(instance) {
  const db = getDatabase();
  const due = await db.all(`
    SELECT r.*, c.character_id, c.id AS company_id
    FROM trade_routes r JOIN companies c ON c.id = r.company_id
    WHERE c.world_id = ? AND r.status = 'running' AND r.next_arrival_at <= ?`,
  [instance.id, Date.now()]);
  if (due.length === 0) return 0;

  const { applyTrade, derivePrice } = await import('./economy.js');

  for (const route of due) {
    const waypoints = JSON.parse(route.waypoints || '[]');
    if (waypoints.length < 2) continue;
    const cls = shipClass(route.ship_class);
    const fromId = waypoints[Number(route.leg_index) % waypoints.length];
    const toId = waypoints[(Number(route.leg_index) + 1) % waypoints.length];

    await db.tx(async (tx) => {
      const plan = JSON.parse(route.cargo_plan || '[]');
      let profit = 0;

      for (const entry of plan.slice(0, 4)) {
        const good = goodById(Number(entry.goodId));
        if (!good) continue;
        const qty = Math.max(1, Math.min(Number(entry.qty) || 1, cls.cargo));

        const source = await tx.get(
          'SELECT * FROM port_market WHERE world_id = ? AND port_id = ? AND good_id = ?',
          [instance.id, fromId, good.id]);
        const target = await tx.get(
          'SELECT * FROM port_market WHERE world_id = ? AND port_id = ? AND good_id = ?',
          [instance.id, toId, good.id]);
        if (!source || Number(source.stock) < qty + 1) continue;

        const buyPrice = derivePrice(good, {
          stock: Number(source.stock), baseStock: Number(source.base_stock), demand: Number(source.demand),
        }) * (1 + good.spread);
        const sellPrice = target
          ? derivePrice(good, {
            stock: Number(target.stock), baseStock: Number(target.base_stock), demand: Number(target.demand),
          }) * (1 - good.spread)
          : good.price * 0.6;

        profit += Math.round((sellPrice - buyPrice) * qty);
        await applyTrade(tx, instance, fromId, good.id, -qty);
        if (target) await applyTrade(tx, instance, toId, good.id, qty);
      }

      // Running costs: crew and upkeep come off the top.
      const upkeep = Math.round(cls.repairCost * 1.5);
      profit -= upkeep;

      await tx.run('UPDATE characters SET coins = coins + ? WHERE id = ?', [profit, route.character_id]);
      await tx.run(
        'UPDATE trade_routes SET leg_index = ?, next_arrival_at = ?, total_profit = total_profit + ?, runs = runs + 1 WHERE id = ?',
        [(Number(route.leg_index) + 1) % waypoints.length,
          Date.now() + legDuration(instance, toId, waypoints[(Number(route.leg_index) + 2) % waypoints.length] ?? fromId, cls),
          profit, route.id]);
    });
  }
  return due.length;
}

export async function routesFor(characterId) {
  const db = getDatabase();
  const rows = await db.all(`
    SELECT r.* FROM trade_routes r JOIN companies c ON c.id = r.company_id
    WHERE c.character_id = ? ORDER BY r.created_at`, [characterId]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    shipClass: row.ship_class,
    waypoints: JSON.parse(row.waypoints || '[]'),
    cargoPlan: JSON.parse(row.cargo_plan || '[]'),
    status: row.status,
    legIndex: Number(row.leg_index),
    nextArrivalAt: row.next_arrival_at ? Number(row.next_arrival_at) : null,
    totalProfit: Number(row.total_profit),
    runs: Number(row.runs),
  }));
}


export async function buildOutpost({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (character.docked === 1) throw fail('error.validation', 'build from the water, not from a berth');

    // Outposts go on uncharted islands: that is what makes discovery valuable.
    const { nearestAnchorage } = await import('./exploration.js');
    const found = nearestAnchorage(instance, Number(character.x), Number(character.y));
    if (!found) throw fail('error.tooFar', 'no landing beach within reach');

    const existing = await tx.get('SELECT id FROM outposts WHERE world_id = ? AND island_id = ?',
      [instance.id, found.anchorage.islandId]);
    if (existing) throw new HttpError(409, 'error.conflict', 'this island already has an outpost');

    if (Number(character.coins) < OUTPOST_COST) throw fail('trade.notEnoughCoins');

    const guild = await tx.get('SELECT guild_id FROM guild_members WHERE character_id = ?', [characterId]);
    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [OUTPOST_COST, characterId]);
    const id = await tx.insert('outposts', {
      world_id: instance.id, owner_id: characterId,
      guild_id: guild?.guild_id ?? null, island_id: found.anchorage.islandId,
      name: String(payload.name ?? `${character.name}'s Outpost`).slice(0, 40),
      x: found.anchorage.x, y: found.anchorage.y, created_at: Date.now(),
    });
    await audit({ userId }, 'outpost.build', 'outpost', String(id),
      { islandId: found.anchorage.islandId }, { db: tx });

    return { outpostId: id, cost: OUTPOST_COST, coins: Number(character.coins) - OUTPOST_COST };
  });
}

export async function buildBuilding({ characterId, userId, payload }) {
  const kind = String(payload.kind ?? '');
  const cost = BUILDING_COST[kind];
  if (!cost) throw fail('error.validation', 'unknown building');

  const db = getDatabase();
  return db.tx(async (tx) => {
    const outpost = await tx.get('SELECT * FROM outposts WHERE id = ? AND owner_id = ?',
      [payload.outpostId, characterId]);
    if (!outpost) throw new HttpError(404, 'error.notFound');

    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');

    const existing = await tx.get('SELECT * FROM outpost_buildings WHERE outpost_id = ? AND kind = ?',
      [outpost.id, kind]);
    const level = existing ? Number(existing.level) : 0;
    const price = buildingCost(kind, level);
    if (Number(character.coins) < price) throw fail('trade.notEnoughCoins');

    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [price, characterId]);
    if (existing) {
      await tx.run('UPDATE outpost_buildings SET level = ? WHERE id = ?', [level + 1, existing.id]);
    } else {
      await tx.insert('outpost_buildings', {
        outpost_id: outpost.id, kind, level: 1, built_at: Date.now(),
      });
    }
    return { outpostId: outpost.id, kind, level: level + 1, cost: price };
  });
}

export async function outpostsFor(worldId, characterId = null) {
  const db = getDatabase();
  const rows = characterId
    ? await db.all('SELECT * FROM outposts WHERE world_id = ? AND owner_id = ?', [worldId, characterId])
    : await db.all('SELECT * FROM outposts WHERE world_id = ?', [worldId]);

  const out = [];
  for (const row of rows) {
    const buildings = await db.all('SELECT kind, level FROM outpost_buildings WHERE outpost_id = ?', [row.id]);
    out.push({
      id: row.id, name: row.name, islandId: Number(row.island_id),
      x: Number(row.x), y: Number(row.y), ownerId: row.owner_id, guildId: row.guild_id,
      buildings: buildings.map((building) => ({ kind: building.kind, level: Number(building.level) })),
      createdAt: Number(row.created_at),
    });
  }
  return out;
}

export { OUTPOST_COST, BUILDING_COST, COMMISSION };
