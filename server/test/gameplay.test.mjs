/**
 * Gameplay integration test.
 *
 * Exercises the systems that were added after the core loop: going ashore and
 * claiming a first discovery, contracts, gunnery, companies and the auction
 * house. It talks to the same authoritative handlers the WebSocket dispatches
 * to, with a real database and a real world underneath.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { useTestDatabase } from './testdb.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
// Everything the suite writes lives in one throwaway directory: the
// repository's own data/ belongs to the running game, not to the tests.
const TEST_DIR = resolve(tmpdir(), `schiffi-gameplay-${process.pid}`);
const TEST_DB = resolve(TEST_DIR, 'gameplay.db');
mkdirSync(TEST_DIR, { recursive: true });
process.env.UPLOADS_DIR = resolve(TEST_DIR, 'uploads');
process.env.MAIL_SPOOL_DIR = resolve(TEST_DIR, 'mail');

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.SESSION_SECRET = 'gameplay-test-'.padEnd(64, 'q');
process.env.DEFAULT_WORLD_SEED = '13371337';
process.env.SMTP_HOST = '';

// Empty database, SQLite or PostgreSQL depending on TEST_DATABASE_URL.
await useTestDatabase(TEST_DB);

let server;
let db;
let instance;
let userId;
let characterId;

before(async () => {

  const { bootstrap } = await import('../src/index.js');
  server = await bootstrap({ listen: false });
  db = server.db;

  const { getLoadedWorld, loadedWorlds } = await import('../src/game/worldManager.js');
  instance = loadedWorlds()[0];

  const auth = await import('../src/services/auth.js');
  const registered = await auth.register({
    email: 'gameplay@example.org', username: 'Gameplay',
    password: 'Nordwind-Segel-42', locale: 'de', ip: '127.0.0.1',
  });
  userId = registered.userId;

  const { createCharacter } = await import('../src/game/characters.js');
  characterId = await createCharacter(
    { userId, worldId: instance.id, name: 'Forscher', mode: 'explorer' }, instance);

  // Put a live player entity in the world, as the gateway would on join.
  const { loadCharacter } = await import('../src/game/characters.js');
  const character = await loadCharacter(characterId);
  const { effectiveStats } = await import('@schiffi/shared/data/ships.js');
  const stats = effectiveStats(character.ship.classKey, character.ship.upgrades, {});
  instance.players.set(`p${characterId}`, {
    netId: `p${characterId}`, kind: 1, characterId: String(characterId), userId: String(userId),
    displayName: character.name, x: character.x, y: character.y, heading: 0,
    vx: 0, vy: 0, speed: 0, hull: character.ship.hull, sail: character.ship.sail,
    maxHull: stats.hull, shipId: character.ship.id, stats, docked: character.docked,
    input: { x: 0, y: 0 }, combatBonus: 1, protected: false, cargoWeight: 0, crewFactor: 1,
  });
});

after(async () => {
  await server?.shutdown();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Give the character coins through the database, as a fixture would. */
async function grant(coins) {
  await db.run('UPDATE characters SET coins = coins + ? WHERE id = ?', [coins, characterId]);
}

/** Move the live player and the stored character to a position. */
async function moveTo(x, y, { docked = false, portId = null } = {}) {
  const player = instance.players.get(`p${characterId}`);
  player.x = x; player.y = y; player.docked = docked;
  await db.run('UPDATE characters SET x = ?, y = ?, docked = ?, current_port_id = ? WHERE id = ?',
    [x, y, docked ? 1 : 0, portId, characterId]);
}

// --- exploration -----------------------------------------------------------

test('landing on an uncharted island claims the first discovery exactly once', async () => {
  const exploration = await import('../src/game/exploration.js');
  const anchorage = instance.world.anchorages[0];
  assert.ok(anchorage, 'this world has no uncharted islands to land on');

  await moveTo(anchorage.x, anchorage.y);
  const first = await exploration.land({ instance, characterId, userId });
  assert.equal(first.uncharted, true);
  assert.equal(first.firstDiscovery, true);
  assert.equal(first.firstDiscoveredBy.player, 'Forscher');
  assert.ok(first.survey.terrain, 'no survey was produced');
  assert.ok(first.activities.length > 0, 'nothing can be done on this island');

  // Landing again must not award the discovery a second time.
  const second = await exploration.land({ instance, characterId, userId });
  assert.equal(second.firstDiscovery, false);
  assert.equal(second.firstDiscoveredBy.yours, true);

  const rows = await db.all('SELECT * FROM island_discoveries WHERE world_id = ?', [instance.id]);
  assert.equal(rows.length, 1, 'the discovery was recorded more than once');
});

test('landing is refused when the ship is nowhere near a beach', async () => {
  const exploration = await import('../src/game/exploration.js');
  await moveTo(200, 200);
  await assert.rejects(
    () => exploration.land({ instance, characterId, userId }),
    (error) => error.code === 'error.tooFar');
});

