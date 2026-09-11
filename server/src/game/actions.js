/**
 * Server-authoritative game actions.
 *
 * Every action that changes coins, cargo, ships or progress runs here, inside
 * one database transaction, on values the server computed itself.  The client
 * sends intent ("buy 12 of good 431 in port p17"); it never sends a price, a
 * balance or a result.  A tampered client can therefore ask for the wrong
 * thing, but it cannot make the wrong thing happen.
 */
import { getDatabase } from '../db/index.js';
import config from '../config.js';
import { HttpError } from '../http/respond.js';
import { goodById } from '@schiffi/shared/data/goods.js';
import { shipClass, SHIP_CLASSES, effectiveStats, upgradeCost, UPGRADE_BY_KEY, repairPrice } from '@schiffi/shared/data/ships.js';
import { generateCrewMember, wageFor, hireCost, aggregateCrewBonus, ROLE_BY_KEY } from '@schiffi/shared/data/crew.js';
import { isContraband, tariffFor, repTier, FACTION_BY_KEY } from '@schiffi/shared/data/factions.js';
import { dist } from '@schiffi/shared/util/math.js';
import { CELL_SIZE } from '@schiffi/shared/world/constants.js';
import { applyTrade, marketFor, reputationMap, derivePrice, seasonMultiplier } from './economy.js';
import { addCargo, removeCargo, cargoUsage, describeShip, describeCrew } from './characters.js';
import { redeemCode } from './codes.js';

/** How close a ship must be to a port to dock, in world units. */
const DOCK_RANGE = CELL_SIZE * 3.5;

const fail = (code, message = code) => new HttpError(400, code, message);

/**
 * Load the rows an action needs and assert the character belongs to the user.
 * Everything downstream can then trust `character`, `ship` and `instance`.
 */
async function context(tx, { instance, characterId, userId }) {
  const character = await tx.get(
    'SELECT * FROM characters WHERE id = ? AND deleted_at IS NULL', [characterId]);
  if (!character) throw new HttpError(404, 'error.notFound', 'character not found');
  if (userId && String(character.user_id) !== String(userId)) {
    throw new HttpError(403, 'error.forbidden', 'not your character');
  }
  if (String(character.world_id) !== String(instance.id)) {
    throw new HttpError(400, 'error.validation', 'character belongs to another world');
  }
  const ship = await tx.get('SELECT * FROM ships WHERE id = ?', [character.active_ship_id]);
  const crew = ship ? await tx.all('SELECT * FROM crew_members WHERE ship_id = ?', [ship.id]) : [];
  return { character, ship, crew };
}

function requireDocked(character, instance) {
  if (character.docked !== 1 || !character.current_port_id) throw fail('error.notInPort');
  const port = instance.portsById.get(character.current_port_id);
  if (!port) throw fail('error.notInPort');
  return port;
}

function shipStats(ship, crew) {
  const upgrades = typeof ship.upgrades === 'string' ? JSON.parse(ship.upgrades || '{}') : (ship.upgrades ?? {});
  return effectiveStats(ship.class_key, upgrades, aggregateCrewBonus(crew.map(describeCrew)));
}

// ---------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------

export async function dock({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const { character } = await context(tx, { instance, characterId, userId });
    const port = instance.portsById.get(payload.portId);
    if (!port) throw fail('error.notFound', 'unknown port');

    // character.x/y is the last persisted position, up to an in-game hour
    // stale (see simulation.js persistPlayers). The live position kept in
    // instance.players is authoritative for a connected ship.
    const player = instance.players.get(`p${characterId}`);
    const x = Number(player?.x ?? character.x);
    const y = Number(player?.y ?? character.y);
    const distance = dist(x, y, port.x, port.y);
    if (distance > DOCK_RANGE) throw fail('error.tooFar');

    await tx.run(
      'UPDATE characters SET docked = 1, current_port_id = ?, x = ?, y = ?, last_seen_at = ? WHERE id = ?',
      [port.id, port.x, port.y, Date.now(), characterId]);
    await tx.run(
      'UPDATE player_stats SET ports_visited = ports_visited + 1, updated_at = ? WHERE character_id = ?',
      [Date.now(), characterId]);

    return { docked: true, portId: port.id, portName: port.name };
  });
}

