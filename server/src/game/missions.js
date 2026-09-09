/**
 * Contracts.
 *
 * A port's notice board is generated from that port's actual situation - what
 * it lacks, who its neighbours are, how dangerous the water is - so a contract
 * is always something the world can really deliver on. Completion is checked
 * against game state, never against a client claim.
 */
import { getDatabase } from '../db/index.js';
import { HttpError } from '../http/respond.js';
import { Rng, hashCombine, seedFromString } from '@schiffi/shared/util/rng.js';
import { dist, clamp } from '@schiffi/shared/util/math.js';
import { goodById, goodByKey, allGoods } from '@schiffi/shared/data/goods.js';
import { generatePersonName } from '@schiffi/shared/world/names.js';
import { isContraband } from '@schiffi/shared/data/factions.js';
import { removeCargo, addCargo, cargoUsage } from './characters.js';
import { awardXp } from './progression.js';
import { audit } from '../services/audit.js';

export const MISSION_TYPES = ['delivery', 'passenger', 'bounty', 'exploration',
  'escort', 'salvage', 'supply', 'smuggle'];

/** How many contracts a port keeps posted, by size. */
const BOARD_SIZE = [3, 5, 8, 12, 16];
/** How long a generated contract stays on the board. */
const POSTING_TTL_MS = 6 * 3_600_000;

const fail = (code, message = code) => new HttpError(400, code, message);

/**
 * Top a port's notice board back up.
 * Called lazily when the board is read, so idle ports cost nothing.
 */
export async function refreshBoard(instance, port) {
  const db = getDatabase();
  const now = Date.now();

  await db.run(
    "UPDATE missions SET status = 'expired' WHERE world_id = ? AND port_id = ? AND status = 'open' AND deadline < ?",
    [instance.id, port.id, now]);

  const open = await db.all(
    "SELECT * FROM missions WHERE world_id = ? AND port_id = ? AND status = 'open'",
    [instance.id, port.id]);

  const target = BOARD_SIZE[Math.min(port.size, BOARD_SIZE.length - 1)];
  if (open.length >= target) return open;

  const rng = new Rng(hashCombine(instance.seed, seedFromString(port.id), Math.floor(now / POSTING_TTL_MS)));
  const created = [];

  for (let i = open.length; i < target; i++) {
    const mission = generateMission(instance, port, rng, i);
    if (!mission) continue;
    const id = await db.insert('missions', {
      world_id: instance.id, port_id: port.id, type: mission.type,
      data: JSON.stringify(mission.data), reward: mission.reward,
      reputation: JSON.stringify(mission.reputation ?? {}),
      deadline: now + mission.ttlMs, status: 'open', created_at: now,
    });
    created.push({ id, ...mission });
  }
  return [...open, ...created];
}