test('a shore party brings real cargo aboard and then has to wait', async () => {
  const exploration = await import('../src/game/exploration.js');
  const anchorage = instance.world.anchorages[0];
  await moveTo(anchorage.x, anchorage.y);

  const landing = await exploration.land({ instance, characterId, userId });
  const activity = landing.activities.find((name) => name !== 'observe_wildlife') ?? landing.activities[0];

  const before = await db.all('SELECT * FROM cargo WHERE ship_id = ?',
    [instance.players.get(`p${characterId}`).shipId]);
  const result = await exploration.gather({
    instance, characterId, userId, payload: { activity },
  });
  assert.equal(result.activity, activity);

  if (activity !== 'observe_wildlife') {
    const after = await db.all('SELECT * FROM cargo WHERE ship_id = ?',
      [instance.players.get(`p${characterId}`).shipId]);
    const gainedUnits = result.gained.reduce((sum, entry) => sum + entry.qty, 0);
    assert.ok(gainedUnits > 0 || result.cargoFull, 'the shore party came back with nothing');
    assert.ok(after.length >= before.length);
  }

  // The same spot is on cooldown.
  await assert.rejects(
    () => exploration.gather({ instance, characterId, userId, payload: { activity } }),
    (error) => error.status === 429);
});

test('only the first discoverer may name the island, and the name is checked', async () => {
  const exploration = await import('../src/game/exploration.js');
  const islandId = instance.world.anchorages[0].islandId;

  await assert.rejects(
    () => exploration.proposeName({ instance, characterId, userId, payload: { islandId, name: '!!' } }),
    (error) => error.code === 'error.validation');

  const named = await exploration.proposeName({
    instance, characterId, userId, payload: { islandId, name: 'Neue Hoffnung' },
  });
  assert.equal(named.name, 'Neue Hoffnung');
  assert.equal(named.status, 'approved');

  // A name that looks like an advert waits for a moderator instead.
  const other = instance.world.anchorages.find((a) => a.islandId !== islandId);
  if (other) {
    await db.insert('island_discoveries', {
      world_id: instance.id, island_id: other.islandId, user_id: userId,
      character_id: characterId, player_name: 'Forscher',
      discovered_at: Date.now(), name_status: 'none',
    });
    const flagged = await exploration.proposeName({
      instance, characterId, userId, payload: { islandId: other.islandId, name: 'Join discord now' },
    });
    assert.equal(flagged.status, 'pending');
  }
});

// --- progression -----------------------------------------------------------

test('experience and levels come from what the character actually did', async () => {
  const row = await db.get('SELECT xp, level FROM characters WHERE id = ?', [characterId]);
  assert.ok(Number(row.xp) > 0, 'the first discovery awarded no experience');

  const { evaluateAchievements } = await import('../src/game/progression.js');
  const unlocked = await evaluateAchievements(characterId);
  const keys = unlocked.map((entry) => entry.key);
  assert.ok(keys.includes('first_island'), `expected first_island, got ${keys.join(', ')}`);
});

// --- missions --------------------------------------------------------------

test('a port posts contracts that can be accepted and completed', async () => {
  const missions = await import('../src/game/missions.js');
  const startPort = instance.portsById.get(instance.world.start.portId);
  await moveTo(startPort.x, startPort.y, { docked: true, portId: startPort.id });
  await grant(50_000);

  // The shore party filled the little boat earlier; a courier will not carry a
  // delivery contract as well, so clear the hold first.
  await db.run('DELETE FROM cargo WHERE ship_id = ?', [instance.players.get(`p${characterId}`).shipId]);

  const board = await missions.boardFor(instance, startPort);
  assert.ok(board.length > 0, 'the notice board is empty');

  // Pick a contract the starting boat can actually carry - which is the point
  // of the small-contract guarantee in the generator.
  const capacity = instance.players.get(`p${characterId}`).stats.cargo;
  const { goodById } = await import('@schiffi/shared/data/goods.js');
  const slotsFor = (mission) => {
    const good = goodById(Number(mission.data.goodId));
    return good ? good.vol * Number(mission.data.qty) : Infinity;
  };
  const delivery = board.find((mission) =>
    (mission.type === 'delivery' || mission.type === 'supply') && slotsFor(mission) <= capacity);
  assert.ok(delivery, `no cargo contract fits ${capacity} slots: ` +
    board.map((m) => `${m.type}/${m.data.qty ?? '-'}`).join(', '));

  const accepted = await missions.accept({
    instance, characterId, userId, payload: { missionId: delivery.id },
  });
  assert.equal(accepted.missionId, delivery.id);

  // The cargo really is in the hold now.
  const lot = await db.get('SELECT * FROM cargo WHERE ship_id = ? AND good_id = ?',
    [instance.players.get(`p${characterId}`).shipId, delivery.data.goodId]);
  assert.ok(lot, 'the contract cargo was never loaded');
  assert.ok(Number(lot.qty) >= delivery.data.qty);

  // Completing in the wrong port must fail.
  await assert.rejects(
    () => missions.complete({ instance, characterId, userId, payload: { missionId: delivery.id } }),
    (error) => error.code === 'error.notInPort');

  // Move to the destination and complete it.
  const destination = instance.portsById.get(delivery.data.toPortId);
  await moveTo(destination.x, destination.y, { docked: true, portId: destination.id });
  const coinsBefore = Number((await db.get('SELECT coins FROM characters WHERE id = ?', [characterId])).coins);
  const done = await missions.complete({
    instance, characterId, userId, payload: { missionId: delivery.id },
  });
  assert.equal(done.reward, delivery.reward);

  const coinsAfter = Number((await db.get('SELECT coins FROM characters WHERE id = ?', [characterId])).coins);
  assert.equal(coinsAfter, coinsBefore + delivery.reward);

  const remaining = await db.get('SELECT * FROM cargo WHERE ship_id = ? AND good_id = ?',
    [instance.players.get(`p${characterId}`).shipId, delivery.data.goodId]);
  assert.ok(!remaining || Number(remaining.qty) < Number(lot.qty), 'the cargo was not handed over');
});

