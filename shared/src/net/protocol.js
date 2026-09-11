/**
 * Wire protocol shared by client and server.
 *
 * Messages are JSON objects `{ t, ...payload }` where `t` is one of MSG.
 * Snapshots are the hot path and use short field names; everything else
 * favours readability, because it happens at most a few times per second.
 */

export const PROTOCOL_VERSION = 1;

export const MSG = {
  // client -> server
  HELLO: 'hello',
  INPUT: 'input',
  PING: 'ping',
  CHAT_SEND: 'chat.send',
  ACTION: 'action',          // { action: 'trade.buy', ... } - all authoritative
  SUBSCRIBE: 'subscribe',    // request a viewport / channel

  // server -> client
  WELCOME: 'welcome',
  SNAPSHOT: 'snapshot',
  PONG: 'pong',
  CHAT: 'chat',
  EVENT: 'event',            // world events, weather, notifications
  RESULT: 'result',          // response to an ACTION, correlated by `rid`
  ERROR: 'error',
  KICK: 'kick',
};

/** Entity kinds carried in snapshots. */
export const ENTITY = {
  PLAYER_SHIP: 1,
  NPC_SHIP: 2,
  STORM: 3,
  WRECK: 4,
  ANIMAL: 5,
  CANNONBALL: 6,
};

/** Server-side authoritative action names, grouped for permission checks. */
export const ACTIONS = [
  'trade.buy', 'trade.sell',
  'port.dock', 'port.leave',
  'ship.buy', 'ship.repair', 'ship.upgrade', 'ship.rename', 'ship.switch',
  'crew.hire', 'crew.dismiss', 'crew.pay',
  'mission.accept', 'mission.abandon', 'mission.complete',
  'explore.land', 'explore.gather', 'explore.name',
  'combat.fire', 'combat.flee', 'combat.board', 'combat.salvage', 'combat.bounty',
  'ship.arm',
  'bank.deposit', 'bank.withdraw', 'bank.loan', 'bank.repay',
  'market.list', 'market.bid', 'market.buyout', 'market.cancel', 'market.buy',
  'guild.create', 'guild.join', 'guild.leave', 'guild.deposit', 'guild.withdraw',
  'convoy.create', 'convoy.join', 'convoy.leave', 'convoy.invite',
  'trade.propose', 'trade.set', 'trade.confirm', 'trade.cancel',
  'warehouse.rent', 'warehouse.move', 'rumour.buy', 'treasure.dig',
  'friend.add', 'friend.remove', 'friend.accept',
  'code.redeem',
  'route.create', 'route.delete', 'outpost.build', 'outpost.building', 'outpost.capture',
  'insurance.buy', 'insurance.claim',
];

export const ACTION_SET = new Set(ACTIONS);

/** Movement input, sent at a fixed rate; direction is a normalised vector. */
export function encodeInput(seq, dx, dy, dt) {
  return { t: MSG.INPUT, s: seq, x: Math.round(dx * 1000) / 1000, y: Math.round(dy * 1000) / 1000, d: dt };
}
