/**
 * The world's slower machinery: warehouses, rumours, buried treasure,
 * faction politics and the seasonal ledger.
 *
 * These all share a property that separates them from the trading loop: they
 * change on their own, on a clock, whether or not anybody is watching. Every
 * one of them is backed by a table that was already in the schema; until now
 * none of them had any code, which meant the tables stayed empty and the parts
 * of the interface that would show them had nothing to show.
 */
import { getDatabase } from '../db/index.js';
import { HttpError } from '../http/respond.js';
import { Rng, hashCombine } from '@schiffi/shared/util/rng.js';
import { dist } from '@schiffi/shared/util/math.js';
import { goodById, allGoods } from '@schiffi/shared/data/goods.js';
import { FACTIONS, baseRelation } from '@schiffi/shared/data/factions.js';
import { CELL_SIZE } from '@schiffi/shared/world/constants.js';
import { WAREHOUSE_BASE_CAPACITY, WAREHOUSE_DEPOSIT, warehouseRent }
  from '@schiffi/shared/data/costs.js';
import { addCargo, removeCargo, cargoUsage } from './characters.js';
import { awardXp } from './progression.js';
import { audit } from '../services/audit.js';

const fail = (code, message = code) => new HttpError(400, code, message);

// ---------------------------------------------------------------------------
// warehouses
// ---------------------------------------------------------------------------

// Rent and deposit are shared with the client, so the button can name the
// price it is about to charge.
export { WAREHOUSE_BASE_CAPACITY, WAREHOUSE_DEPOSIT, warehouseRent };

/** Rent storage in the port the ship is lying in. */
export async function rentWarehouse({ instance, characterId, userId, payload }) {
  const capacity = Math.min(1000, Math.max(50, Math.floor(Number(payload.capacity ?? WAREHOUSE_BASE_CAPACITY))));
  const db = getDatabase();

  return db.tx(async (tx) => {
    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (!character) throw new HttpError(404, 'error.notFound');
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (character.docked !== 1) throw fail('error.notInPort');

    const port = instance.portsById.get(character.current_port_id);
    if (!port) throw fail('error.notInPort');
    if (port.size < 2) throw fail('error.validation', 'this port has no warehouse to let');

    const existing = await tx.get('SELECT * FROM warehouses WHERE character_id = ? AND port_id = ?',
      [characterId, port.id]);
    const rent = warehouseRent(capacity);

    if (existing) {
      // Resizing costs the difference in deposit, and never refunds downward:
      // the lease is with the port, not with the player.
      const extra = Math.max(0, capacity - Number(existing.capacity));
      const cost = Math.round(extra * (WAREHOUSE_DEPOSIT / WAREHOUSE_BASE_CAPACITY));
      if (Number(character.coins) < cost) throw fail('trade.notEnoughCoins');
      if (cost > 0) await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [cost, characterId]);
      await tx.run('UPDATE warehouses SET capacity = ?, rent_per_day = ? WHERE id = ?',
        [Math.max(capacity, Number(existing.capacity)), rent, existing.id]);
      return { warehouseId: existing.id, capacity, rentPerDay: rent, cost };
    }

    if (Number(character.coins) < WAREHOUSE_DEPOSIT) throw fail('trade.notEnoughCoins');
    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [WAREHOUSE_DEPOSIT, characterId]);
    const id = await tx.insert('warehouses', {
      character_id: characterId, port_id: port.id, capacity,
      rent_per_day: rent, rent_due_at: instance.gameTimeMs + 24 * 3_600_000,
    });
    return { warehouseId: id, capacity, rentPerDay: rent, cost: WAREHOUSE_DEPOSIT };
  });
}