// --- combat ----------------------------------------------------------------

test('guns must be bought before they can be fired', async () => {
  const combat = await import('../src/game/combat.js');
  const startPort = instance.portsById.get(instance.world.start.portId);
  await moveTo(startPort.x, startPort.y, { docked: true, portId: startPort.id });

  const player = instance.players.get(`p${characterId}`);
  // The starting boat has no gun ports at all.
  await assert.rejects(
    () => combat.armShip({ instance, characterId, userId, payload: { cannons: 2 } }),
    (error) => error.status === 400);

  // Give it a hull that can carry guns, then arm it. The hull value has to be
  // reset with the class, exactly as buying a ship would set it.
  const ship = await db.get('SELECT * FROM ships WHERE id = ?', [player.shipId]);
  const { effectiveStats, shipClass } = await import('@schiffi/shared/data/ships.js');
  const armoured = shipClass('armored_trader');
  await db.run("UPDATE ships SET class_key = 'armored_trader', hull = ?, sail = ? WHERE id = ?",
    [armoured.hull, armoured.sail, ship.id]);
  player.stats = effectiveStats('armored_trader', {}, {});
  player.maxHull = player.stats.hull;
  player.hull = armoured.hull;

  const armed = await combat.armShip({
    instance, characterId, userId, payload: { cannons: 4, ammunition: 30 },
  });
  assert.equal(armed.cannons, 4);
  assert.equal(armed.ammunition, 30);
});

test('a broadside damages an NPC and a sinking leaves a wreck', async () => {
  const combat = await import('../src/game/combat.js');
  const player = instance.players.get(`p${characterId}`);
  player.docked = false;
  await db.run('UPDATE characters SET docked = 0 WHERE id = ?', [characterId]);

  const npc = [...instance.npcs.values()][0];
  assert.ok(npc, 'no NPC ships in the world');
  // Bring them alongside each other.
  npc.x = player.x + 40;
  npc.y = player.y;
  npc.hull = 40;
  npc.maxHull = 200;

  const hullBefore = npc.hull;
  const shot = await combat.fire({
    instance, characterId, userId, payload: { targetId: npc.netId, aim: 'hull' },
  });
  assert.ok(shot.hullDamage > 0, 'the broadside did nothing');
  assert.ok(npc.hull < hullBefore || shot.sunk, 'the target took no damage');

  // Firing again immediately hits the reload timer.
  if (!shot.sunk) {
    await assert.rejects(
      () => combat.fire({ instance, characterId, userId, payload: { targetId: npc.netId } }),
      (error) => error.status === 429);
  }

  // Keep firing until it goes down, respecting the reload each time.
  let sunk = shot.sunk;
  for (let i = 0; i < 8 && !sunk; i++) {
    player.reloadedAt = 0;
    const next = await combat.fire({
      instance, characterId, userId, payload: { targetId: npc.netId, aim: 'hull' },
    });
    sunk = next.sunk;
  }
  assert.ok(sunk, 'the NPC never sank');
  assert.ok(sunk.wreckId, 'no wreck was left behind');

  const wreck = await db.get('SELECT * FROM wrecks WHERE id = ?', [sunk.wreckId]);
  assert.ok(wreck, 'the wreck row is missing');
  assert.equal(instance.npcs.has(npc.netId), false, 'the sunk NPC is still sailing');

  const stats = await db.get('SELECT battles_won FROM player_stats WHERE character_id = ?', [characterId]);
  assert.ok(Number(stats.battles_won) >= 1);
});

test('protected waters and newcomers cannot be attacked', async () => {
  const combat = await import('../src/game/combat.js');
  const attacker = instance.players.get(`p${characterId}`);

  const victim = {
    netId: 'p999999', kind: 1, characterId: '999999', displayName: 'Neuling',
    x: attacker.x + 30, y: attacker.y, hull: 100, maxHull: 100, sail: 40,
    docked: false, protected: true, stats: { speed: 40, sail: 40 },
  };
  instance.players.set(victim.netId, victim);

  const blocked = combat.canEngage(instance, attacker, victim);
  assert.ok(blocked, 'a protected newcomer was attackable');

  victim.docked = true;
  victim.protected = false;
  assert.ok(combat.canEngage(instance, attacker, victim), 'a docked player was attackable');
  instance.players.delete(victim.netId);
});

// --- companies and markets -------------------------------------------------