export async function leavePort({ instance, characterId, userId }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const { character, ship, crew } = await context(tx, { instance, characterId, userId });
    if (character.docked !== 1) return { docked: false };
    if (!ship) throw fail('error.validation', 'no ship');

    // A ship with no crew and no hull does not put to sea.
    if (crew.length === 0) throw fail('crew.understaffed');
    if (Number(ship.hull) <= 0) throw fail('ship.damaged');

    await tx.run('UPDATE characters SET docked = 0, last_seen_at = ? WHERE id = ?', [Date.now(), characterId]);
    return { docked: false, portId: character.current_port_id };
  });
}

// ---------------------------------------------------------------------------
// trade
// ---------------------------------------------------------------------------

export async function buy({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  const qty = Math.floor(Number(payload.qty));
  if (!Number.isFinite(qty) || qty <= 0 || qty > 100_000) throw fail('error.validation');
  const good = goodById(Number(payload.goodId));
  if (!good) throw fail('error.notFound', 'unknown good');

  return db.tx(async (tx) => {
    const { character, ship, crew } = await context(tx, { instance, characterId, userId });
    const port = requireDocked(character, instance);

    const row = await tx.get(
      'SELECT * FROM port_market WHERE world_id = ? AND port_id = ? AND good_id = ?',
      [instance.id, port.id, good.id]);
    if (!row) throw fail('error.notFound', 'this port does not trade that');

    const available = Math.floor(Number(row.stock));
    // Leave one unit so the price model never divides by an empty market.
    if (qty > available - 1) throw fail('trade.notEnoughStock');

    const reputation = await tx.get(
      'SELECT value FROM reputation WHERE character_id = ? AND faction_key = ?',
      [characterId, port.factionKey]);
    const rep = Number(reputation?.value ?? 0);
    const tier = repTier(rep);
    const tariff = tariffFor(port.factionKey, good, rep);

    const unitPrice = derivePrice(good, {
      stock: Number(row.stock), baseStock: Number(row.base_stock), demand: Number(row.demand),
    }, { season: seasonMultiplier(good, instance.season ?? 0), faction: tier.priceMul });

    const unitCost = Math.max(1, Math.round(unitPrice * (1 + good.spread) * (1 + tariff)));
    const total = unitCost * qty;

    if (Number(character.coins) < total) throw fail('trade.notEnoughCoins');

    const stats = shipStats(ship, crew);
    const { used } = await cargoUsage(ship.id, tx);
    if (used + good.vol * qty > stats.cargo) throw fail('trade.notEnoughSpace');

    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [total, characterId]);
    await addCargo(tx, ship.id, good.id, qty, unitCost, 1);
    await applyTrade(tx, instance, port.id, good.id, -qty);
    await tx.run(
      'UPDATE player_stats SET goods_bought = goods_bought + ?, coins_spent = coins_spent + ?, updated_at = ? ' +
      'WHERE character_id = ?', [qty, total, Date.now(), characterId]);

    return {
      goodId: good.id, qty, unitPrice: unitCost, total,
      tariff: Math.round(tariff * 1000) / 1000,
      coins: Number(character.coins) - total,
      contraband: isContraband(port.factionKey, good),
    };
  });
}

