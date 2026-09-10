/**
 * Sea combat.
 *
 * Combat happens in the world, not in a separate mode: two ships that are
 * within gun range of each other can exchange fire while everything else -
 * wind, storms, reefs, other traffic - keeps running.
 *
 * The model is deliberately readable rather than elaborate:
 *   - a broadside's damage falls off with range and is split between hull
 *     and rigging depending on how the shot is aimed
 *   - reload time is a real cooldown, tracked per ship on the server
 *   - fleeing is a speed contest, not a button that always works
 *   - boarding is only possible against a ship that is already beaten
 *
 * Protection rules are enforced here, not in the UI: newcomers and ships in
 * policed waters cannot be attacked at all.
 */
import { getDatabase } from '../db/index.js';
import { HttpError } from '../http/respond.js';
import { dist, clamp, clamp01 } from '@schiffi/shared/util/math.js';
import { HAZARD } from '@schiffi/shared/world/regions.js';
import { regionAt } from '@schiffi/shared/world/regions.js';
import { goodById } from '@schiffi/shared/data/goods.js';
import { addCargo, cargoUsage } from './characters.js';
import { awardXp } from './progression.js';
import { audit } from '../services/audit.js';
import {
  GUN_RANGE, BOARDING_RANGE, SALVAGE_RANGE, RELOAD_MS, BOARDABLE_HULL,
  CANNON_PRICE, SHOT_PRICE, MIN_BOUNTY,
} from '@schiffi/shared/data/costs.js';

// Ranges, reload and prices are shared with the client so a button can show
// what it will cost and grey out at the same distance the server refuses at.
export { GUN_RANGE, BOARDING_RANGE, SALVAGE_RANGE, RELOAD_MS, BOARDABLE_HULL };

const AIM_MODES = { hull: 'hull', sails: 'sails' };

const fail = (code, message = code) => new HttpError(400, code, message);

/** Find a live target by its network id in this world. */
export function resolveTarget(instance, netId) {
  if (instance.npcs.has(netId)) return instance.npcs.get(netId);
  return instance.players.get(netId) ?? null;
}

/**
 * May `attacker` legally fire on `target` here?
 *
 * Three independent guards, all server-side: the water has to allow it, the
 * target must not be under newcomer protection, and you cannot shoot a ship
 * that is safely in port.
 */
export function canEngage(instance, attacker, target) {
  if (!target || target === attacker) return 'error.notFound';
  if (target.docked) return 'error.validation';

  // NPC pirates and the navy are always fair game; so is anyone in their crew.
  const targetIsPlayer = target.kind === 1;
  if (!targetIsPlayer) return null;

  const region = regionAt(instance.world.regions, attacker.x, attacker.y);
  if (!region?.pvp) return 'hazard.pvpOff';
  if (target.protected) return 'pvp.protected';
  if (attacker.protected) return 'pvp.protected';
  return null;
}

/**
 * Fire a broadside.
 *
 * Damage is computed from the attacker's guns, the range and the crew's
 * gunnery, then split between hull and rigging by the chosen aim.
 */