/** Move goods between the hold and the warehouse in this port. */
export async function storeGoods({ instance, characterId, userId, payload }) {
  const goodId = Number(payload.goodId);
  const qty = Math.floor(Number(payload.qty));
  const toShip = payload.direction === 'load';
  const good = goodById(goodId);
  if (!good || !Number.isFinite(qty) || qty <= 0) throw fail('error.validation');

  const db = getDatabase();
  return db.tx(async (tx) => {
    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (!character) throw new HttpError(404, 'error.notFound');
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (character.docked !== 1) throw fail('error.notInPort');

    const warehouse = await tx.get('SELECT * FROM warehouses WHERE character_id = ? AND port_id = ?',
      [characterId, character.current_port_id]);
    if (!warehouse) throw fail('warehouse.none');

    if (toShip) {
      const lot = await tx.get(
        'SELECT * FROM warehouse_cargo WHERE warehouse_id = ? AND good_id = ? ORDER BY freshness ASC',
        [warehouse.id, goodId]);
      if (!lot || Number(lot.qty) < qty) throw fail('trade.nothingToSell');

      const { used } = await cargoUsage(character.active_ship_id, tx);
      const player = instance.players.get(`p${characterId}`);
      const capacity = player?.stats?.cargo ?? 0;
      if (used + good.vol * qty > capacity) throw fail('market.noSpace');

      if (Number(lot.qty) === qty) await tx.run('DELETE FROM warehouse_cargo WHERE id = ?', [lot.id]);
      else await tx.run('UPDATE warehouse_cargo SET qty = ? WHERE id = ?', [Number(lot.qty) - qty, lot.id]);
      await addCargo(tx, character.active_ship_id, goodId, qty, good.price, Number(lot.freshness));
      return { direction: 'load', goodId, qty };
    }

    const stored = await tx.get('SELECT SUM(qty) AS n FROM warehouse_cargo WHERE warehouse_id = ?',
      [warehouse.id]);
    if (Number(stored?.n ?? 0) + qty > Number(warehouse.capacity)) throw fail('warehouse.full');

    const { removed, freshness } = await removeCargo(tx, character.active_ship_id, goodId, qty);
    if (removed < qty) throw fail('trade.nothingToSell');

    const band = Math.round(freshness * 20) / 20;
    const existing = await tx.get(
      'SELECT * FROM warehouse_cargo WHERE warehouse_id = ? AND good_id = ? ' +
      'AND freshness >= ? AND freshness <= ?',
      [warehouse.id, goodId, band - 0.025, band + 0.025]);
    if (existing) {
      await tx.run('UPDATE warehouse_cargo SET qty = ? WHERE id = ?',
        [Number(existing.qty) + qty, existing.id]);
    } else {
      await tx.insert('warehouse_cargo', {
        warehouse_id: warehouse.id, good_id: goodId, qty, freshness: band,
      });
    }
    return { direction: 'store', goodId, qty };
  });
}

export async function warehousesFor(characterId) {
  const db = getDatabase();
  const rows = await db.all('SELECT * FROM warehouses WHERE character_id = ?', [characterId]);
  const out = [];
  for (const row of rows) {
    const cargo = await db.all(
      'SELECT good_id, qty, freshness FROM warehouse_cargo WHERE warehouse_id = ?', [row.id]);
    out.push({
      id: row.id, portId: row.port_id,
      capacity: Number(row.capacity), rentPerDay: Number(row.rent_per_day),
      rentDueAt: row.rent_due_at ? Number(row.rent_due_at) : null,
      used: cargo.reduce((sum, lot) => sum + Number(lot.qty), 0),
      cargo: cargo.map((lot) => ({
        goodId: Number(lot.good_id), qty: Number(lot.qty), freshness: Number(lot.freshness),
      })),
    });
  }
  return out;
}

/**
 * Collect rent, once per game day.
 *
 * A tenant who cannot pay loses goods to the value of the arrears rather than
 * the lease: the port would rather have the cargo than an empty vault.
 */
export async function collectRent(instance) {
  const db = getDatabase();
  const due = await db.all('SELECT * FROM warehouses WHERE rent_due_at IS NOT NULL AND rent_due_at <= ?',
    [instance.gameTimeMs]);

  for (const warehouse of due) {
    await db.tx(async (tx) => {
      const rent = Number(warehouse.rent_per_day);
      const character = await tx.get('SELECT * FROM characters WHERE id = ?', [warehouse.character_id]);
      if (!character) return;

      if (Number(character.coins) >= rent) {
        await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [rent, character.id]);
      } else {
        let owed = rent;
        const lots = await tx.all(
          'SELECT * FROM warehouse_cargo WHERE warehouse_id = ? ORDER BY qty DESC', [warehouse.id]);
        for (const lot of lots) {
          if (owed <= 0) break;
          const price = Math.max(1, goodById(Number(lot.good_id))?.price ?? 1);
          const take = Math.min(Number(lot.qty), Math.ceil(owed / price));
          owed -= take * price;
          if (take >= Number(lot.qty)) await tx.run('DELETE FROM warehouse_cargo WHERE id = ?', [lot.id]);
          else await tx.run('UPDATE warehouse_cargo SET qty = ? WHERE id = ?', [Number(lot.qty) - take, lot.id]);
        }
      }
      await tx.run('UPDATE warehouses SET rent_due_at = ? WHERE id = ?',
        [instance.gameTimeMs + 24 * 3_600_000, warehouse.id]);
    });
  }
  return due.length;
}