export async function sell({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  const qty = Math.floor(Number(payload.qty));
  if (!Number.isFinite(qty) || qty <= 0 || qty > 100_000) throw fail('error.validation');
  const good = goodById(Number(payload.goodId));
  if (!good) throw fail('error.notFound', 'unknown good');

  return db.tx(async (tx) => {
    const { character, ship } = await context(tx, { instance, characterId, userId });
    const port = requireDocked(character, instance);

    const lots = await tx.all(
      'SELECT qty, freshness FROM cargo WHERE ship_id = ? AND good_id = ?', [ship.id, good.id]);
    const heldQty = lots.reduce((sum, lot) => sum + Number(lot.qty), 0);
    if (heldQty === 0) throw fail('trade.nothingToSell');
    if (qty > heldQty) throw fail('trade.nothingToSell');

    const row = await tx.get(
      'SELECT * FROM port_market WHERE world_id = ? AND port_id = ? AND good_id = ?',
      [instance.id, port.id, good.id]);
    // A port that does not trade a good still buys it, at a discount.
    const market = row ?? {
      stock: good.price, base_stock: good.price, demand: good.price * 0.4,
    };

    const reputation = await tx.get(
      'SELECT value FROM reputation WHERE character_id = ? AND faction_key = ?',
      [characterId, port.factionKey]);
    const rep = Number(reputation?.value ?? 0);
    const tier = repTier(rep);

    const unitPrice = derivePrice(good, {
      stock: Number(market.stock), baseStock: Number(market.base_stock), demand: Number(market.demand),
    }, { season: seasonMultiplier(good, instance.season ?? 0), faction: 2 - tier.priceMul });

    // Freshness is averaged over the lots actually sold, oldest first.
    const { removed, costBasis, freshness } = await removeCargoWithFreshness(tx, ship.id, good.id, qty);
    if (removed !== qty) throw fail('trade.nothingToSell');

    const contraband = isContraband(port.factionKey, good);
    let unitRevenue = unitPrice * (1 - good.spread) * (0.55 + 0.45 * freshness);
    if (!row) unitRevenue *= 0.7;               // no local demand
    if (contraband) unitRevenue *= 1.7;         // black-market premium

    const total = Math.max(1, Math.round(unitRevenue * qty));

    // Smuggling is caught some of the time, and then the cargo is simply gone.
    let seized = false;
    if (contraband) {
      const faction = FACTION_BY_KEY.get(port.factionKey);
      const chance = Math.max(0.05, 0.45 * (1 - (faction?.corruption ?? 0.2)));
      if (Math.random() < chance) {
        seized = true;
        await adjustReputation(tx, characterId, port.factionKey, -8);
        return {
          goodId: good.id, qty, seized: true, total: 0,
          coins: Number(character.coins),
          message: 'trade.contrabandWarning',
        };
      }
    }

    await tx.run('UPDATE characters SET coins = coins + ? WHERE id = ?', [total, characterId]);
    if (row) await applyTrade(tx, instance, port.id, good.id, qty);
    await tx.run(
      'UPDATE player_stats SET goods_sold = goods_sold + ?, coins_earned = coins_earned + ?, updated_at = ? ' +
      'WHERE character_id = ?', [qty, total, Date.now(), characterId]);

    // Honest trade with a faction slowly earns its goodwill.
    if (!contraband && total > 50) await adjustReputation(tx, characterId, port.factionKey, 1);

    return {
      goodId: good.id, qty, unitPrice: Math.round(unitRevenue), total, seized,
      profit: Math.round(total - costBasis),
      coins: Number(character.coins) + total,
    };
  });
}

/** Remove cargo oldest-first and report the average freshness of what went. */
async function removeCargoWithFreshness(tx, shipId, goodId, qty) {
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
  return { removed, costBasis, freshness: removed ? freshnessSum / removed : 1 };
}

async function adjustReputation(tx, characterId, factionKey, delta) {
  const row = await tx.get(
    'SELECT value FROM reputation WHERE character_id = ? AND faction_key = ?', [characterId, factionKey]);
  const next = Math.max(-100, Math.min(100, Number(row?.value ?? 0) + delta));
  if (row) {
    await tx.run('UPDATE reputation SET value = ? WHERE character_id = ? AND faction_key = ?',
      [next, characterId, factionKey]);
  } else {
    await tx.insert('reputation', { character_id: characterId, faction_key: factionKey, value: next });
  }
  return next;
}

// ---------------------------------------------------------------------------
// shipyard
// ---------------------------------------------------------------------------

export async function buyShip({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  const cls = shipClass(payload.classKey);
  if (!cls) throw fail('error.notFound', 'unknown ship class');

  return db.tx(async (tx) => {
    const { character } = await context(tx, { instance, characterId, userId });
    const port = requireDocked(character, instance);
    // A shipyard's tier is limited by the port's size.
    if (cls.tier > port.size + 1) throw fail('error.validation', 'this shipyard cannot build that class');
    if (Number(character.coins) < cls.price) throw fail('trade.notEnoughCoins');

    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [cls.price, characterId]);
    const shipId = await tx.insert('ships', {
      character_id: characterId, class_key: cls.key,
      name: payload.name?.slice(0, 40) || `${cls.key}-${Date.now().toString(36).slice(-4)}`,
      hull: cls.hull, sail: cls.sail, upgrades: '{}',
      cannons: 0, ammunition: 0, stored_at_port: port.id, created_at: Date.now(),
    });
    return { shipId, classKey: cls.key, price: cls.price, coins: Number(character.coins) - cls.price };
  });
}

export async function repairShip({ instance, characterId, userId }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const { character, ship, crew } = await context(tx, { instance, characterId, userId });
    requireDocked(character, instance);
    const stats = shipStats(ship, crew);

    const missingHull = Math.max(0, stats.hull - Number(ship.hull));
    const missingSail = Math.max(0, stats.sail - Number(ship.sail));
    if (missingHull < 0.5 && missingSail < 0.5) return { repaired: false, cost: 0 };

    const cost = repairPrice(ship.class_key, missingHull) + Math.ceil(missingSail * 0.6);
    if (Number(character.coins) < cost) throw fail('trade.notEnoughCoins');

    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [cost, characterId]);
    await tx.run('UPDATE ships SET hull = ?, sail = ? WHERE id = ?', [stats.hull, stats.sail, ship.id]);
    return { repaired: true, cost, hull: stats.hull, sail: stats.sail, coins: Number(character.coins) - cost };
  });
}