export async function fire({ instance, characterId, userId, payload, gateway }) {
  const attacker = instance.players.get(`p${characterId}`);
  if (!attacker) throw fail('error.validation', 'not in the world');
  if (attacker.docked) throw fail('error.notInPort', 'you cannot fire from a berth');

  const target = resolveTarget(instance, String(payload.targetId ?? ''));
  const blocked = canEngage(instance, attacker, target);
  if (blocked) throw fail(blocked);

  const range = dist(attacker.x, attacker.y, target.x, target.y);
  if (range > GUN_RANGE) throw fail('error.tooFar');

  const now = Date.now();
  if (attacker.reloadedAt && now < attacker.reloadedAt) {
    throw new HttpError(429, 'combat.reload',
      `${Math.ceil((attacker.reloadedAt - now) / 1000)}s`);
  }

  const db = getDatabase();
  const ship = await db.get('SELECT * FROM ships WHERE id = ?', [attacker.shipId]);
  if (!ship) throw fail('error.validation');
  const guns = Number(ship.cannons);
  if (guns <= 0) throw fail('combat.cannons', 'no guns mounted');
  if (Number(ship.ammunition) <= 0) throw fail('combat.ammunition', 'out of shot');

  const aim = AIM_MODES[payload.aim] ?? AIM_MODES.hull;

  // Accuracy falls off with range; gunners and a steady ship bring it back.
  const gunnery = clamp01(attacker.combatBonus ?? 1) * 0.5 + 0.5;
  const rangeFactor = 1 - (range / GUN_RANGE) * 0.6;
  const stormPenalty = attacker.inStorm ? 0.6 : 1;
  const accuracy = clamp01(rangeFactor * gunnery * stormPenalty);

  const shots = Math.max(1, Math.round(guns * accuracy));
  const rawDamage = shots * 7.5 * (0.8 + Math.random() * 0.4);

  const hullShare = aim === AIM_MODES.hull ? 0.8 : 0.25;
  const hullDamage = rawDamage * hullShare;
  const sailDamage = rawDamage * (1 - hullShare) * 1.4;

  target.hull = Math.max(0, target.hull - hullDamage);
  target.sail = Math.max(0, (target.sail ?? 0) - sailDamage);

  attacker.reloadedAt = now + RELOAD_MS;
  await db.run('UPDATE ships SET ammunition = GREATEST(0, ammunition - 1) WHERE id = ?', [ship.id]);

  // Both sides are told, so a victim can react rather than just die.
  if (target.send) {
    target.send({
      t: 'event', kind: 'underFire', from: attacker.displayName,
      hull: Math.round(target.hull), sail: Math.round(target.sail),
    });
  }

  let sunk = null;
  if (target.hull <= 0) sunk = await sinkTarget({ instance, attacker, target, gateway, userId });

  return {
    targetId: target.netId,
    shots,
    accuracy: Math.round(accuracy * 100) / 100,
    hullDamage: Math.round(hullDamage),
    sailDamage: Math.round(sailDamage),
    targetHull: Math.round(target.hull),
    reloadMs: RELOAD_MS,
    ammunition: Math.max(0, Number(ship.ammunition) - 1),
    sunk,
  };
}

/**
 * A ship goes down: its cargo becomes a floating wreck, the victor gains
 * experience and reputation, and a player victim loses their cargo but not
 * their account.
 */
async function sinkTarget({ instance, attacker, target, gateway, userId }) {
  const db = getDatabase();
  const isPlayer = target.kind === 1;

  const contents = isPlayer
    ? await lootFromPlayer(db, target)
    : lootFromNpc(target);

  const wreckId = await db.insert('wrecks', {
    world_id: instance.id, x: target.x, y: target.y,
    contents: JSON.stringify(contents), created_at: Date.now(),
  });
  // Put it in the live list at once rather than waiting for the next sweep:
  // the ship that just won the fight is sitting right on top of it.
  instance.wrecks ??= [];
  instance.wrecks.unshift({
    id: String(wreckId), x: target.x, y: target.y, at: Date.now(),
  });

  if (isPlayer) {
    // The victim respawns at their home port with a damaged ship and no cargo:
    // costly, but never account-ending.
    const character = await db.get('SELECT * FROM characters WHERE id = ?', [target.characterId]);
    const start = instance.world.start;
    await db.tx(async (tx) => {
      await tx.run('DELETE FROM cargo WHERE ship_id = ?', [target.shipId]);
      await tx.run(
        'UPDATE characters SET x = ?, y = ?, docked = 1, current_port_id = ? WHERE id = ?',
        [start.x, start.y, start.portId, target.characterId]);
      await tx.run('UPDATE ships SET hull = ?, sail = ? WHERE id = ?',
        [Math.max(10, target.maxHull * 0.3), Math.max(10, (target.sail ?? 40) * 0.3), target.shipId]);
      await tx.run(
        'UPDATE player_stats SET battles_lost = battles_lost + 1, updated_at = ? WHERE character_id = ?',
        [Date.now(), target.characterId]);
      await tx.run('UPDATE crew_members SET morale = GREATEST(0, morale - 25) WHERE ship_id = ?', [target.shipId]);
    });
    target.hull = Math.max(10, target.maxHull * 0.3);
    target.x = start.x;
    target.y = start.y;
    target.docked = true;
    if (target.send) target.send({ t: 'event', kind: 'sunk', by: attacker.displayName, wreckId });
  } else {
    instance.npcs.delete(target.netId);
  }

  await db.tx(async (tx) => {
    await tx.run(
      'UPDATE player_stats SET battles_won = battles_won + 1, updated_at = ? WHERE character_id = ?',
      [Date.now(), attacker.characterId]);
    await awardXp(tx, attacker.characterId, isPlayer ? 250 : 120);
    await tx.run('UPDATE crew_members SET morale = LEAST(100, morale + 12) WHERE ship_id = ?',
      [attacker.shipId]);
  });

  // Sinking a pirate is a public service; sinking a merchant is not.
  const reputationDelta = target.npcKind === 'pirate' ? 6 : target.npcKind === 'navy' ? -15 : -4;
  if (target.faction && target.faction !== 'schwarzflagge') {
    await adjustReputationOutsideTx(attacker.characterId, target.faction, reputationDelta);
  }

  const bounty = await claimBounty(db, instance, attacker, target);

  await audit({ userId }, 'combat.sunk', 'character', String(attacker.characterId),
    { target: target.displayName, isPlayer, wreckId, bounty });

  gateway?.broadcastToWorld(instance, {
    t: 'event', kind: 'shipSunk',
    victor: attacker.displayName, victim: target.displayName, isPlayer,
  });

  return { wreckId, contents, bounty, xp: isPlayer ? 250 : 120 };
}