test('a trading company has a treasury with an auditable ledger', async () => {
  const social = await import('../src/game/social.js');
  await grant(100_000);

  const created = await social.createGuild({
    instance, characterId, userId, payload: { name: 'Nordsee-Kompanie', tag: 'NSK' },
  });
  assert.ok(created.guildId);

  await social.depositGuild({ characterId, userId, payload: { amount: 5000, reason: 'seed capital' } });
  const afterDeposit = await social.guildFor(characterId);
  assert.equal(afterDeposit.treasury, 5000);
  assert.equal(afterDeposit.ledger[0].delta, 5000);

  await social.withdrawGuild({ characterId, userId, payload: { amount: 2000, reason: 'wages' } });
  const afterWithdraw = await social.guildFor(characterId);
  assert.equal(afterWithdraw.treasury, 3000);
  assert.equal(afterWithdraw.ledger[0].delta, -2000);
  assert.equal(afterWithdraw.ledger[0].balance, 3000);

  // Over-withdrawing is refused.
  await assert.rejects(
    () => social.withdrawGuild({ characterId, userId, payload: { amount: 999_999 } }),
    (error) => error.code === 'trade.notEnoughCoins');
});

test('listing goods removes them from the hold and cancelling returns them', async () => {
  const market = await import('../src/game/market.js');
  const { addCargo } = await import('../src/game/characters.js');
  const player = instance.players.get(`p${characterId}`);

  // A port with an auction house.
  const bigPort = [...instance.portsById.values()].find((port) => port.size >= 3);
  assert.ok(bigPort, 'this world has no port large enough for an auction house');
  await moveTo(bigPort.x, bigPort.y, { docked: true, portId: bigPort.id });

  await db.tx(async (tx) => { await addCargo(tx, player.shipId, 1, 10, 5, 1); });
  const before = await db.get('SELECT qty FROM cargo WHERE ship_id = ? AND good_id = 1', [player.shipId]);
  assert.ok(Number(before.qty) >= 10);

  const listing = await market.createListing({
    instance, characterId, userId, payload: { goodId: 1, qty: 10, unitPrice: 25 },
  });
  assert.ok(listing.listingId);

  const afterListing = await db.get('SELECT qty FROM cargo WHERE ship_id = ? AND good_id = 1', [player.shipId]);
  assert.ok(!afterListing || Number(afterListing.qty) === Number(before.qty) - 10,
    'the goods were not taken into custody');

  const cancelled = await market.cancelListing({
    instance, characterId, userId, payload: { listingId: listing.listingId },
  });
  assert.equal(cancelled.returned, 10);

  const afterCancel = await db.get('SELECT qty FROM cargo WHERE ship_id = ? AND good_id = 1', [player.shipId]);
  assert.equal(Number(afterCancel.qty), Number(before.qty));
});

test('insurance pays only against damage the server recorded', async () => {
  const market = await import('../src/game/market.js');
  const player = instance.players.get(`p${characterId}`);
  const port = [...instance.portsById.values()].find((entry) => entry.size >= 2);
  await moveTo(port.x, port.y, { docked: true, portId: port.id });
  await grant(60_000);

  // Repair the ship first: the gunnery test left it battered.
  const { shipClass: shipClassFor } = await import('@schiffi/shared/data/ships.js');
  const cls = shipClassFor('armored_trader');
  await db.run('UPDATE ships SET hull = ?, sail = ? WHERE id = ?', [cls.hull, cls.sail, player.shipId]);

  const policy = await market.buyInsurance({ instance, characterId, userId, payload: { days: 7 } });
  assert.ok(policy.premium > 0);

  // An undamaged ship cannot claim.
  await assert.rejects(
    () => market.claimInsurance({ characterId, userId, payload: { policyId: policy.policyId } }),
    (error) => error.status === 400);

  // Record real damage, then claim.
  await db.run('UPDATE ships SET hull = ? WHERE id = ?', [30, player.shipId]);
  const claim = await market.claimInsurance({
    characterId, userId, payload: { policyId: policy.policyId },
  });
  assert.ok(claim.payout > 0, 'a badly damaged insured ship paid nothing');
});

test('an automated trade route buys its ship and then runs on its own', async () => {
  const market = await import('../src/game/market.js');
  await grant(200_000);

  const ports = [...instance.portsById.values()].slice(0, 2).map((port) => port.id);
  const route = await market.createRoute({
    instance, characterId, userId,
    payload: {
      name: 'Salzroute', shipClass: 'merchant_ship', waypoints: ports,
      cargoPlan: [{ goodId: 1, qty: 10 }],
    },
  });
  assert.ok(route.routeId);
  assert.ok(route.cost > 0, 'the route ship was free');

  // Force the first leg to be due and step the routes.
  await db.run('UPDATE trade_routes SET next_arrival_at = ? WHERE id = ?', [Date.now() - 1000, route.routeId]);
  const stepped = await market.stepRoutes(instance);
  assert.ok(stepped >= 1, 'the route did not run');

  const row = await db.get('SELECT runs, leg_index FROM trade_routes WHERE id = ?', [route.routeId]);
  assert.equal(Number(row.runs), 1);
});

// --- trading with another captain -------------------------------------------

