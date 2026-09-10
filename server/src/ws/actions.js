/**
 * Action dispatch for the WebSocket gateway.
 *
 * Maps protocol action names to the authoritative handlers in game/actions.js
 * and refreshes the in-memory player entity afterwards, so a purchase that
 * changes cargo weight or a repair that changes hull is reflected in the very
 * next simulation tick rather than at the next reload.
 */
import * as actions from '../game/actions.js';
import * as exploration from '../game/exploration.js';
import * as combat from '../game/combat.js';
import * as missions from '../game/missions.js';
import * as social from '../game/social.js';
import * as market from '../game/market.js';
import * as exchange from '../game/exchange.js';
import * as world from '../game/world.js';
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

  'explore.land': exploration.land,
  'explore.gather': exploration.gather,
  'explore.name': exploration.proposeName,

  'combat.fire': combat.fire,
  'combat.flee': combat.flee,
  'combat.board': combat.board,
  'combat.salvage': combat.salvage,
  'combat.bounty': combat.placeBounty,
  'ship.arm': combat.armShip,

  'mission.accept': missions.accept,
  'mission.abandon': missions.abandon,
  'mission.complete': missions.complete,

  'friend.add': social.addFriend,
  'friend.accept': social.acceptFriend,
  'friend.remove': social.removeFriend,
  'convoy.create': social.createConvoy,
  'convoy.join': social.joinConvoy,
  'convoy.leave': social.leaveConvoy,
  'convoy.invite': social.createConvoy,
  'guild.create': social.createGuild,
  'guild.join': social.joinGuild,
  'guild.leave': social.leaveGuild,
  'guild.deposit': social.depositGuild,
  'guild.withdraw': social.withdrawGuild,

  'trade.propose': exchange.propose,
  'trade.set': exchange.setOffer,
  'trade.confirm': exchange.confirm,
  'trade.cancel': exchange.cancel,

  'warehouse.rent': world.rentWarehouse,
  'warehouse.move': world.storeGoods,
  'rumour.buy': world.buyRumour,
  'treasure.dig': world.digTreasure,

  'market.list': market.createListing,
  'market.buyout': market.buyout,
  'market.bid': market.bid,
  'market.cancel': market.cancelListing,
  'market.buy': market.buyListing,
  'insurance.buy': market.buyInsurance,
  'insurance.claim': market.claimInsurance,
  'route.create': market.createRoute,
  'route.delete': market.deleteRoute,
  'outpost.build': market.buildOutpost,
  'outpost.building': market.buildBuilding,
};

/**
 * Actions after which the player's cached state must be recomputed and pushed.
 * Anything that moves coins, cargo, crew or the ship belongs here - the client
 * never computes those numbers itself, so if the server does not send them the
 * HUD silently goes stale.
 */
const REFRESH_AFTER = new Set([
  'trade.buy', 'trade.sell',
  'ship.buy', 'ship.repair', 'ship.upgrade', 'ship.switch', 'ship.rename',
  'crew.hire', 'crew.dismiss', 'crew.pay',
  'bank.deposit', 'bank.withdraw', 'bank.loan', 'bank.repay',
  'code.redeem',
  'port.dock', 'port.leave',
  'explore.gather', 'combat.board', 'combat.salvage', 'ship.arm',
  'mission.accept', 'mission.complete', 'mission.abandon',
  'guild.create', 'guild.deposit', 'guild.withdraw',
  'trade.confirm',
  'warehouse.rent', 'warehouse.move', 'rumour.buy', 'treasure.dig',
  'market.list', 'market.buy', 'market.buyout', 'market.bid', 'market.cancel',
  'insurance.buy', 'insurance.claim', 'route.create', 'route.delete',
  'outpost.build', 'outpost.building',
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
    player.combatBonus = aggregateCrewBonus(character.crew).combat ?? 1;
    player.cannons = character.ship.cannons;
    player.ammunition = character.ship.ammunition;
  }

  // The client keeps its own copy of coins and cargo; push the truth.
  conn.send({ t: 'event', kind: 'characterUpdate', character });
  return character;
}