export async function upgradeShip({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  const upgrade = UPGRADE_BY_KEY.get(payload.upgradeKey);
  if (!upgrade) throw fail('error.notFound', 'unknown upgrade');

  return db.tx(async (tx) => {
    const { character, ship } = await context(tx, { instance, characterId, userId });
    const port = requireDocked(character, instance);
    const cls = shipClass(ship.class_key);
    if (cls.tier < upgrade.requiresTier) throw fail('error.validation', 'this hull cannot take that upgrade');
    if (port.size < 1) throw fail('error.validation', 'this port has no shipyard');

    const upgrades = typeof ship.upgrades === 'string' ? JSON.parse(ship.upgrades || '{}') : (ship.upgrades ?? {});
    const level = Number(upgrades[upgrade.key] ?? 0);
    const cost = upgradeCost(upgrade.key, level);
    if (cost === null) throw fail('error.validation', 'already at maximum level');
    if (Number(character.coins) < cost) throw fail('trade.notEnoughCoins');

    upgrades[upgrade.key] = level + 1;
    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [cost, characterId]);
    await tx.run('UPDATE ships SET upgrades = ? WHERE id = ?', [JSON.stringify(upgrades), ship.id]);

    // A bigger hold or a stronger hull takes effect immediately.
    const crew = await tx.all('SELECT * FROM crew_members WHERE ship_id = ?', [ship.id]);
    const stats = effectiveStats(ship.class_key, upgrades, aggregateCrewBonus(crew.map(describeCrew)));
    if (upgrade.stat === 'hull') await tx.run('UPDATE ships SET hull = ? WHERE id = ?', [stats.hull, ship.id]);

    return { upgradeKey: upgrade.key, level: level + 1, cost, coins: Number(character.coins) - cost, stats };
  });
}

export async function renameShip({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  const name = String(payload.name ?? '').trim().slice(0, 40);
  if (name.length < 2) throw fail('error.validation');
  return db.tx(async (tx) => {
    const { ship } = await context(tx, { instance, characterId, userId });
    await tx.run('UPDATE ships SET name = ? WHERE id = ?', [name, ship.id]);
    return { name };
  });
}

export async function switchShip({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const { character } = await context(tx, { instance, characterId, userId });
    const port = requireDocked(character, instance);
    const target = await tx.get('SELECT * FROM ships WHERE id = ? AND character_id = ?',
      [payload.shipId, characterId]);
    if (!target) throw fail('error.notFound', 'no such ship');
    if (target.stored_at_port && target.stored_at_port !== port.id) {
      throw fail('error.validation', 'that ship is berthed in another port');
    }
    await tx.run('UPDATE ships SET stored_at_port = ? WHERE id = ?', [port.id, character.active_ship_id]);
    await tx.run('UPDATE ships SET stored_at_port = NULL WHERE id = ?', [target.id]);
    await tx.run('UPDATE characters SET active_ship_id = ? WHERE id = ?', [target.id, characterId]);
    return { shipId: target.id, classKey: target.class_key };
  });
}

