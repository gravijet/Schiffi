/**
 * Characters: creation, loading, persistence and cargo.
 *
 * A character is a save game bound to one world.  Its authoritative state
 * (coins, position, cargo) lives in the database; the simulation keeps a hot
 * copy in memory and flushes it, so a crash costs at most one flush interval.
 */
import { getDatabase } from '../db/index.js';
import config from '../config.js';
import { shipClass, effectiveStats, SHIP_CLASSES } from '@schiffi/shared/data/ships.js';
import { aggregateCrewBonus, wageFor, generateCrewMember } from '@schiffi/shared/data/crew.js';
import { generateShipName } from '@schiffi/shared/world/names.js';
import { goodById } from '@schiffi/shared/data/goods.js';
import { FACTIONS } from '@schiffi/shared/data/factions.js';
import { FOG_X, FOG_Y, FOG_CELL_SIZE } from '@schiffi/shared/world/constants.js';
import { HttpError } from '../http/respond.js';

const FOG_BYTES = Math.ceil((FOG_X * FOG_Y) / 8);

export async function listCharacters(userId) {
  const db = getDatabase();
  const rows = await db.all(
    `SELECT c.*, w.name AS world_name, w.seed AS world_seed
     FROM characters c JOIN worlds w ON w.id = c.world_id
     WHERE c.user_id = ? AND c.deleted_at IS NULL ORDER BY c.last_seen_at DESC`, [userId]);
  return rows.map(publicCharacter);
}

export function publicCharacter(row) {
  return {
    id: row.id,
    worldId: row.world_id,
    worldName: row.world_name,
    name: row.name,
    mode: row.mode,
    coins: Number(row.coins),
    bank: Number(row.bank_balance),
    x: Number(row.x),
    y: Number(row.y),
    heading: Number(row.heading),
    level: Number(row.level),
    xp: Number(row.xp),
    profession: row.profession,
    docked: row.docked === 1,
    portId: row.current_port_id,
    activeShipId: row.active_ship_id,
    protectionUntil: row.protection_until ? Number(row.protection_until) : null,
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    playtimeMs: Number(row.playtime_ms),
  };
}

/**
 * Create a character: a simple boat, five coins, an empty hold, at the world's
 * designated beginner harbour.
 */
export async function createCharacter({ userId, worldId, name, mode }, instance) {
  const db = getDatabase();
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '_-]{1,23}$/u.test(String(name ?? '').trim())) {
    throw new HttpError(400, 'error.validation', 'invalid character name');
  }
  if (!['trader', 'explorer'].includes(mode)) {
    throw new HttpError(400, 'error.validation', 'unknown mode');
  }

  const existing = await db.get(
    'SELECT id FROM characters WHERE user_id = ? AND world_id = ? AND deleted_at IS NULL',
    [userId, worldId]);
  if (existing) throw new HttpError(409, 'error.conflict', 'you already have a character in this world');

  const start = instance.world.start;
  const now = Date.now();

  return db.tx(async (tx) => {
    const characterId = await tx.insert('characters', {
      user_id: userId, world_id: worldId, name: String(name).trim(), mode,
      coins: config.game.startingCoins,
      bank_balance: 0,
      x: start.x, y: start.y, heading: 0,
      current_port_id: start.portId, docked: 1,
      level: 1, xp: 0,
      profession: mode === 'explorer' ? 'explorer' : 'trader',
      playtime_ms: 0,
      protection_until: now + config.game.newbieProtectionMinutes * 60_000,
      created_at: now, last_seen_at: now,
    });

    const starter = shipClass('small_boat');
    const shipId = await tx.insert('ships', {
      character_id: characterId,
      class_key: starter.key,
      name: generateShipName(characterId * 7919 + now),
      hull: starter.hull, sail: starter.sail,
      upgrades: '{}', cannons: 0, ammunition: 0,
      created_at: now,
    });
    await tx.run('UPDATE characters SET active_ship_id = ? WHERE id = ?', [shipId, characterId]);

    // A lone deck hand: enough to sail, not enough to be comfortable.
    const hand = generateCrewMember(characterId, start.portId, 0, 1);
    await tx.insert('crew_members', {
      ship_id: shipId, name: hand.name, role: 'sailor', spec: 'none',
      level: 1, xp: 0, morale: 70, health: 100, wage: wageFor({ ...hand, role: 'sailor', level: 1 }),
      hired_at: now,
    });

    await tx.insert('fog', {
      character_id: characterId,
      bitmap: new Uint8Array(FOG_BYTES),
      explored: 0,
      updated_at: now,
    });
    await tx.insert('player_stats', { character_id: characterId, updated_at: now });
    await tx.insert('tutorial_progress', { character_id: characterId, step: 0 });

    for (const faction of FACTIONS) {
      await tx.insert('reputation', { character_id: characterId, faction_key: faction.key, value: 0 });
    }

    return characterId;
  });
}