// ---------------------------------------------------------------------------
// rumours
// ---------------------------------------------------------------------------

const RUMOUR_TTL_MS = 8 * 3_600_000;
const RUMOURS_PER_PORT = 3;

/**
 * Refresh the talk in a port's taverns.
 *
 * A rumour points at something that is really there - a price, an uncharted
 * island, a wreck - but its `truth` says how likely it is to be right, and a
 * false one points somewhere real too, just not where it claims. Buying one
 * writes it into the buyer's chart.
 */
export async function refreshRumours(instance, port) {
  const db = getDatabase();
  const now = Date.now();
  await db.run('DELETE FROM rumours WHERE world_id = ? AND port_id = ? AND expires_at <= ?',
    [instance.id, port.id, now]);

  const open = await db.get('SELECT COUNT(*) AS n FROM rumours WHERE world_id = ? AND port_id = ?',
    [instance.id, port.id]);
  const missing = RUMOURS_PER_PORT - Number(open?.n ?? 0);
  if (missing <= 0) return;

  const rng = new Rng(hashCombine(instance.seed, Math.floor(now / RUMOUR_TTL_MS), port.id.length));
  for (let i = 0; i < missing; i++) {
    const rumour = await inventRumour(instance, port, rng);
    if (!rumour) continue;
    await db.insert('rumours', {
      world_id: instance.id, port_id: port.id, kind: rumour.kind,
      data: JSON.stringify(rumour.data), price: rumour.price,
      truth: rumour.truth, created_at: now, expires_at: now + RUMOUR_TTL_MS,
    });
  }
}

async function inventRumour(instance, port, rng) {
  const db = getDatabase();
  const kind = rng.pick(['price', 'island', 'wreck', 'danger']);
  // How reliable the talk is. A tavern is not a chart house.
  const truth = Math.round(rng.range(0.45, 1) * 100) / 100;

  switch (kind) {
    case 'price': {
      const rows = await db.all(
        'SELECT good_id, price FROM port_market WHERE world_id = ? ORDER BY price DESC LIMIT 40',
        [instance.id]);
      if (!rows.length) return null;
      const row = rng.pick(rows);
      const target = instance.world.ports[rng.int(0, instance.world.ports.length - 1)];
      return {
        kind, truth, price: rng.int(40, 160),
        data: { goodId: Number(row.good_id), portId: target.id, portName: target.name,
          price: Math.round(Number(row.price)) },
      };
    }
    case 'island': {
      const uncharted = instance.world.islands.filter((island) => island.undiscovered);
      if (!uncharted.length) return null;
      const island = rng.pick(uncharted);
      // A false rumour still points at real water, just the wrong stretch.
      const spread = truth > 0.75 ? 1200 : 6000;
      return {
        kind, truth, price: rng.int(180, 700),
        data: {
          islandId: island.id,
          x: Math.round(island.cx * CELL_SIZE + rng.range(-spread, spread)),
          y: Math.round(island.cy * CELL_SIZE + rng.range(-spread, spread)),
          radius: Math.round(spread),
        },
      };
    }
    case 'wreck': {
      const wrecks = instance.wrecks ?? [];
      if (!wrecks.length) return null;
      const wreck = rng.pick(wrecks);
      return {
        kind, truth, price: rng.int(90, 380),
        data: { x: Math.round(wreck.x), y: Math.round(wreck.y), radius: 900 },
      };
    }
    default: {
      const region = rng.pick(instance.world.regions);
      return {
        kind, truth, price: rng.int(30, 120),
        data: { regionId: region.id, regionName: region.name, hazard: region.hazardName },
      };
    }
  }
}

export async function rumoursFor(instance, portId) {
  const port = instance.portsById.get(portId);
  if (!port) throw new HttpError(404, 'error.notFound');
  await refreshRumours(instance, port);

  const db = getDatabase();
  const rows = await db.all(
    'SELECT * FROM rumours WHERE world_id = ? AND port_id = ? AND expires_at > ? ORDER BY price',
    [instance.id, portId, Date.now()]);
  return rows.map((row) => ({
    id: row.id, kind: row.kind, price: Number(row.price),
    // The buyer is told how sure the teller sounds, not the truth value: that
    // is the gamble, and it is the same number the outcome is rolled against.
    confidence: Number(row.truth) > 0.75 ? 'sure' : Number(row.truth) > 0.55 ? 'likely' : 'doubtful',
    expiresAt: Number(row.expires_at),
  }));
}