/** Build one contract appropriate to this port. */
function generateMission(instance, port, rng, slot) {
  const world = instance.world;
  const nearby = world.ports
    .filter((other) => other.id !== port.id)
    .map((other) => ({ port: other, distance: dist(other.x, other.y, port.x, port.y) }))
    .filter((entry) => entry.distance < 260 * 24)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 24);
  if (nearby.length === 0) return null;

  // The first two slots on every board are a small cargo run, so a captain in
  // the starting boat (eight slots) always has work they can physically take.
  const region = world.regions[port.regionId];
  if (slot < 2) {
    const candidates = allGoods().filter((good) => good.rare <= 1 && good.vol === 1);
    const good = rng.pick(candidates);
    const qty = rng.int(2, 6);
    const destination = rng.pickWeighted(nearby, nearby.map((entry) => 1 / (1 + entry.distance / 20000)));
    const legs = destination.distance / 24;
    return {
      type: 'delivery',
      data: {
        goodId: good.id, goodKey: good.key, qty,
        toPortId: destination.port.id, toPortName: destination.port.name,
        client: generatePersonName(hashCombine(seedFromString(port.id), slot)),
        starter: true,
      },
      reward: Math.round(good.price * qty * 0.45 + legs * 3 + 80),
      reputation: { [destination.port.factionKey]: 2 },
      ttlMs: clamp(legs * 60_000, 45 * 60_000, 8 * 3_600_000),
    };
  }

  const weights = {
    delivery: 6,
    passenger: port.size >= 2 ? 4 : 1.5,
    supply: 3,
    exploration: 2,
    salvage: 2,
    bounty: region.pirateDensity > 0.4 ? 3 : 1,
    escort: region.pirateDensity > 0.3 ? 2.5 : 1,
    smuggle: port.factionKey === 'freihandel' || region.hazardName === 'pirate' ? 2 : 0.4,
  };
  const type = rng.pickWeighted(Object.keys(weights), Object.values(weights));
  const destination = rng.pickWeighted(nearby, nearby.map((entry) => 1 / (1 + entry.distance / 20000)));
  const legs = destination.distance / 24; // in cells, a rough travel measure

  switch (type) {
    case 'delivery':
    case 'supply': {
      const candidates = allGoods().filter((good) => good.rare <= 2 && good.vol <= 2);
      const good = rng.pick(candidates);
      const qty = rng.int(4, 6 + port.size * 3);
      const base = good.price * qty;
      return {
        type,
        data: {
          goodId: good.id, goodKey: good.key, qty,
          toPortId: destination.port.id, toPortName: destination.port.name,
          client: generatePersonName(hashCombine(seedFromString(port.id), slot)),
        },
        reward: Math.round(base * (type === 'supply' ? 0.5 : 0.35) + legs * 3 + 60),
        reputation: { [destination.port.factionKey]: 2 },
        ttlMs: clamp(legs * 60_000, 45 * 60_000, 8 * 3_600_000),
      };
    }

    case 'passenger': {
      const count = rng.int(1, 6);
      const comfort = rng.int(0, 3);
      return {
        type,
        data: {
          count, comfort,
          toPortId: destination.port.id, toPortName: destination.port.name,
          name: generatePersonName(hashCombine(seedFromString(port.id), slot * 31)),
        },
        reward: Math.round((70 + legs * 4) * count * (1 + comfort * 0.35)),
        reputation: { [destination.port.factionKey]: 1 },
        ttlMs: clamp(legs * 55_000, 40 * 60_000, 6 * 3_600_000),
      };
    }

    case 'exploration': {
      const uncharted = world.islands.filter((island) => island.undiscovered);
      if (uncharted.length === 0) return null;
      const island = rng.pick(uncharted);
      return {
        type,
        data: {
          islandId: island.id,
          // The client is told roughly where, not exactly: that is the job.
          hintX: Math.round(island.cx * 24 + rng.range(-4000, 4000)),
          hintY: Math.round(island.cy * 24 + rng.range(-4000, 4000)),
          radius: 5000,
        },
        reward: rng.int(900, 2600),
        reputation: { [port.factionKey]: 4 },
        ttlMs: 12 * 3_600_000,
      };
    }

    case 'salvage': {
      return {
        type,
        data: {
          x: Math.round(port.x + rng.range(-60, 60) * 24),
          y: Math.round(port.y + rng.range(-60, 60) * 24),
          radius: 900,
        },
        reward: rng.int(320, 1100),
        reputation: { [port.factionKey]: 2 },
        ttlMs: 6 * 3_600_000,
      };
    }

    case 'bounty': {
      return {
        type,
        data: { kills: rng.int(1, 4), pirateOnly: true },
        reward: rng.int(600, 2400),
        reputation: { [port.factionKey]: 6 },
        ttlMs: 10 * 3_600_000,
      };
    }

    case 'escort': {
      return {
        type,
        data: { toPortId: destination.port.id, toPortName: destination.port.name },
        reward: Math.round(280 + legs * 6),
        reputation: { [destination.port.factionKey]: 3 },
        ttlMs: clamp(legs * 70_000, 60 * 60_000, 6 * 3_600_000),
      };
    }

    case 'smuggle': {
      const contraband = allGoods().filter((good) =>
        good.cat === 'contraband' || isContraband(destination.port.factionKey, good));
      if (contraband.length === 0) return null;
      const good = rng.pick(contraband);
      const qty = rng.int(2, 10);
      return {
        type,
        data: {
          goodId: good.id, goodKey: good.key, qty,
          toPortId: destination.port.id, toPortName: destination.port.name,
          risk: true,
        },
        reward: Math.round(good.price * qty * 0.9 + legs * 5),
        reputation: { [destination.port.factionKey]: -5, schwarzflagge: 4 },
        ttlMs: clamp(legs * 50_000, 40 * 60_000, 5 * 3_600_000),
      };
    }

    default:
      return null;
  }
}

/** Contracts posted at a port, refreshing the board first. */
export async function boardFor(instance, port) {
  await refreshBoard(instance, port);
  const db = getDatabase();
  const rows = await db.all(
    "SELECT * FROM missions WHERE world_id = ? AND port_id = ? AND status = 'open' ORDER BY reward DESC",
    [instance.id, port.id]);
  return rows.map(describeMission);
}

export function describeMission(row) {
  return {
    id: row.id,
    type: row.type,
    data: JSON.parse(row.data || '{}'),
    reward: Number(row.reward),
    reputation: JSON.parse(row.reputation || '{}'),
    deadline: row.deadline ? Number(row.deadline) : null,
    status: row.status,
    takenAt: row.taken_at ? Number(row.taken_at) : null,
  };
}