/** A second live player, so a trade has two sides. */
async function secondCaptain(name = 'Gegenpart') {
  const auth = await import('../src/services/auth.js');
  const { createCharacter, loadCharacter } = await import('../src/game/characters.js');
  const { effectiveStats } = await import('@schiffi/shared/data/ships.js');

  const registered = await auth.register({
    email: `${name.toLowerCase()}@example.org`, username: name,
    password: 'Treibholz-Anker-77', locale: 'de', ip: '127.0.0.1',
  });
  const id = await createCharacter(
    { userId: registered.userId, worldId: instance.id, name, mode: 'trader' }, instance);
  const character = await loadCharacter(id);
  const stats = effectiveStats(character.ship.classKey, character.ship.upgrades, {});
  instance.players.set(`p${id}`, {
    netId: `p${id}`, kind: 1, characterId: String(id), userId: String(registered.userId),
    displayName: name, x: character.x, y: character.y, heading: 0,
    vx: 0, vy: 0, speed: 0, hull: character.ship.hull, sail: character.ship.sail,
    maxHull: stats.hull, shipId: character.ship.id, stats, docked: false,
    input: { x: 0, y: 0 }, combatBonus: 1, protected: false, cargoWeight: 0, crewFactor: 1,
  });
  return { characterId: id, userId: registered.userId, shipId: character.ship.id };
}

test('an armed captain can capture a nearby rival outpost, while its defence costs ammunition', async () => {
  const market = await import('../src/game/market.js');
  const rival = await secondCaptain('Inselwacht');
  const anchorage = instance.world.anchorages.find((entry) => entry.islandId !== instance.world.anchorages[0].islandId)
    ?? instance.world.anchorages[0];
  const player = instance.players.get(`p${characterId}`);

  // The combat fixture equips this captain, but spell out the campaign
  // precondition here so this test does not depend on a particular test run.
  await db.run('UPDATE ships SET cannons = ?, ammunition = ? WHERE id = ?', [4, 30, player.shipId]);
  await moveTo(anchorage.x, anchorage.y);
  const outpostId = await db.insert('outposts', {
    world_id: instance.id, owner_id: rival.characterId, guild_id: null, island_id: anchorage.islandId,
    name: 'Wacht am Riff', x: anchorage.x, y: anchorage.y, created_at: Date.now(),
  });
  await db.insert('outpost_buildings', {
    outpost_id: outpostId, kind: 'defence', level: 1, built_at: Date.now(),
  });

  const captured = await market.captureOutpost({
    instance, characterId, userId, payload: { outpostId },
  });
  assert.equal(captured.outpostId, outpostId);
  assert.deepEqual(captured.requirements, { defence: 1, cannons: 2, ammunition: 4 });

  const outpost = await db.get('SELECT owner_id, guild_id FROM outposts WHERE id = ?', [outpostId]);
  assert.equal(String(outpost.owner_id), String(characterId));
  const ship = await db.get('SELECT ammunition FROM ships WHERE id = ?', [player.shipId]);
  assert.equal(Number(ship.ammunition), 26, 'the landing did not consume its required ammunition');

  // The public state immediately attributes the island to the new owner.
  const control = await market.seaControlFor(instance);
  assert.equal(String(control.outposts.find((entry) => entry.id === outpostId).ownerId), String(characterId));
});

test('company founders can ratify an alliance that shares sea control and protects allied outposts', async () => {
  const social = await import('../src/game/social.js');
  const market = await import('../src/game/market.js');
  const ally = await secondCaptain('Paktpartner');
  await db.run('UPDATE characters SET coins = coins + ? WHERE id = ?', [100_000, ally.characterId]);
  const alliedGuild = await social.createGuild({
    instance, characterId: ally.characterId, userId: ally.userId,
    payload: { name: 'Westwind Liga', tag: 'WWL' },
  });
  const ownGuild = await social.guildFor(characterId);

  const offered = await social.proposeAlliance({
    instance, characterId, payload: { guildId: alliedGuild.guildId },
  });
  assert.equal(offered.status, 'pending');
  const pending = await social.guildFor(ally.characterId);
  assert.equal(pending.alliances[0].incoming, true);

  const accepted = await social.respondAlliance({
    instance, characterId: ally.characterId, payload: { allianceId: offered.allianceId, accept: true },
  });
  assert.equal(accepted.active, true);

  const anchorage = instance.world.anchorages.at(-1);
  const alliedOutpostId = await db.insert('outposts', {
    world_id: instance.id, owner_id: ally.characterId, guild_id: alliedGuild.guildId,
    island_id: anchorage.islandId, name: 'Westwind-Wacht', x: anchorage.x, y: anchorage.y, created_at: Date.now(),
  });
  const control = await market.seaControlFor(instance);
  const ours = control.outposts.find((entry) => String(entry.guildId) === String(ownGuild.id));
  const theirs = control.outposts.find((entry) => entry.id === alliedOutpostId);
  assert.ok(ours?.allianceId, 'our alliance did not become visible on the map');
  assert.equal(ours.controlId, theirs.controlId, 'allies did not share a territorial score');

  await moveTo(anchorage.x, anchorage.y);
  await assert.rejects(
    () => market.captureOutpost({ instance, characterId, userId, payload: { outpostId: alliedOutpostId } }),
    (error) => error.status === 409,
  );
});