/** Pay for a rumour; it lands in the buyer's chart. */
export async function buyRumour({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const rumour = await tx.get('SELECT * FROM rumours WHERE id = ? AND world_id = ?',
      [payload.rumourId, instance.id]);
    if (!rumour || Number(rumour.expires_at) <= Date.now()) throw new HttpError(404, 'error.notFound');

    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (character.docked !== 1 || character.current_port_id !== rumour.port_id) throw fail('error.notInPort');
    if (Number(character.coins) < Number(rumour.price)) throw fail('trade.notEnoughCoins');

    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?',
      [Number(rumour.price), characterId]);

    const data = JSON.parse(rumour.data || '{}');
    const now = Date.now();
    await tx.insert('charts', {
      character_id: characterId, world_id: instance.id, kind: rumour.kind,
      // ref_id is the historical key of the thing pointed at; the payload in
      // `data` is what a rumour actually needs to be useful.
      ref_id: String(data.islandId ?? data.portId ?? data.regionId ?? rumour.id),
      data: JSON.stringify({ ...data, truth: Number(rumour.truth) }),
      source: 'rumour', acquired_at: now, created_at: now,
    });
    await tx.run('DELETE FROM rumours WHERE id = ?', [rumour.id]);
    await awardXp(tx, characterId, 15);

    return { kind: rumour.kind, data, truth: Number(rumour.truth), paid: Number(rumour.price) };
  });
}

/** Everything this character has charted or been told. */
export async function chartsFor(characterId) {
  const db = getDatabase();
  const rows = await db.all(
    'SELECT * FROM charts WHERE character_id = ? ORDER BY created_at DESC LIMIT 200', [characterId]);
  return rows.map((row) => ({
    id: row.id, kind: row.kind, source: row.source,
    data: JSON.parse(row.data || '{}'), createdAt: Number(row.created_at),
  }));
}

// ---------------------------------------------------------------------------
// buried treasure
// ---------------------------------------------------------------------------

/**
 * Seed buried treasure across the world's islands.
 *
 * A treasure is a real row at a real place; a treasure map points at it, and
 * digging there is what finds it. Deterministic from the seed, so the same
 * world always hides the same hoards.
 */
export async function seedTreasures(instance) {
  const db = getDatabase();
  const existing = await db.get('SELECT COUNT(*) AS n FROM treasures WHERE world_id = ?', [instance.id]);
  if (Number(existing?.n ?? 0) > 0) return 0;

  const rng = new Rng(hashCombine(instance.seed, 0x7ea5));
  const goods = allGoods().filter((good) => good.price > 200);
  const islands = instance.world.islands.filter((island) => island.area >= 12);
  let planted = 0;

  for (const island of islands) {
    if (!rng.chance(0.22)) continue;
    const contents = [];
    const lots = rng.int(1, 3);
    for (let i = 0; i < lots; i++) {
      const good = rng.pick(goods);
      contents.push({ goodId: good.id, qty: rng.int(1, 4) });
    }
    await db.insert('treasures', {
      world_id: instance.id, island_id: island.id,
      x: island.cx * CELL_SIZE + rng.range(-40, 40),
      y: island.cy * CELL_SIZE + rng.range(-40, 40),
      contents: JSON.stringify(contents),
      created_at: Date.now(),
    });
    planted++;
  }
  return planted;
}

/**
 * Is there still a hoard on this island, and has this captain got its map?
 *
 * Takes an optional handle so it can be called from inside a transaction: the
 * shared handle would wait on the mutex that transaction is holding.
 */
export async function treasureOn(instance, islandId, characterId, handle = null) {
  const db = handle ?? getDatabase();
  const treasure = await db.get(
    'SELECT * FROM treasures WHERE world_id = ? AND island_id = ? AND found_at IS NULL',
    [instance.id, islandId]);
  if (!treasure) return null;

  const chart = await db.get(
    "SELECT id FROM charts WHERE character_id = ? AND kind = 'treasure' AND data LIKE ?",
    [characterId, `%"islandId":${islandId}%`]);
  return { id: treasure.id, hasMap: Boolean(chart) };
}

