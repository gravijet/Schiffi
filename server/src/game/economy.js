/**
 * Market simulation.
 *
 * Prices are *derived*, never stored as an opaque number: every port keeps a
 * stock level and a daily demand, and the price falls out of the ratio between
 * them.  That makes the whole economy explainable - a good is expensive here
 * because this port consumes it and does not produce it - and it makes player
 * trading matter, because buying really does move the stock.
 *
 * Manipulation guards:
 *   - a single transaction can move a price by at most MAX_TRADE_IMPACT
 *   - stock reverts towards its baseline every tick, so a corner is temporary
 *   - the price is clamped to a band around the base price and never negative
 */
import { allGoods, goodById } from '@schiffi/shared/data/goods.js';
import { FACTION_BY_KEY, isContraband, tariffFor, repTier } from '@schiffi/shared/data/factions.js';
import { Rng, hashCombine, seedFromString } from '@schiffi/shared/util/rng.js';
import { clamp } from '@schiffi/shared/util/math.js';
import { getDatabase } from '../db/index.js';

/** Price elasticity: how hard scarcity pushes the price. */
const ELASTICITY = 0.55;
/** Hard band around the base price, whatever the stock does. */
const PRICE_FLOOR = 0.28;
const PRICE_CEILING = 4.0;
/** A single trade may not move the price by more than this fraction. */
const MAX_TRADE_IMPACT = 0.22;
/** Fraction of the gap to baseline that stock recovers per simulated hour. */
const REVERSION_PER_HOUR = 0.06;

const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

/** How many distinct goods a port of each size trades. */
const GOODS_PER_SIZE = [22, 38, 58, 84, 120];

/**
 * Pick the goods a port trades and whether it produces them.
 * Deterministic in (worldSeed, portId), so a port's character is stable.
 */
export function portGoods(worldSeed, port) {
  const rng = new Rng(hashCombine(worldSeed, seedFromString(port.id)));
  const catalogue = allGoods();
  const count = GOODS_PER_SIZE[Math.min(port.size, GOODS_PER_SIZE.length - 1)];
  const faction = FACTION_BY_KEY.get(port.factionKey);

  // Weight each good for this port: climate match makes it a local product,
  // faction preference makes it worth stocking, rarity makes it scarce.
  const weights = catalogue.map((good) => {
    const local = good.clim.length === 0 || good.clim.includes(port.climate);
    let w = local ? 3.0 : 1.0;
    if (faction?.favours.includes('*') || faction?.favours.includes(good.cat)) w *= 1.6;
    if (faction?.dislikes.includes(good.cat)) w *= 0.35;
    if (isContraband(port.factionKey, good)) w *= 0.12;      // black market only
    w *= [1.0, 0.75, 0.5, 0.28, 0.12][good.rare];
    w *= 0.5 + port.size * 0.22;                              // big ports carry more
    return w;
  });

  const chosen = new Map();
  let guard = 0;
  while (chosen.size < count && guard++ < count * 12) {
    const good = rng.pickWeighted(catalogue, weights);
    if (chosen.has(good.id)) continue;
    const produced = (good.clim.length === 0 || good.clim.includes(port.climate)) && rng.chance(0.55);
    chosen.set(good.id, { good, produced });
  }
  return [...chosen.values()];
}

/** Baseline stock and demand for a good in a port. */
function baselineFor(good, port, produced, rng) {
  const sizeFactor = 0.6 + port.size * 0.55;
  const rarityFactor = [1.0, 0.7, 0.45, 0.25, 0.1][good.rare];
  const base = 80 * sizeFactor * rarityFactor * rng.range(0.7, 1.35);

  return {
    baseStock: Math.max(4, Math.round(produced ? base * 2.4 : base * 0.55)),
    demand: Math.max(1, Math.round(base * (produced ? 0.25 : 0.9) * rng.range(0.7, 1.3))),
  };
}

/**
 * Derive the market price from stock, demand and modifiers.
 * Never returns a value below 1 coin.
 */
export function derivePrice(good, { stock, baseStock, demand }, modifiers = {}) {
  const supplyRatio = baseStock / Math.max(1, stock);
  const demandPressure = demand / Math.max(1, baseStock * 0.5);
  const scarcity = Math.pow(supplyRatio * (0.6 + demandPressure * 0.4), ELASTICITY);

  let price = good.price * clamp(scarcity, PRICE_FLOOR, PRICE_CEILING);
  price *= modifiers.season ?? 1;
  price *= modifiers.event ?? 1;
  price *= modifiers.faction ?? 1;
  price *= modifiers.region ?? 1;
  return Math.max(1, price);
}