/** Full character state: ship, crew, cargo, reputation, stats. */
export async function loadCharacter(characterId) {
  const db = getDatabase();
  const row = await db.get(
    `SELECT c.*, w.name AS world_name, w.seed AS world_seed
     FROM characters c JOIN worlds w ON w.id = c.world_id
     WHERE c.id = ? AND c.deleted_at IS NULL`, [characterId]);
  if (!row) throw new HttpError(404, 'error.notFound', 'character not found');

  const ships = await db.all('SELECT * FROM ships WHERE character_id = ?', [characterId]);
  const active = ships.find((s) => String(s.id) === String(row.active_ship_id)) ?? ships[0] ?? null;
  const crew = active ? await db.all('SELECT * FROM crew_members WHERE ship_id = ?', [active.id]) : [];
  const cargo = active ? await db.all('SELECT * FROM cargo WHERE ship_id = ?', [active.id]) : [];
  const reputation = await db.all('SELECT faction_key, value FROM reputation WHERE character_id = ?', [characterId]);
  const stats = await db.get('SELECT * FROM player_stats WHERE character_id = ?', [characterId]);

  return {
    ...publicCharacter(row),
    ship: active ? describeShip(active, crew) : null,
    ships: ships.map((s) => describeShip(s, [])),
    crew: crew.map(describeCrew),
    cargo: cargo.map(describeCargo),
    reputation: Object.fromEntries(reputation.map((r) => [r.faction_key, Number(r.value)])),
    stats: stats ?? null,
  };
}

export function describeShip(row, crew) {
  const upgrades = safeJson(row.upgrades, {});
  const bonus = aggregateCrewBonus(crew.map(describeCrew));
  const stats = effectiveStats(row.class_key, upgrades, bonus);
  return {
    id: row.id,
    classKey: row.class_key,
    name: row.name,
    hull: Number(row.hull),
    sail: Number(row.sail),
    maxHull: stats?.hull ?? 0,
    maxSail: stats?.sail ?? 0,
    upgrades,
    cannons: Number(row.cannons),
    ammunition: Number(row.ammunition),
    storedAtPort: row.stored_at_port,
    stats,
  };
}

export function describeCrew(row) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    spec: row.spec,
    level: Number(row.level),
    xp: Number(row.xp),
    morale: Number(row.morale),
    health: Number(row.health),
    wage: Number(row.wage),
    disease: row.disease ?? null,
  };
}

export function describeCargo(row) {
  const good = goodById(Number(row.good_id));
  return {
    id: row.id,
    goodId: Number(row.good_id),
    key: good?.key ?? 'unknown',
    qty: Number(row.qty),
    freshness: Number(row.freshness),
    avgCost: Number(row.avg_cost),
    vol: good?.vol ?? 1,
    weight: good?.weight ?? 0,
    perish: good?.perish ?? 0,
  };
}

/**
 * Cargo slots and weight in use.
 *
 * Takes an optional database handle: when called from inside a transaction it
 * must run on *that* handle, or it will wait on a lock the caller holds.
 */
export async function cargoUsage(shipId, handle = null) {
  const db = handle ?? getDatabase();
  const rows = await db.all('SELECT good_id, qty FROM cargo WHERE ship_id = ?', [shipId]);
  let used = 0;
  let weight = 0;
  for (const row of rows) {
    const good = goodById(Number(row.good_id));
    if (!good) continue;
    used += good.vol * Number(row.qty);
    weight += good.weight * Number(row.qty);
  }
  return { used, weight };
}