test('a player trade settles both halves or neither', async () => {
  const exchange = await import('../src/game/exchange.js');
  const { addCargo } = await import('../src/game/characters.js');
  const { allGoods } = await import('@schiffi/shared/data/goods.js');

  const other = await secondCaptain('Gegenpart');
  // Side by side, at sea, so both are within hail.
  const me = instance.players.get(`p${characterId}`);
  const them = instance.players.get(`p${other.characterId}`);
  them.x = me.x + 10;
  them.y = me.y;
  await db.run('UPDATE characters SET docked = 0 WHERE id IN (?, ?)', [characterId, other.characterId]);

  const good = allGoods().find((entry) => entry.vol === 1 && !entry.perish);
  const myShip = await db.get('SELECT active_ship_id AS id FROM characters WHERE id = ?', [characterId]);
  await db.tx(async (tx) => { await addCargo(tx, myShip.id, good.id, 3, good.price, 0.6); });
  await db.run('UPDATE characters SET coins = 0 WHERE id = ?', [characterId]);
  await db.run('UPDATE characters SET coins = 900 WHERE id = ?', [other.characterId]);

  const offer = await exchange.propose({
    instance, characterId, userId, payload: { targetId: `p${other.characterId}` },
  });
  assert.ok(offer.id);

  // I put up three units; they put up 500 coins.
  await exchange.setOffer({
    instance, characterId, userId,
    payload: { offerId: offer.id, goods: [{ goodId: good.id, qty: 3 }], coins: 0 },
  });
  await exchange.setOffer({
    instance, characterId: other.characterId, userId: other.userId,
    payload: { offerId: offer.id, goods: [], coins: 500 },
  });

  // One confirmation alone settles nothing.
  const half = await exchange.confirm({
    instance, characterId, userId, payload: { offerId: offer.id },
  });
  assert.equal(half.settled, false);
  let myCoins = await db.get('SELECT coins FROM characters WHERE id = ?', [characterId]);
  assert.equal(Number(myCoins.coins), 0, 'coins moved on a single confirmation');

  const done = await exchange.confirm({
    instance, characterId: other.characterId, userId: other.userId, payload: { offerId: offer.id },
  });
  assert.equal(done.settled, true);

  myCoins = await db.get('SELECT coins FROM characters WHERE id = ?', [characterId]);
  const theirCoins = await db.get('SELECT coins FROM characters WHERE id = ?', [other.characterId]);
  assert.equal(Number(myCoins.coins), 500);
  assert.equal(Number(theirCoins.coins), 400);

  const mineLeft = await db.get('SELECT SUM(qty) AS n FROM cargo WHERE ship_id = ? AND good_id = ?',
    [myShip.id, good.id]);
  const theirs = await db.get('SELECT qty, freshness FROM cargo WHERE ship_id = ? AND good_id = ?',
    [other.shipId, good.id]);
  assert.equal(Number(mineLeft?.n ?? 0), 0, 'the goods did not leave my hold');
  assert.equal(Number(theirs.qty), 3, 'the goods did not arrive');
  // Worn goods stay worn: a trade must not launder spoilage away.
  assert.ok(Math.abs(Number(theirs.freshness) - 0.6) < 0.03,
    `freshness was reset to ${theirs.freshness}`);
});

test('an offer that cannot be paid for moves nothing at all', async () => {
  const exchange = await import('../src/game/exchange.js');
  const { addCargo } = await import('../src/game/characters.js');
  const { allGoods } = await import('@schiffi/shared/data/goods.js');

  const other = await secondCaptain('Klamm');
  const me = instance.players.get(`p${characterId}`);
  const them = instance.players.get(`p${other.characterId}`);
  them.x = me.x + 10;
  them.y = me.y;
  await db.run('UPDATE characters SET docked = 0 WHERE id IN (?, ?)', [characterId, other.characterId]);

  const good = allGoods().find((entry) => entry.vol === 1 && !entry.perish);
  const myShip = await db.get('SELECT active_ship_id AS id FROM characters WHERE id = ?', [characterId]);
  await db.tx(async (tx) => { await addCargo(tx, myShip.id, good.id, 2, good.price, 1); });
  await db.run('UPDATE characters SET coins = 100 WHERE id = ?', [other.characterId]);

  const offer = await exchange.propose({
    instance, characterId, userId, payload: { targetId: `p${other.characterId}` },
  });
  await exchange.setOffer({
    instance, characterId, userId,
    payload: { offerId: offer.id, goods: [{ goodId: good.id, qty: 2 }], coins: 0 },
  });
  await exchange.setOffer({
    instance, characterId: other.characterId, userId: other.userId,
    payload: { offerId: offer.id, goods: [], coins: 100 },
  });
  await exchange.confirm({ instance, characterId, userId, payload: { offerId: offer.id } });

  // Their purse empties between confirming and settling.
  await db.run('UPDATE characters SET coins = 0 WHERE id = ?', [other.characterId]);
  const before = await db.get('SELECT SUM(qty) AS n FROM cargo WHERE ship_id = ? AND good_id = ?',
    [myShip.id, good.id]);

  await assert.rejects(() => exchange.confirm({
    instance, characterId: other.characterId, userId: other.userId, payload: { offerId: offer.id },
  }), /notEnoughCoins/);

  const after = await db.get('SELECT SUM(qty) AS n FROM cargo WHERE ship_id = ? AND good_id = ?',
    [myShip.id, good.id]);
  const theirs = await db.get('SELECT SUM(qty) AS n FROM cargo WHERE ship_id = ? AND good_id = ?',
    [other.shipId, good.id]);
  assert.equal(Number(after?.n ?? 0), Number(before?.n ?? 0), 'goods left the hold anyway');
  assert.equal(Number(theirs?.n ?? 0), 0, 'goods arrived without being paid for');
});