async function lootFromPlayer(db, target) {
  const lots = await db.all('SELECT good_id, qty FROM cargo WHERE ship_id = ?', [target.shipId]);
  // Some of the cargo goes down with the ship; the rest floats.
  return lots
    .map((lot) => ({ goodId: Number(lot.good_id), qty: Math.ceil(Number(lot.qty) * 0.5) }))
    .filter((lot) => lot.qty > 0);
}

function lootFromNpc(target) {
  // An NPC's hold is generated at the moment it sinks, from its role.
  const size = { merchant: 12, transport: 18, pirate: 8, navy: 5, fisher: 4, explorer: 6, passenger: 6 }[target.npcKind] ?? 6;
  const goods = [];
  for (let i = 0; i < 3; i++) {
    const id = Math.floor(Math.random() * 1000);
    const good = goodById(id);
    if (!good) continue;
    goods.push({ goodId: good.id, qty: Math.max(1, Math.round(size / good.vol / 3)) });
  }
  return goods;
}

async function adjustReputationOutsideTx(characterId, factionKey, delta) {
  const db = getDatabase();
  const row = await db.get(
    'SELECT value FROM reputation WHERE character_id = ? AND faction_key = ?', [characterId, factionKey]);
  const next = clamp(Number(row?.value ?? 0) + delta, -100, 100);
  if (row) {
    await db.run('UPDATE reputation SET value = ? WHERE character_id = ? AND faction_key = ?',
      [next, characterId, factionKey]);
  } else {
    await db.insert('reputation', { character_id: characterId, faction_key: factionKey, value: next });
  }
  return next;
}

async function claimBounty(db, instance, attacker, target) {
  if (target.kind !== 1) return null;
  const bounties = await db.all(
    'SELECT * FROM bounties WHERE world_id = ? AND target_id = ? AND claimed_at IS NULL',
    [instance.id, target.characterId]);
  if (bounties.length === 0) return null;

  const total = bounties.reduce((sum, bounty) => sum + Number(bounty.amount), 0);
  await db.tx(async (tx) => {
    for (const bounty of bounties) {
      await tx.run('UPDATE bounties SET claimed_by = ?, claimed_at = ? WHERE id = ?',
        [attacker.characterId, Date.now(), bounty.id]);
    }
    await tx.run('UPDATE characters SET coins = coins + ? WHERE id = ?', [total, attacker.characterId]);
  });
  return total;
}

/**
 * Break off an engagement.
 *
 * A faster ship gets away; a slower one has to earn it. Sails matter more than
 * hull here, which makes rigging a worthwhile thing to shoot at.
 */
export async function flee({ instance, characterId, payload }) {
  const player = instance.players.get(`p${characterId}`);
  if (!player) throw fail('error.validation');

  const pursuer = resolveTarget(instance, String(payload.targetId ?? ''));
  if (!pursuer) throw fail('error.notFound');

  const mySpeed = (player.stats?.speed ?? 40) * clamp01(player.sail / Math.max(1, player.stats?.sail ?? 40));
  const theirSpeed = (pursuer.stats?.speed ?? 40) * clamp01((pursuer.sail ?? 40) / Math.max(1, pursuer.stats?.sail ?? 40));
  const range = dist(player.x, player.y, pursuer.x, pursuer.y);

  const advantage = mySpeed / Math.max(1, theirSpeed);
  const rangeBonus = clamp01(range / GUN_RANGE) * 0.35;
  const chance = clamp01(advantage * 0.55 + rangeBonus);

  const escaped = Math.random() < chance;
  if (escaped) {
    // The pursuer loses interest; for an NPC that means dropping the chase.
    if (pursuer.chaseTarget) {
      pursuer.chaseTarget = null;
      pursuer.state = pursuer.npcKind === 'pirate' ? 'prowl' : 'patrol';
    }
    const db = getDatabase();
    await db.tx(async (tx) => { await awardXp(tx, characterId, 30); });
  }
  return { escaped, chance: Math.round(chance * 100) / 100, targetId: pursuer.netId };
}