/** Season multipliers per category - drives the annual trade rhythm. */
export function seasonMultiplier(good, season) {
  const name = SEASONS[season % 4];
  switch (good.cat) {
    case 'grain': return name === 'autumn' ? 0.78 : name === 'spring' ? 1.22 : 1.0;
    case 'produce': return name === 'summer' ? 0.82 : name === 'winter' ? 1.28 : 1.0;
    case 'seafood': return name === 'winter' ? 1.18 : 0.94;
    case 'fuel': return name === 'winter' ? 1.35 : name === 'summer' ? 0.85 : 1.0;
    case 'timber': return name === 'winter' ? 1.12 : 1.0;
    case 'textile': return name === 'autumn' ? 1.10 : 1.0;
    case 'medicine': return name === 'winter' ? 1.15 : 1.0;
    default: return 1.0;
  }
}

/** Populate port_market for a freshly created world. */
export async function seedMarketsForWorld(instance) {
  const db = getDatabase();
  const now = Date.now();
  let rows = 0;

  await db.tx(async (tx) => {
    for (const port of instance.world.ports) {
      const rng = new Rng(hashCombine(instance.seed, seedFromString(port.id), 0x570c));
      for (const { good, produced } of portGoods(instance.seed, port)) {
        const { baseStock, demand } = baselineFor(good, port, produced, rng);
        const stock = Math.max(1, Math.round(baseStock * rng.range(0.7, 1.3)));
        const price = derivePrice(good, { stock, baseStock, demand });
        await tx.insert('port_market', {
          world_id: instance.id, port_id: port.id, good_id: good.id,
          stock, base_stock: baseStock, demand,
          price, produced: produced ? 1 : 0, updated_at: now,
        });
        rows++;
      }
    }
  });
  console.log(`[economy] seeded ${rows} market rows for world ${instance.id}`);
  return rows;
}

/** The tradable goods of one port, with buy and sell prices for a character. */
export async function marketFor(instance, portId, character = null) {
  const db = getDatabase();
  const port = instance.portsById.get(portId);
  if (!port) return null;

  const rows = await db.all(
    'SELECT * FROM port_market WHERE world_id = ? AND port_id = ?', [instance.id, portId]);
  const reputation = character ? await reputationMap(character.id) : new Map();
  const rep = reputation.get(port.factionKey) ?? 0;
  const tier = repTier(rep);

  return {
    portId,
    faction: port.factionKey,
    reputation: rep,
    reputationTier: tier.key,
    goods: rows.map((row) => {
      const good = goodById(Number(row.good_id));
      if (!good) return null;
      const price = derivePrice(good, {
        stock: Number(row.stock), baseStock: Number(row.base_stock), demand: Number(row.demand),
      }, {
        season: seasonMultiplier(good, instance.season ?? 0),
        faction: tier.priceMul,
        event: eventMultiplier(instance, portId, good),
      });
      const contraband = isContraband(port.factionKey, good);
      const tariff = tariffFor(port.factionKey, good, rep);

      return {
        id: good.id,
        key: good.key,
        cat: good.cat,
        rare: good.rare,
        perish: good.perish,
        weight: good.weight,
        vol: good.vol,
        stock: Math.floor(Number(row.stock)),
        produced: row.produced === 1,
        buy: Math.max(1, Math.round(price * (1 + good.spread) * (1 + tariff))),
        sell: Math.max(1, Math.round(price * (1 - good.spread))),
        price: Math.round(price),
        contraband,
        tariff: Math.round(tariff * 1000) / 1000,
      };
    }).filter(Boolean),
  };
}

/** Active admin/world events that touch this port or good. */
function eventMultiplier(instance, portId, good) {
  let mul = 1;
  for (const event of instance.activeEvents ?? []) {
    const effects = event.effects ?? {};
    if (event.port_id && event.port_id !== portId) continue;
    if (effects.category && effects.category !== good.cat) continue;
    if (effects.goodKey && effects.goodKey !== good.baseKey && effects.goodKey !== good.key) continue;
    if (typeof effects.priceMultiplier === 'number') mul *= effects.priceMultiplier;
  }
  return clamp(mul, 0.2, 6);
}

export async function reputationMap(characterId) {
  const db = getDatabase();
  const rows = await db.all('SELECT faction_key, value FROM reputation WHERE character_id = ?', [characterId]);
  return new Map(rows.map((r) => [r.faction_key, Number(r.value)]));
}

/**
 * Apply a trade to the market.
 *
 * `delta` is the change in port stock: negative when the player buys.  The
 * resulting price movement is capped so a single large order cannot be used to
 * teleport a price, and the caller's coin movement is computed from the *same*
 * numbers, inside the same transaction.
 */