/** Accept a contract. Delivery contracts hand over the cargo immediately. */
export async function accept({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (!character) throw new HttpError(404, 'error.notFound');
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (character.docked !== 1) throw fail('error.notInPort');

    const mission = await tx.get(
      "SELECT * FROM missions WHERE id = ? AND world_id = ? AND status = 'open'",
      [payload.missionId, instance.id]);
    if (!mission) throw new HttpError(404, 'error.notFound', 'that contract is gone');
    if (mission.port_id !== character.current_port_id) throw fail('error.notInPort');

    const active = await tx.get(
      "SELECT COUNT(*) AS n FROM missions WHERE taken_by = ? AND status = 'taken'", [characterId]);
    if (Number(active?.n ?? 0) >= 5) throw fail('error.validation', 'you already carry five contracts');

    const data = JSON.parse(mission.data || '{}');

    // Cargo contracts load the goods now, so the hold must have room.
    if (mission.type === 'delivery' || mission.type === 'supply' || mission.type === 'smuggle') {
      const good = goodById(Number(data.goodId));
      if (!good) throw fail('error.validation');
      const { used } = await cargoUsage(character.active_ship_id, tx);
      const player = instance.players.get(`p${characterId}`);
      const capacity = player?.stats?.cargo ?? 8;
      if (used + good.vol * data.qty > capacity) throw fail('trade.notEnoughSpace');
      await addCargo(tx, character.active_ship_id, good.id, data.qty, 0, 1);
    }

    if (mission.type === 'passenger') {
      const player = instance.players.get(`p${characterId}`);
      const berths = player?.stats?.passengerBerths ?? 2;
      const aboard = await tx.get(
        'SELECT COUNT(*) AS n FROM passengers WHERE ship_id = ? AND delivered_at IS NULL',
        [character.active_ship_id]);
      if (Number(aboard?.n ?? 0) + data.count > berths) throw fail('passenger.berths', 'not enough cabins');

      for (let i = 0; i < data.count; i++) {
        await tx.insert('passengers', {
          world_id: instance.id, ship_id: character.active_ship_id,
          from_port: mission.port_id, to_port: data.toPortId,
          name: i === 0 ? data.name : generatePersonName(hashCombine(mission.id | 0, i)),
          fare: Math.round(Number(mission.reward) / data.count),
          comfort_req: data.comfort ?? 0,
          boarded_at: Date.now(), deadline: mission.deadline,
        });
      }
    }

    // A bounty is measured as a delta, so record the starting count with the
    // contract rather than trusting a later claim.
    if (mission.type === 'bounty') {
      const stats = await tx.get('SELECT battles_won FROM player_stats WHERE character_id = ?', [characterId]);
      data.battlesAtStart = Number(stats?.battles_won ?? 0);
      await tx.run('UPDATE missions SET data = ? WHERE id = ?', [JSON.stringify(data), mission.id]);
    }

    await tx.run(
      "UPDATE missions SET status = 'taken', taken_by = ?, taken_at = ? WHERE id = ?",
      [characterId, Date.now(), mission.id]);

    return { missionId: mission.id, type: mission.type, data, reward: Number(mission.reward) };
  });
}

/**
 * Try to complete a contract.
 *
 * Each type has its own proof, and all of it comes from game state: cargo the
 * server can see in the hold, a discovery row, a wreck that was actually
 * salvaged, kills recorded in player_stats.
 */
export async function complete({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (!character) throw new HttpError(404, 'error.notFound');
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');

    const mission = await tx.get(
      "SELECT * FROM missions WHERE id = ? AND taken_by = ? AND status = 'taken'",
      [payload.missionId, characterId]);
    if (!mission) throw new HttpError(404, 'error.notFound');

    const data = JSON.parse(mission.data || '{}');
    if (mission.deadline && Date.now() > Number(mission.deadline)) {
      await tx.run("UPDATE missions SET status = 'failed' WHERE id = ?", [mission.id]);
      throw fail('mission.expired');
    }

    const proof = await verifyCompletion(tx, { instance, character, mission, data });
    if (!proof.ok) throw fail(proof.code ?? 'error.validation', proof.message);

    const reward = Number(mission.reward);
    await tx.run('UPDATE characters SET coins = coins + ? WHERE id = ?', [reward, characterId]);
    await tx.run("UPDATE missions SET status = 'done' WHERE id = ?", [mission.id]);

    for (const [faction, delta] of Object.entries(JSON.parse(mission.reputation || '{}'))) {
      const row = await tx.get(
        'SELECT value FROM reputation WHERE character_id = ? AND faction_key = ?', [characterId, faction]);
      const next = clamp(Number(row?.value ?? 0) + Number(delta), -100, 100);
      if (row) {
        await tx.run('UPDATE reputation SET value = ? WHERE character_id = ? AND faction_key = ?',
          [next, characterId, faction]);
      } else {
        await tx.insert('reputation', { character_id: characterId, faction_key: faction, value: next });
      }
    }

    const xp = Math.round(40 + reward / 25);
    await awardXp(tx, characterId, xp);
    await audit({ userId }, 'mission.complete', 'character', String(characterId),
      { missionId: mission.id, type: mission.type, reward }, { db: tx });

    return { missionId: mission.id, type: mission.type, reward, xp, detail: proof.detail ?? null };
  });
}