/**
 * Board a beaten ship and take what is in its hold.
 * Only possible at very close range against a ship below BOARDABLE_HULL.
 */
export async function board({ instance, characterId, userId, payload, gateway }) {
  const attacker = instance.players.get(`p${characterId}`);
  if (!attacker) throw fail('error.validation');

  const target = resolveTarget(instance, String(payload.targetId ?? ''));
  const blocked = canEngage(instance, attacker, target);
  if (blocked) throw fail(blocked);

  const range = dist(attacker.x, attacker.y, target.x, target.y);
  if (range > BOARDING_RANGE) throw fail('error.tooFar');
  if (target.hull / Math.max(1, target.maxHull ?? 1) > BOARDABLE_HULL) {
    throw fail('combat.board', 'that ship is still fighting');
  }

  const db = getDatabase();
  return db.tx(async (tx) => {
    const ship = await tx.get('SELECT * FROM ships WHERE id = ?', [attacker.shipId]);
    const crew = await tx.all('SELECT * FROM crew_members WHERE ship_id = ?', [ship.id]);
    const guards = crew.filter((member) => member.role === 'guard').length;
    if (crew.length < 2) throw fail('crew.understaffed', 'not enough hands to board');

    // The boarding party can be beaten off; guards make that unlikely.
    const success = Math.random() < clamp01(0.45 + guards * 0.12 + crew.length * 0.02);
    if (!success) {
      await tx.run('UPDATE crew_members SET health = GREATEST(1, health - 18) WHERE ship_id = ?', [ship.id]);
      await tx.run('UPDATE crew_members SET morale = GREATEST(0, morale - 10) WHERE ship_id = ?', [ship.id]);
      return { boarded: false, taken: [] };
    }

    const loot = target.kind === 1
      ? await tx.all('SELECT * FROM cargo WHERE ship_id = ?', [target.shipId])
      : lootFromNpc(target).map((entry) => ({ good_id: entry.goodId, qty: entry.qty, freshness: 1, avg_cost: 0 }));

    const { used } = await cargoUsage(ship.id, tx);
    const capacity = attacker.stats?.cargo ?? 8;
    let free = Math.max(0, capacity - used);
    const taken = [];

    for (const lot of loot) {
      const good = goodById(Number(lot.good_id));
      if (!good) continue;
      const qty = Math.min(Number(lot.qty), Math.floor(free / good.vol));
      if (qty <= 0) continue;
      await addCargo(tx, ship.id, good.id, qty, Number(lot.avg_cost) || good.price * 0.4, Number(lot.freshness) || 1);
      free -= good.vol * qty;
      taken.push({ goodId: good.id, key: good.key, qty });

      if (target.kind === 1) {
        const remaining = Number(lot.qty) - qty;
        if (remaining <= 0) await tx.run('DELETE FROM cargo WHERE id = ?', [lot.id]);
        else await tx.run('UPDATE cargo SET qty = ? WHERE id = ?', [remaining, lot.id]);
      }
    }

    await awardXp(tx, characterId, 90);
    await tx.run('UPDATE crew_members SET morale = LEAST(100, morale + 8) WHERE ship_id = ?', [ship.id]);

    if (target.send) target.send({ t: 'event', kind: 'boarded', by: attacker.displayName, taken });
    await audit({ userId }, 'combat.board', 'character', String(characterId),
      { target: target.displayName, taken: taken.length }, { db: tx });

    return { boarded: true, taken, targetId: target.netId };
  });
}