/**
 * Add goods to a hold, merging into an existing lot of the same good and
 * freshness band so the cargo list does not grow without bound.
 */
export async function addCargo(tx, shipId, goodId, qty, unitCost, freshness = 1) {
  const band = Math.round(freshness * 20) / 20;
  const existing = await tx.get(
    'SELECT * FROM cargo WHERE ship_id = ? AND good_id = ? AND freshness >= ? AND freshness <= ?',
    [shipId, goodId, band - 0.025, band + 0.025]);

  if (existing) {
    const oldQty = Number(existing.qty);
    const newQty = oldQty + qty;
    const avg = (Number(existing.avg_cost) * oldQty + unitCost * qty) / newQty;
    await tx.run('UPDATE cargo SET qty = ?, avg_cost = ? WHERE id = ?', [newQty, avg, existing.id]);
    return existing.id;
  }
  return tx.insert('cargo', {
    ship_id: shipId, good_id: goodId, qty, freshness: band,
    avg_cost: unitCost, acquired_at: Date.now(),
  });
}

/**
 * Remove goods, oldest (least fresh) lot first.
 *
 * Reports the average freshness of what was taken as well as the quantity: a
 * lot that changes hands has to arrive as worn as it left, or player trade
 * would launder spoilage away.
 */
export async function removeCargo(tx, shipId, goodId, qty) {
  const lots = await tx.all(
    'SELECT * FROM cargo WHERE ship_id = ? AND good_id = ? ORDER BY freshness ASC, id ASC',
    [shipId, goodId]);
  let remaining = qty;
  let removed = 0;
  let costBasis = 0;
  let freshnessSum = 0;

  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(lot.qty));
    costBasis += take * Number(lot.avg_cost);
    freshnessSum += take * Number(lot.freshness);
    if (take >= Number(lot.qty)) {
      await tx.run('DELETE FROM cargo WHERE id = ?', [lot.id]);
    } else {
      await tx.run('UPDATE cargo SET qty = ? WHERE id = ?', [Number(lot.qty) - take, lot.id]);
    }
    remaining -= take;
    removed += take;
  }
  return { removed, costBasis, freshness: removed > 0 ? freshnessSum / removed : 1 };
}

// --- fog of war ------------------------------------------------------------

export async function loadFog(characterId) {
  const db = getDatabase();
  const row = await db.get('SELECT bitmap, explored FROM fog WHERE character_id = ?', [characterId]);
  if (!row) return { bits: new Uint8Array(FOG_BYTES), explored: 0 };
  const raw = row.bitmap;
  const bits = raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(Buffer.from(raw));
  return {
    bits: bits.length === FOG_BYTES ? bits : new Uint8Array(FOG_BYTES),
    explored: Number(row.explored),
  };
}

export async function saveFog(characterId, fog) {
  const db = getDatabase();
  await db.run('UPDATE fog SET bitmap = ?, explored = ?, updated_at = ? WHERE character_id = ?',
    [fog.bits, fog.explored, Date.now(), characterId]);
}

/**
 * Reveal the disc of fog cells around a world position.
 * Returns how many new cells were revealed, so callers can award exploration.
 */
export function revealFog(fog, worldX, worldY, radiusWorld) {
  const cx = Math.floor(worldX / FOG_CELL_SIZE);
  const cy = Math.floor(worldY / FOG_CELL_SIZE);
  const r = Math.max(1, Math.ceil(radiusWorld / FOG_CELL_SIZE));
  const r2 = r * r;
  let revealed = 0;

  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= FOG_Y) continue;
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = cx + dx;
      if (x < 0 || x >= FOG_X) continue;
      const index = y * FOG_X + x;
      const byte = index >> 3;
      const mask = 1 << (index & 7);
      if ((fog.bits[byte] & mask) === 0) {
        fog.bits[byte] |= mask;
        revealed++;
      }
    }
  }
  fog.explored += revealed;
  return revealed;
}

export const FOG_TOTAL_CELLS = FOG_X * FOG_Y;

function safeJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export { SHIP_CLASSES, FOG_BYTES };