test('a trade with somebody out of hail is refused', async () => {
  const exchange = await import('../src/game/exchange.js');
  const other = await secondCaptain('Weitweg');
  const me = instance.players.get(`p${characterId}`);
  instance.players.get(`p${other.characterId}`).x = me.x + 100_000;

  await assert.rejects(() => exchange.propose({
    instance, characterId, userId, payload: { targetId: `p${other.characterId}` },
  }), /tooFar/);
});

// --- warehouses, rumours, treasure, politics and seasons ---------------------

test('storage is rented, filled from the hold and emptied back into it', async () => {
  const world = await import('../src/game/world.js');
  const { addCargo } = await import('../src/game/characters.js');
  const { allGoods } = await import('@schiffi/shared/data/goods.js');

  // A port big enough to have a vault to let.
  const port = instance.world.ports.find((entry) => entry.size >= 2);
  assert.ok(port, 'this world has no port with a warehouse');
  await moveTo(port.x, port.y, { docked: true, portId: port.id });
  await grant(10_000);

  const rented = await world.rentWarehouse({ instance, characterId, userId, payload: { capacity: 100 } });
  assert.equal(rented.capacity, 100);
  assert.ok(rented.rentPerDay > 0, 'a lease with no rent is not a lease');

  const good = allGoods().find((entry) => entry.vol === 1 && !entry.perish);
  const ship = await db.get('SELECT active_ship_id AS id FROM characters WHERE id = ?', [characterId]);
  // Earlier tests left cargo aboard; this one is about what moves, not totals.
  await db.run('DELETE FROM cargo WHERE ship_id = ?', [ship.id]);
  await db.tx(async (tx) => { await addCargo(tx, ship.id, good.id, 4, good.price, 0.7); });

  await world.storeGoods({
    instance, characterId, userId, payload: { goodId: good.id, qty: 4, direction: 'store' },
  });
  let inHold = await db.get('SELECT SUM(qty) AS n FROM cargo WHERE ship_id = ? AND good_id = ?',
    [ship.id, good.id]);
  assert.equal(Number(inHold?.n ?? 0), 0, 'the goods never left the hold');

  const stores = await world.warehousesFor(characterId);
  const here = stores.find((store) => store.portId === port.id);
  assert.equal(here.used, 4);
  assert.ok(Math.abs(here.cargo[0].freshness - 0.7) < 0.03, 'freshness was not kept in store');

  await world.storeGoods({
    instance, characterId, userId, payload: { goodId: good.id, qty: 4, direction: 'load' },
  });
  inHold = await db.get('SELECT SUM(qty) AS n FROM cargo WHERE ship_id = ? AND good_id = ?',
    [ship.id, good.id]);
  assert.equal(Number(inHold?.n ?? 0), 4, 'the goods did not come back aboard');
});

test('unpaid warehouse rent is taken in goods, not forgiven', async () => {
  const world = await import('../src/game/world.js');
  const { addCargo } = await import('../src/game/characters.js');
  const { allGoods } = await import('@schiffi/shared/data/goods.js');

  const port = instance.world.ports.find((entry) => entry.size >= 2);
  await moveTo(port.x, port.y, { docked: true, portId: port.id });

  const good = allGoods().find((entry) => entry.vol === 1 && entry.price > 40 && !entry.perish);
  const ship = await db.get('SELECT active_ship_id AS id FROM characters WHERE id = ?', [characterId]);
  await db.tx(async (tx) => { await addCargo(tx, ship.id, good.id, 6, good.price, 1); });
  await world.storeGoods({
    instance, characterId, userId, payload: { goodId: good.id, qty: 6, direction: 'store' },
  });

  // An empty purse and rent falling due right now.
  await db.run('UPDATE characters SET coins = 0 WHERE id = ?', [characterId]);
  await db.run('UPDATE warehouses SET rent_due_at = ? WHERE character_id = ?',
    [instance.gameTimeMs, characterId]);

  const before = await db.get(
    'SELECT SUM(qty) AS n FROM warehouse_cargo w JOIN warehouses h ON h.id = w.warehouse_id ' +
    'WHERE h.character_id = ?', [characterId]);
  await world.collectRent(instance);
  const after = await db.get(
    'SELECT SUM(qty) AS n FROM warehouse_cargo w JOIN warehouses h ON h.id = w.warehouse_id ' +
    'WHERE h.character_id = ?', [characterId]);

  assert.ok(Number(after?.n ?? 0) < Number(before?.n ?? 0),
    'rent went unpaid and nothing was taken in its place');
});