/** Salvage a floating wreck. */
export async function salvage({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const wreck = await tx.get(
      'SELECT * FROM wrecks WHERE id = ? AND world_id = ? AND looted_at IS NULL',
      [payload.wreckId, instance.id]);
    if (!wreck) throw new HttpError(404, 'error.notFound', 'nothing left to salvage');

    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (dist(Number(wreck.x), Number(wreck.y), Number(character.x), Number(character.y)) > SALVAGE_RANGE) {
      throw fail('error.tooFar');
    }

    const contents = JSON.parse(wreck.contents || '[]');
    const { used } = await cargoUsage(character.active_ship_id, tx);
    const player = instance.players.get(`p${characterId}`);
    let free = Math.max(0, (player?.stats?.cargo ?? 8) - used);
    const taken = [];

    for (const entry of contents) {
      const good = goodById(Number(entry.goodId));
      if (!good) continue;
      const qty = Math.min(Number(entry.qty), Math.floor(free / good.vol));
      if (qty <= 0) continue;
      await addCargo(tx, character.active_ship_id, good.id, qty, good.price * 0.3, 0.8);
      free -= good.vol * qty;
      taken.push({ goodId: good.id, key: good.key, qty });
    }

    await tx.run('UPDATE wrecks SET looted_by = ?, looted_at = ? WHERE id = ?',
      [characterId, Date.now(), wreck.id]);
    await awardXp(tx, characterId, 40);

    if (instance.wrecks) {
      instance.wrecks = instance.wrecks.filter((w) => String(w.id) !== String(wreck.id));
    }
    return { wreckId: wreck.id, taken };
  });
}

/** Buy guns and shot at a shipyard. */
export async function armShip({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (!character) throw new HttpError(404, 'error.notFound');
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (character.docked !== 1) throw fail('error.notInPort');

    const ship = await tx.get('SELECT * FROM ships WHERE id = ?', [character.active_ship_id]);
    const player = instance.players.get(`p${characterId}`);
    const slots = player?.stats?.cannonSlots ?? 0;

    const guns = Math.max(0, Math.floor(Number(payload.cannons ?? 0)));
    const shot = Math.max(0, Math.floor(Number(payload.ammunition ?? 0)));
    if (guns === 0 && shot === 0) throw fail('error.validation');
    if (Number(ship.cannons) + guns > slots) throw fail('error.validation', 'not enough gun ports');

    const cost = guns * CANNON_PRICE + shot * SHOT_PRICE;
    if (Number(character.coins) < cost) throw fail('trade.notEnoughCoins');

    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [cost, characterId]);
    await tx.run('UPDATE ships SET cannons = cannons + ?, ammunition = ammunition + ? WHERE id = ?',
      [guns, shot, ship.id]);

    return {
      cannons: Number(ship.cannons) + guns,
      ammunition: Number(ship.ammunition) + shot,
      cost,
      coins: Number(character.coins) - cost,
    };
  });
}

/** Place a bounty on another captain. */
export async function placeBounty({ instance, characterId, userId, payload }) {
  const amount = Math.floor(Number(payload.amount));
  if (!Number.isFinite(amount) || amount < MIN_BOUNTY) {
    throw fail('error.validation', `minimum bounty is ${MIN_BOUNTY}`);
  }

  const db = getDatabase();
  return db.tx(async (tx) => {
    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (Number(character.coins) < amount) throw fail('trade.notEnoughCoins');

    // The client only ever holds net ids ("p42"); accept either form so it
    // does not have to know how the simulation names its entities.
    const targetId = String(payload.targetId ?? '').replace(/^p/, '');
    const target = await tx.get(
      'SELECT id, name FROM characters WHERE id = ? AND world_id = ? AND deleted_at IS NULL',
      [targetId, instance.id]);
    if (!target) throw new HttpError(404, 'error.notFound');
    if (String(target.id) === String(characterId)) throw fail('error.validation');

    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [amount, characterId]);
    const id = await tx.insert('bounties', {
      world_id: instance.id, target_id: target.id, placed_by: characterId,
      amount, reason: String(payload.reason ?? '').slice(0, 200), created_at: Date.now(),
    });
    return { bountyId: id, target: target.name, amount };
  });
}

/** Open bounties in a world. */
export async function listBounties(worldId) {
  const db = getDatabase();
  const rows = await db.all(
    `SELECT b.id, b.amount, b.reason, b.created_at, c.name AS target_name
     FROM bounties b JOIN characters c ON c.id = b.target_id
     WHERE b.world_id = ? AND b.claimed_at IS NULL ORDER BY b.amount DESC LIMIT 50`, [worldId]);
  return rows.map((row) => ({
    id: row.id, amount: Number(row.amount), reason: row.reason,
    target: row.target_name, at: Number(row.created_at),
  }));
}