// ---------------------------------------------------------------------------
// crew
// ---------------------------------------------------------------------------

export async function hireCrew({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const { character, ship, crew } = await context(tx, { instance, characterId, userId });
    const port = requireDocked(character, instance);
    const stats = shipStats(ship, crew);
    if (crew.length >= stats.crewSlots) throw fail('error.validation', 'no free berths');

    // The hiring hall's offers are deterministic, so a client cannot reroll
    // them by reconnecting: slot index selects one of the same candidates.
    const slot = Math.max(0, Math.min(19, Math.floor(Number(payload.slot ?? 0))));
    const candidate = generateCrewMember(instance.seed, port.id, slot + hireEpoch(instance), port.size);
    const role = ROLE_BY_KEY.get(candidate.role);
    if (role && role.maxPerShip <= crew.filter((c) => c.role === candidate.role).length) {
      throw fail('error.validation', 'that post is already filled');
    }

    const wage = wageFor(candidate);
    const fee = hireCost(candidate);
    if (Number(character.coins) < fee) throw fail('trade.notEnoughCoins');

    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [fee, characterId]);
    const id = await tx.insert('crew_members', {
      ship_id: ship.id, name: candidate.name, role: candidate.role, spec: candidate.spec,
      level: candidate.level, xp: candidate.xp, morale: candidate.morale,
      health: candidate.health, wage, hired_at: Date.now(),
    });
    return { crewId: id, name: candidate.name, role: candidate.role, wage, fee,
      coins: Number(character.coins) - fee };
  });
}

export async function dismissCrew({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const { ship } = await context(tx, { instance, characterId, userId });
    const member = await tx.get('SELECT * FROM crew_members WHERE id = ? AND ship_id = ?',
      [payload.crewId, ship.id]);
    if (!member) throw fail('error.notFound');
    await tx.run('DELETE FROM crew_members WHERE id = ?', [member.id]);
    // The rest of the crew notices.
    await tx.run('UPDATE crew_members SET morale = GREATEST(0, morale - 4) WHERE ship_id = ?', [ship.id]);
    return { crewId: member.id, dismissed: true };
  });
}

export async function payWages({ instance, characterId, userId }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const { character, ship, crew } = await context(tx, { instance, characterId, userId });
    requireDocked(character, instance);
    const total = crew.reduce((sum, c) => sum + Number(c.wage), 0);
    if (total === 0) return { paid: 0 };
    if (Number(character.coins) < total) throw fail('trade.notEnoughCoins');

    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [total, characterId]);
    await tx.run('UPDATE crew_members SET morale = LEAST(100, morale + 9) WHERE ship_id = ?', [ship.id]);
    return { paid: total, coins: Number(character.coins) - total, crewCount: crew.length };
  });
}

/** Hiring-hall offers rotate roughly every six game hours. */
function hireEpoch(instance) {
  return Math.floor((instance.gameTimeMs ?? 0) / (6 * 3_600_000)) * 20;
}

export function crewOffers(instance, port, count = 8) {
  const epoch = hireEpoch(instance);
  return Array.from({ length: count }, (_, slot) => {
    const candidate = generateCrewMember(instance.seed, port.id, slot + epoch, port.size);
    return {
      slot,
      name: candidate.name,
      role: candidate.role,
      spec: candidate.spec,
      level: candidate.level,
      morale: candidate.morale,
      health: candidate.health,
      wage: wageFor(candidate),
      fee: hireCost(candidate),
    };
  });
}

// ---------------------------------------------------------------------------
// bank
// ---------------------------------------------------------------------------

