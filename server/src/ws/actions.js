/**
 * Action dispatch for the WebSocket gateway.
 *
 * Maps protocol action names to the authoritative handlers in game/actions.js
 * and refreshes the in-memory player entity afterwards, so a purchase that
 * changes cargo weight or a repair that changes hull is reflected in the very
 * next simulation tick rather than at the next reload.
 */
import * as actions from '../game/actions.js';
import { getDatabase } from '../db/index.js';
import { loadCharacter, cargoUsage } from '../game/characters.js';
import { effectiveStats } from '@schiffi/shared/data/ships.js';
import { aggregateCrewBonus } from '@schiffi/shared/data/crew.js';
import { crewFactorFor } from './gateway.js';
import { HttpError } from '../http/respond.js';

const HANDLERS = {
  'port.dock': actions.dock,
  'port.leave': actions.leavePort,
  'trade.buy': actions.buy,
  'trade.sell': actions.sell,
  'ship.buy': actions.buyShip,
  'ship.repair': actions.repairShip,
  'ship.upgrade': actions.upgradeShip,
  'ship.rename': actions.renameShip,
  'ship.switch': actions.switchShip,
  'crew.hire': actions.hireCrew,
  'crew.dismiss': actions.dismissCrew,
  'crew.pay': actions.payWages,
  'bank.deposit': actions.bankDeposit,
  'bank.withdraw': actions.bankWithdraw,
  'bank.loan': actions.takeLoan,
  'bank.repay': actions.repayLoan,
  'code.redeem': actions.redeem,
};

/** Actions after which the player's cached ship state must be recomputed. */
const REFRESH_AFTER = new Set([
  'trade.buy', 'trade.sell', 'ship.buy', 'ship.repair', 'ship.upgrade',
  'ship.switch', 'crew.hire', 'crew.dismiss', 'crew.pay', 'port.dock', 'port.leave',
]);

export async function dispatchAction(gateway, conn, name, payload) {
  const handler = HANDLERS[name];
  if (!handler) throw new HttpError(400, 'error.validation', `action ${name} is not implemented yet`);

  const player = conn.player;
  const result = await handler({
    instance: conn.instance,
    characterId: player.characterId,
    userId: player.userId,
    payload,
    gateway,
    conn,
  });

  if (name === 'port.dock') { player.docked = true; player.input.x = 0; player.input.y = 0; }
  if (name === 'port.leave') player.docked = false;

  if (REFRESH_AFTER.has(name)) await refreshPlayer(conn);
  return result;
}

/** Re-read the character's authoritative state into the live entity. */
export async function refreshPlayer(conn) {
  const db = getDatabase();
  const player = conn.player;
  const character = await loadCharacter(player.characterId);

  player.displayName = character.name;
  player.docked = character.docked;
  player.shipId = character.ship?.id ?? null;

  if (character.ship) {
    const stats = effectiveStats(
      character.ship.classKey, character.ship.upgrades, aggregateCrewBonus(character.crew));
    player.stats = stats;
    player.hull = character.ship.hull;
    player.sail = character.ship.sail;
    player.maxHull = stats.hull;
    const { weight } = await cargoUsage(character.ship.id);
    player.cargoWeight = weight;
    player.crewFactor = crewFactorFor(character.crew, stats);
  }

  // The client keeps its own copy of coins and cargo; push the truth.
  conn.send({ t: 'event', kind: 'characterUpdate', character });
  return character;
}