/** Dig it up. Only works where a hoard actually lies. */
export async function digTreasure({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (!character) throw new HttpError(404, 'error.notFound');
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');

    const treasure = await tx.get(
      'SELECT * FROM treasures WHERE world_id = ? AND id = ? AND found_at IS NULL',
      [instance.id, payload.treasureId]);
    if (!treasure) throw new HttpError(404, 'error.notFound');
    if (dist(Number(treasure.x), Number(treasure.y), Number(character.x), Number(character.y))
      > CELL_SIZE * 6) {
      throw fail('error.tooFar');
    }

    const contents = JSON.parse(treasure.contents || '[]');
    const { used } = await cargoUsage(character.active_ship_id, tx);
    const player = instance.players.get(`p${characterId}`);
    let free = Math.max(0, (player?.stats?.cargo ?? 8) - used);
    const taken = [];

    for (const entry of contents) {
      const good = goodById(Number(entry.goodId));
      if (!good) continue;
      const qty = Math.min(Number(entry.qty), Math.floor(free / good.vol));
      if (qty <= 0) continue;
      await addCargo(tx, character.active_ship_id, good.id, qty, good.price, 1);
      free -= good.vol * qty;
      taken.push({ goodId: good.id, key: good.key, qty });
    }
    if (!taken.length) throw fail('market.noSpace');

    await tx.run('UPDATE treasures SET found_by = ?, found_at = ? WHERE id = ?',
      [characterId, Date.now(), treasure.id]);
    await awardXp(tx, characterId, 250);
    await audit({ userId: character.user_id }, 'explore.treasure_found', 'treasure',
      String(treasure.id), { player: character.name }, { db: tx });

    return { treasureId: treasure.id, taken };
  });
}

// ---------------------------------------------------------------------------
// faction politics
// ---------------------------------------------------------------------------

/** How far relations may drift from where they started. */
const RELATION_DRIFT = 0.06;
const WAR_THRESHOLD = -0.8;
const PEACE_THRESHOLD = -0.55;

/**
 * Let the powers fall out and make up again.
 *
 * Relations drift towards their historic baseline but wander around it, and
 * cross into open war when they sour far enough. War is sticky: it takes a
 * clear improvement to end one, not merely creeping back over the line.
 */
export async function stepPolitics(instance) {
  const db = getDatabase();
  const rows = await db.all('SELECT * FROM faction_relations WHERE world_id = ?', [instance.id]);
  const rng = new Rng(hashCombine(instance.seed, Math.floor(instance.gameTimeMs / 3_600_000)));
  const changes = [];

  for (const row of rows) {
    const base = baseRelation(row.faction_a, row.faction_b);
    const current = Number(row.relation);
    const pull = (base - current) * 0.08;
    const next = Math.max(-1, Math.min(1, current + pull + rng.range(-RELATION_DRIFT, RELATION_DRIFT)));

    const wasAtWar = Number(row.at_war) === 1;
    const atWar = wasAtWar ? next < PEACE_THRESHOLD : next < WAR_THRESHOLD;

    await db.run(
      'UPDATE faction_relations SET relation = ?, at_war = ?, updated_at = ? ' +
      'WHERE world_id = ? AND faction_a = ? AND faction_b = ?',
      [next, atWar ? 1 : 0, Date.now(), instance.id, row.faction_a, row.faction_b]);

    if (atWar !== wasAtWar) changes.push({ a: row.faction_a, b: row.faction_b, atWar });
  }
  return changes;
}

export async function relationsFor(worldId) {
  const db = getDatabase();
  const rows = await db.all('SELECT * FROM faction_relations WHERE world_id = ?', [worldId]);
  return {
    factions: FACTIONS.map((faction) => ({ key: faction.key, colour: faction.colour })),
    relations: rows.map((row) => ({
      a: row.faction_a, b: row.faction_b,
      relation: Math.round(Number(row.relation) * 100) / 100,
      atWar: Number(row.at_war) === 1,
    })),
  };
}

/** Are these two powers at war right now? */
export async function atWar(worldId, a, b) {
  if (a === b) return false;
  const db = getDatabase();
  const row = await db.get(
    'SELECT at_war FROM faction_relations WHERE world_id = ? AND ' +
    '((faction_a = ? AND faction_b = ?) OR (faction_a = ? AND faction_b = ?))',
    [worldId, a, b, b, a]);
  return Number(row?.at_war ?? 0) === 1;
}

// ---------------------------------------------------------------------------
// seasons
// ---------------------------------------------------------------------------