export async function applyTrade(tx, instance, portId, goodId, delta) {
  const row = await tx.get(
    'SELECT * FROM port_market WHERE world_id = ? AND port_id = ? AND good_id = ?',
    [instance.id, portId, goodId]);
  if (!row) return null;

  const good = goodById(goodId);
  const baseStock = Number(row.base_stock);
  const before = Number(row.stock);
  const after = Math.max(1, before + delta);

  const priceBefore = derivePrice(good, { stock: before, baseStock, demand: Number(row.demand) });
  let priceAfter = derivePrice(good, { stock: after, baseStock, demand: Number(row.demand) });

  // Cap the per-trade move: the stock still changes, but the quoted price
  // cannot swing more than MAX_TRADE_IMPACT in one go.
  const maxUp = priceBefore * (1 + MAX_TRADE_IMPACT);
  const maxDown = priceBefore * (1 - MAX_TRADE_IMPACT);
  priceAfter = clamp(priceAfter, maxDown, maxUp);

  await tx.run(
    'UPDATE port_market SET stock = ?, price = ?, updated_at = ? WHERE world_id = ? AND port_id = ? AND good_id = ?',
    [after, priceAfter, Date.now(), instance.id, portId, goodId]);

  return { stockBefore: before, stockAfter: after, priceBefore, priceAfter };
}

/**
 * Hourly market step: consume demand, produce local goods, revert towards the
 * baseline and record a price sample for the history chart.
 */
export async function stepMarkets(instance, hours = 1) {
  const db = getDatabase();
  const now = Date.now();
  const rows = await db.all('SELECT * FROM port_market WHERE world_id = ?', [instance.id]);
  if (rows.length === 0) return 0;

  const rng = new Rng(hashCombine(instance.seed, instance.tick | 0));
  await db.tx(async (tx) => {
    for (const row of rows) {
      const good = goodById(Number(row.good_id));
      if (!good) continue;
      const baseStock = Number(row.base_stock);
      const demand = Number(row.demand);
      let stock = Number(row.stock);

      // Production and consumption, then mean reversion towards the baseline.
      const production = row.produced === 1 ? demand * 1.35 : demand * 0.25;
      stock += (production - demand * rng.range(0.85, 1.15)) * hours;
      stock += (baseStock - stock) * REVERSION_PER_HOUR * hours;
      stock = Math.max(1, stock);

      const price = derivePrice(good, { stock, baseStock, demand }, {
        season: seasonMultiplier(good, instance.season ?? 0),
        event: eventMultiplier(instance, row.port_id, good),
      });
      await tx.run(
        'UPDATE port_market SET stock = ?, price = ?, updated_at = ? ' +
        'WHERE world_id = ? AND port_id = ? AND good_id = ?',
        [stock, price, now, instance.id, row.port_id, row.good_id]);
    }
  });
  return rows.length;
}

/** Sample prices into price_history; called once per simulated hour. */
export async function recordPriceHistory(instance) {
  const db = getDatabase();
  const now = Date.now();
  const rows = await db.all('SELECT port_id, good_id, price FROM port_market WHERE world_id = ?', [instance.id]);
  await db.tx(async (tx) => {
    for (const row of rows) {
      await tx.insert('price_history', {
        world_id: instance.id, port_id: row.port_id, good_id: row.good_id,
        at: now, price: row.price,
      });
    }
    // Keep a week of samples; older rows only cost space.
    await tx.run('DELETE FROM price_history WHERE world_id = ? AND at < ?',
      [instance.id, now - 7 * 86_400_000]);
  });
  return rows.length;
}

/** Price statistics for one good in one port: current, average, trend, range. */
export async function priceStats(instance, portId, goodId) {
  const db = getDatabase();
  const now = Date.now();
  const day = now - 86_400_000;
  const week = now - 7 * 86_400_000;

  const current = await db.get(
    'SELECT price FROM port_market WHERE world_id = ? AND port_id = ? AND good_id = ?',
    [instance.id, portId, goodId]);
  const samples = await db.all(
    'SELECT at, price FROM price_history WHERE world_id = ? AND port_id = ? AND good_id = ? AND at > ? ORDER BY at',
    [instance.id, portId, goodId, week]);

  const dayValues = samples.filter((s) => Number(s.at) >= day).map((s) => Number(s.price));
  const weekValues = samples.map((s) => Number(s.price));
  const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

  return {
    current: current ? Math.round(Number(current.price)) : null,
    average24h: round(avg(dayValues)),
    average7d: round(avg(weekValues)),
    min7d: weekValues.length ? Math.round(Math.min(...weekValues)) : null,
    max7d: weekValues.length ? Math.round(Math.max(...weekValues)) : null,
    trend24h: trend(dayValues),
    trend7d: trend(weekValues),
    samples: samples.map((s) => ({ at: Number(s.at), price: Math.round(Number(s.price)) })),
  };
}

function trend(values) {
  if (values.length < 2) return 0;
  const first = values[0];
  const last = values[values.length - 1];
  if (!first) return 0;
  return Math.round(((last - first) / first) * 1000) / 10; // percent, one decimal
}

function round(value) {
  return value === null ? null : Math.round(value);
}