async function verifyCompletion(tx, { instance, character, mission, data }) {
  switch (mission.type) {
    case 'delivery':
    case 'supply':
    case 'smuggle': {
      if (character.docked !== 1 || character.current_port_id !== data.toPortId) {
        return { ok: false, code: 'error.notInPort', message: `deliver to ${data.toPortName}` };
      }
      const { removed } = await removeCargo(tx, character.active_ship_id, Number(data.goodId), Number(data.qty));
      if (removed < Number(data.qty)) {
        // Put back what was taken: a partial delivery is not a delivery.
        if (removed > 0) await addCargo(tx, character.active_ship_id, Number(data.goodId), removed, 0, 1);
        return { ok: false, code: 'trade.nothingToSell', message: 'the cargo is not aboard' };
      }
      return { ok: true, detail: { delivered: Number(data.qty) } };
    }

    case 'passenger': {
      if (character.docked !== 1 || character.current_port_id !== data.toPortId) {
        return { ok: false, code: 'error.notInPort', message: `disembark at ${data.toPortName}` };
      }
      const { changes } = await tx.run(
        'UPDATE passengers SET delivered_at = ? WHERE ship_id = ? AND to_port = ? AND delivered_at IS NULL',
        [Date.now(), character.active_ship_id, data.toPortId]);
      if (changes === 0) return { ok: false, message: 'no passengers for this port aboard' };
      return { ok: true, detail: { disembarked: changes } };
    }

    case 'exploration': {
      const discovery = await tx.get(
        'SELECT * FROM island_discoveries WHERE world_id = ? AND island_id = ? AND character_id = ?',
        [instance.id, data.islandId, character.id]);
      if (!discovery) return { ok: false, message: 'that island is still uncharted by you' };
      return { ok: true, detail: { islandId: data.islandId } };
    }

    case 'salvage': {
      const wreck = await tx.get(
        'SELECT id FROM wrecks WHERE world_id = ? AND looted_by = ? AND looted_at > ?',
        [instance.id, character.id, Number(mission.taken_at)]);
      if (!wreck) return { ok: false, message: 'no wreck salvaged since taking this contract' };
      return { ok: true, detail: { wreckId: wreck.id } };
    }

    case 'bounty': {
      const stats = await tx.get('SELECT battles_won FROM player_stats WHERE character_id = ?', [character.id]);
      const before = Number(data.battlesAtStart ?? 0);
      const won = Number(stats?.battles_won ?? 0) - before;
      if (won < Number(data.kills)) {
        return { ok: false, message: `${Number(data.kills) - won} more to sink` };
      }
      return { ok: true, detail: { kills: won } };
    }

    case 'escort': {
      if (character.docked !== 1 || character.current_port_id !== data.toPortId) {
        return { ok: false, code: 'error.notInPort', message: `escort to ${data.toPortName}` };
      }
      return { ok: true };
    }

    default:
      return { ok: false, message: 'unknown contract type' };
  }
}

export async function abandon({ characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');

    const mission = await tx.get(
      "SELECT * FROM missions WHERE id = ? AND taken_by = ? AND status = 'taken'",
      [payload.missionId, characterId]);
    if (!mission) throw new HttpError(404, 'error.notFound');

    await tx.run("UPDATE missions SET status = 'failed' WHERE id = ?", [mission.id]);
    // Abandoning is allowed but noticed.
    const data = JSON.parse(mission.data || '{}');
    for (const faction of Object.keys(JSON.parse(mission.reputation || '{}'))) {
      const row = await tx.get(
        'SELECT value FROM reputation WHERE character_id = ? AND faction_key = ?', [characterId, faction]);
      if (row) {
        await tx.run('UPDATE reputation SET value = ? WHERE character_id = ? AND faction_key = ?',
          [clamp(Number(row.value) - 2, -100, 100), characterId, faction]);
      }
    }
    if (mission.type === 'passenger') {
      await tx.run('DELETE FROM passengers WHERE ship_id = ? AND to_port = ? AND delivered_at IS NULL',
        [character.active_ship_id, data.toPortId]);
    }
    return { missionId: mission.id, abandoned: true };
  });
}

/** Contracts a character is currently carrying. */
export async function activeMissions(characterId) {
  const db = getDatabase();
  const rows = await db.all(
    "SELECT * FROM missions WHERE taken_by = ? AND status = 'taken' ORDER BY deadline", [characterId]);
  return rows.map(describeMission);
}