export async function bankDeposit({ instance, characterId, userId, payload }) {
  const amount = Math.floor(Number(payload.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw fail('error.validation');
  const db = getDatabase();
  return db.tx(async (tx) => {
    const { character } = await context(tx, { instance, characterId, userId });
    requireDocked(character, instance);
    if (Number(character.coins) < amount) throw fail('trade.notEnoughCoins');
    await tx.run('UPDATE characters SET coins = coins - ?, bank_balance = bank_balance + ? WHERE id = ?',
      [amount, amount, characterId]);
    return { coins: Number(character.coins) - amount, bank: Number(character.bank_balance) + amount };
  });
}

export async function bankWithdraw({ instance, characterId, userId, payload }) {
  const amount = Math.floor(Number(payload.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw fail('error.validation');
  const db = getDatabase();
  return db.tx(async (tx) => {
    const { character } = await context(tx, { instance, characterId, userId });
    requireDocked(character, instance);
    if (Number(character.bank_balance) < amount) throw fail('trade.notEnoughCoins');
    await tx.run('UPDATE characters SET coins = coins + ?, bank_balance = bank_balance - ? WHERE id = ?',
      [amount, amount, characterId]);
    return { coins: Number(character.coins) + amount, bank: Number(character.bank_balance) - amount };
  });
}

/** Credit limit scales with net worth and level: no free money for beginners. */
export function creditLimit(character) {
  return Math.floor(500 + Number(character.bank_balance) * 0.5 + Number(character.level) * 750);
}

export async function takeLoan({ instance, characterId, userId, payload }) {
  const amount = Math.floor(Number(payload.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw fail('error.validation');
  const db = getDatabase();
  return db.tx(async (tx) => {
    const { character } = await context(tx, { instance, characterId, userId });
    requireDocked(character, instance);

    const open = await tx.all('SELECT outstanding FROM loans WHERE character_id = ? AND repaid_at IS NULL',
      [characterId]);
    const debt = open.reduce((sum, l) => sum + Number(l.outstanding), 0);
    const limit = creditLimit(character);
    if (debt + amount > limit) throw fail('error.validation', 'over your credit limit');

    // Worse standing, worse rate.
    const rate = 0.08 + Math.min(0.14, debt / Math.max(1, limit) * 0.12);
    const due = Date.now() + 14 * 86_400_000;
    const id = await tx.insert('loans', {
      character_id: characterId, principal: amount,
      outstanding: Math.ceil(amount * (1 + rate)),
      rate, taken_at: Date.now(), due_at: due,
    });
    await tx.run('UPDATE characters SET coins = coins + ? WHERE id = ?', [amount, characterId]);
    return { loanId: id, amount, rate: Math.round(rate * 1000) / 10, dueAt: due,
      coins: Number(character.coins) + amount };
  });
}

export async function repayLoan({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const { character } = await context(tx, { instance, characterId, userId });
    const loan = await tx.get('SELECT * FROM loans WHERE id = ? AND character_id = ? AND repaid_at IS NULL',
      [payload.loanId, characterId]);
    if (!loan) throw fail('error.notFound');

    const amount = Math.min(Math.floor(Number(payload.amount ?? loan.outstanding)), Number(loan.outstanding));
    if (amount <= 0) throw fail('error.validation');
    if (Number(character.coins) < amount) throw fail('trade.notEnoughCoins');

    const remaining = Number(loan.outstanding) - amount;
    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [amount, characterId]);
    await tx.run('UPDATE loans SET outstanding = ?, repaid_at = ? WHERE id = ?',
      [remaining, remaining === 0 ? Date.now() : null, loan.id]);
    return { loanId: loan.id, paid: amount, outstanding: remaining, coins: Number(character.coins) - amount };
  });
}

// ---------------------------------------------------------------------------
// secret codes
// ---------------------------------------------------------------------------

export async function redeem({ instance, characterId, userId, payload }) {
  return redeemCode({ instance, characterId, userId, code: payload.code });
}

export { DOCK_RANGE, adjustReputation, shipStats, context as actionContext, requireDocked };