export const SEASON_LENGTH_MS = 30 * 24 * 3_600_000;
const BOARDS = ['wealth', 'level', 'trade', 'discoveries', 'distance'];

/** The season that is running now, opening a new one if the last has ended. */
export async function currentSeason() {
  const db = getDatabase();
  const now = Date.now();
  const open = await db.get('SELECT * FROM seasons WHERE closed_at IS NULL ORDER BY number DESC LIMIT 1');
  if (open && Number(open.ends_at) > now) return describeSeason(open);

  if (open) await closeSeason(open);

  const last = await db.get('SELECT MAX(number) AS n FROM seasons');
  const number = Number(last?.n ?? 0) + 1;
  const id = await db.insert('seasons', {
    number, name: `Saison ${number}`,
    starts_at: now, ends_at: now + SEASON_LENGTH_MS,
  });
  return describeSeason(await db.get('SELECT * FROM seasons WHERE id = ?', [id]));
}

const describeSeason = (row) => ({
  id: row.id, number: Number(row.number), name: row.name,
  startsAt: Number(row.starts_at), endsAt: Number(row.ends_at),
  closedAt: row.closed_at ? Number(row.closed_at) : null,
});

/**
 * Close a season: freeze every board into leaderboard_entries.
 *
 * The live boards are computed from current state, so once the season turns
 * over its standings would be gone. Writing them down is what makes a
 * seasonal ranking mean anything.
 */
export async function closeSeason(season) {
  const db = getDatabase();
  const worlds = await db.all("SELECT id FROM worlds WHERE status <> 'archived'");

  for (const world of worlds) {
    for (const board of BOARDS) {
      const rows = await rankFor(db, world.id, board, 100);
      for (const [index, row] of rows.entries()) {
        await db.insert('leaderboard_entries', {
          season_id: season.id, world_id: world.id, board,
          character_id: row.characterId ?? null, display_name: row.name,
          score: Math.round(row.score), rank: index + 1, updated_at: Date.now(),
        });
      }
    }
  }
  await db.run('UPDATE seasons SET closed_at = ? WHERE id = ?', [Date.now(), season.id]);
  return describeSeason(await db.get('SELECT * FROM seasons WHERE id = ?', [season.id]));
}

/** The live standing for one board. Shared by the live view and the rollover. */
export async function rankFor(db, worldId, board, limit = 25) {
  const queries = {
    wealth: 'SELECT id, name, (coins + bank_balance) AS score FROM characters ' +
      'WHERE world_id = ? AND deleted_at IS NULL ORDER BY score DESC LIMIT ?',
    level: 'SELECT id, name, xp AS score FROM characters ' +
      'WHERE world_id = ? AND deleted_at IS NULL ORDER BY score DESC LIMIT ?',
    trade: 'SELECT c.id, c.name, s.goods_sold AS score FROM player_stats s ' +
      'JOIN characters c ON c.id = s.character_id WHERE c.world_id = ? ORDER BY score DESC LIMIT ?',
    discoveries: 'SELECT c.id, c.name, s.islands_found AS score FROM player_stats s ' +
      'JOIN characters c ON c.id = s.character_id WHERE c.world_id = ? ORDER BY score DESC LIMIT ?',
    distance: 'SELECT c.id, c.name, CAST(s.distance AS INTEGER) AS score FROM player_stats s ' +
      'JOIN characters c ON c.id = s.character_id WHERE c.world_id = ? ORDER BY score DESC LIMIT ?',
  };
  const sql = queries[board];
  if (!sql) throw fail('error.validation', `unknown board ${board}`);

  const rows = await db.all(sql, [worldId, limit]);
  return rows.map((row) => ({ characterId: row.id, name: row.name, score: Number(row.score) }));
}

/** A closed season's frozen standings. */
export async function seasonBoard(seasonId, worldId, board) {
  const db = getDatabase();
  const rows = await db.all(
    'SELECT * FROM leaderboard_entries WHERE season_id = ? AND world_id = ? AND board = ? ' +
    'ORDER BY rank LIMIT 100', [seasonId, worldId, board]);
  return rows.map((row) => ({
    rank: Number(row.rank), name: row.display_name, score: Number(row.score),
  }));
}

export async function listSeasons() {
  const db = getDatabase();
  const rows = await db.all('SELECT * FROM seasons ORDER BY number DESC LIMIT 24');
  return rows.map(describeSeason);
}