test('a rumour costs coins and lands on the buyer\'s chart', async () => {
  const world = await import('../src/game/world.js');
  const port = instance.world.ports[0];
  await moveTo(port.x, port.y, { docked: true, portId: port.id });
  await grant(5000);

  const rumours = await world.rumoursFor(instance, port.id);
  assert.ok(rumours.length > 0, 'the tavern had nothing to say at all');
  assert.ok(['sure', 'likely', 'doubtful'].includes(rumours[0].confidence));
  // The buyer is told how sure the teller sounds, never the truth value.
  assert.equal(rumours[0].truth, undefined, 'the rumour gave its own reliability away');

  const before = await db.get('SELECT coins FROM characters WHERE id = ?', [characterId]);
  const bought = await world.buyRumour({
    instance, characterId, userId, payload: { rumourId: rumours[0].id },
  });
  const after = await db.get('SELECT coins FROM characters WHERE id = ?', [characterId]);
  assert.equal(Number(after.coins), Number(before.coins) - bought.paid);

  const charts = await world.chartsFor(characterId);
  assert.ok(charts.some((chart) => chart.source === 'rumour'), 'nothing reached the chart');
});

test('a buried hoard is dug up once and only where it lies', async () => {
  const world = await import('../src/game/world.js');
  const treasure = await db.get(
    'SELECT * FROM treasures WHERE world_id = ? AND found_at IS NULL LIMIT 1', [instance.id]);
  assert.ok(treasure, 'no treasure was buried in this world');

  // Nowhere near it.
  await moveTo(Number(treasure.x) + 50_000, Number(treasure.y));
  await assert.rejects(() => world.digTreasure({
    instance, characterId, userId, payload: { treasureId: treasure.id },
  }), /tooFar/);

  // Standing on it, with an empty hold to put it in.
  const ship = await db.get('SELECT active_ship_id AS id FROM characters WHERE id = ?', [characterId]);
  await db.run('DELETE FROM cargo WHERE ship_id = ?', [ship.id]);
  await moveTo(Number(treasure.x), Number(treasure.y));

  const dug = await world.digTreasure({
    instance, characterId, userId, payload: { treasureId: treasure.id },
  });
  assert.ok(dug.taken.length > 0, 'the hoard was empty');

  // A hoard is lifted once.
  await assert.rejects(() => world.digTreasure({
    instance, characterId, userId, payload: { treasureId: treasure.id },
  }), /notFound/);
});

test('factions drift, and a war is harder to end than to start', async () => {
  const world = await import('../src/game/world.js');
  const relations = await world.relationsFor(instance.id);
  assert.ok(relations.relations.length > 0, 'no faction relations were seeded');

  // Push one pair well past the declaration threshold and step politics.
  const pair = relations.relations[0];
  await db.run(
    'UPDATE faction_relations SET relation = -0.95, at_war = 0 WHERE world_id = ? ' +
    'AND faction_a = ? AND faction_b = ?', [instance.id, pair.a, pair.b]);
  await world.stepPolitics(instance);
  assert.equal(await world.atWar(instance.id, pair.a, pair.b), true, 'the war never started');

  // Just back over the declaration line is not yet peace.
  await db.run(
    'UPDATE faction_relations SET relation = -0.7 WHERE world_id = ? AND faction_a = ? AND faction_b = ?',
    [instance.id, pair.a, pair.b]);
  await world.stepPolitics(instance);
  assert.equal(await world.atWar(instance.id, pair.a, pair.b), true, 'the war ended too easily');
});

test('closing a season freezes the standings that were live', async () => {
  const world = await import('../src/game/world.js');
  const season = await world.currentSeason();
  assert.ok(season.number >= 1);

  const live = await world.rankFor(db, instance.id, 'wealth', 10);
  assert.ok(live.length > 0, 'nobody is on the wealth board');

  await world.closeSeason(season);
  const frozen = await world.seasonBoard(season.id, instance.id, 'wealth');
  assert.equal(frozen.length, live.length);
  assert.equal(frozen[0].name, live[0].name);
  assert.equal(frozen[0].score, Math.round(live[0].score));

  // Closing the old one opens the next.
  const next = await world.currentSeason();
  assert.equal(next.number, season.number + 1);

  // And the frozen board survives whatever happens to the live one.
  await db.run('UPDATE characters SET coins = 0, bank_balance = 0 WHERE world_id = ?', [instance.id]);
  const still = await world.seasonBoard(season.id, instance.id, 'wealth');
  assert.equal(still[0].score, frozen[0].score, 'the record moved with the live state');
});

test('an account may keep several save games in the same world, up to the configured limit', async () => {
  const { createCharacter } = await import('../src/game/characters.js');
  const config = (await import('../src/config.js')).default;

  // The account already has one character from the top-level fixture; fill
  // the rest of the limit with fresh ones in the very same world.
  const extra = config.game.maxCharactersPerWorld - 1;
  for (let i = 0; i < extra; i++) {
    await createCharacter({ userId, worldId: instance.id, name: `Zweitkapitän${i}`, mode: 'trader' }, instance);
  }

  await assert.rejects(
    createCharacter({ userId, worldId: instance.id, name: 'Einer zu viel', mode: 'trader' }, instance),
    (error) => error.code === 'error.characterLimit');
});
