/**
 * NPC shipping.
 *
 * The sea is not empty: merchants run between ports, fishermen work the
 * shallows, the navy patrols its faction's waters and pirates hunt in the
 * lawless ones.  NPCs are simulated server-side like players (same movement
 * integrator, same storms, same reefs) and are cheap: a small steering state
 * machine and a route, no pathfinder per frame.
 */
import { Rng, hashCombine } from '@schiffi/shared/util/rng.js';
import { clamp, clamp01, dist, dist2, normalize, angleDelta, TAU } from '@schiffi/shared/util/math.js';
import { CELL_SIZE, CELLS_X, CELLS_Y, NAVIGABLE } from '@schiffi/shared/world/constants.js';
import { HAZARD } from '@schiffi/shared/world/regions.js';
import { shipClass, effectiveStats } from '@schiffi/shared/data/ships.js';
import { generateShipName, generatePersonName } from '@schiffi/shared/world/names.js';

export const NPC_KINDS = ['merchant', 'fisher', 'navy', 'pirate', 'explorer', 'transport', 'passenger'];

const KIND_SHIP = {
  merchant: ['merchant_ship', 'heavy_merchant', 'armored_trader'],
  fisher: ['fishing_vessel', 'small_boat'],
  navy: ['armored_trader', 'fast_clipper'],
  pirate: ['fast_clipper', 'fast_courier', 'armored_trader'],
  explorer: ['explorer_ship', 'fast_courier'],
  transport: ['large_cargo', 'heavy_merchant'],
  passenger: ['luxury_passenger', 'merchant_ship'],
};

/** Target NPC count scales with world size and the density setting. */
export function targetNpcCount(instance) {
  const base = Math.round(instance.world.ports.length * 0.55);
  return clamp(base, 40, 600);
}

let nextNpcId = 1;

export function spawnNpcs(instance) {
  const rng = new Rng(hashCombine(instance.seed, 0x9c0f));
  const target = targetNpcCount(instance);
  while (instance.npcs.size < target) {
    const npc = createNpc(instance, rng);
    if (npc) instance.npcs.set(npc.netId, npc);
    else break;
  }
  console.log(`[npc] world ${instance.id}: ${instance.npcs.size} ships at sea`);
}

function createNpc(instance, rng) {
  const world = instance.world;
  if (world.ports.length < 2) return null;

  const home = rng.pick(world.ports);
  const region = world.regions[home.regionId];

  // What sails here depends on the water: pirates in lawless regions, navy in
  // policed ones, fishermen everywhere near the coast.
  const weights = {
    merchant: 5,
    fisher: 3,
    navy: region.hazard === HAZARD.CALM || region.hazard === HAZARD.NORMAL ? 3 : 1,
    pirate: region.hazard === HAZARD.PIRATE ? 5 : region.hazard === HAZARD.DEEP_RISK ? 4 : 0.4,
    explorer: 1,
    transport: 2,
    passenger: 1.5,
  };
  const kind = rng.pickWeighted(Object.keys(weights), Object.values(weights));
  const classKey = rng.pick(KIND_SHIP[kind]);
  const stats = effectiveStats(classKey);

  const spawn = findWater(instance, home.x, home.y, rng);
  if (!spawn) return null;

  const npc = {
    netId: `n${nextNpcId++}`,
    kind: kindCode(kind),
    npcKind: kind,
    classKey,
    stats,
    displayName: kind === 'pirate' ? generateShipName(nextNpcId * 31) : generateShipName(nextNpcId * 17),
    captain: generatePersonName(nextNpcId * 7),
    faction: kind === 'pirate' ? 'schwarzflagge' : home.factionKey,
    x: spawn.x, y: spawn.y,
    vx: 0, vy: 0, heading: rng.range(0, TAU), speed: 0,
    hull: stats.hull, maxHull: stats.hull,
    sail: stats.sail,
    homePortId: home.id,
    targetPortId: null,
    state: 'idle',
    stateTimer: 0,
    aggression: kind === 'pirate' ? rng.range(0.5, 1) : kind === 'navy' ? rng.range(0.3, 0.8) : 0,
    input: { x: 0, y: 0 },
    docked: false,
    cargoWeight: 0,
    crewFactor: 1,
  };
  pickDestination(instance, npc, rng);
  return npc;
}

function kindCode(kind) {
  // Matches ENTITY in the shared protocol: NPC ships are one entity type with
  // a sub-kind the client uses to choose an icon.
  return { merchant: 2, fisher: 2, navy: 2, pirate: 2, explorer: 2, transport: 2, passenger: 2 }[kind] ?? 2;
}

function findWater(instance, x, y, rng, tries = 30) {
  const terrain = instance.world.terrain;
  for (let i = 0; i < tries; i++) {
    const angle = rng.range(0, TAU);
    const radius = rng.range(CELL_SIZE * 2, CELL_SIZE * 30);
    const px = clamp(x + Math.cos(angle) * radius, CELL_SIZE, CELLS_X * CELL_SIZE - CELL_SIZE);
    const py = clamp(y + Math.sin(angle) * radius, CELL_SIZE, CELLS_Y * CELL_SIZE - CELL_SIZE);
    const cx = Math.floor(px / CELL_SIZE);
    const cy = Math.floor(py / CELL_SIZE);
    const idx = cy * CELLS_X + cx;
    if (NAVIGABLE[terrain[idx]] && instance.world.ocean[idx]) return { x: px, y: py };
  }
  return null;
}

function pickDestination(instance, npc, rng) {
  const world = instance.world;
  const home = instance.portsById.get(npc.homePortId);

  if (npc.npcKind === 'fisher') {
    // Fishermen stay near home and wander the shallows.
    const spot = findWater(instance, home.x, home.y, rng);
    npc.target = spot ?? { x: home.x, y: home.y };
    npc.state = 'wander';
    npc.stateTimer = rng.range(40, 120);
    return;
  }

  if (npc.npcKind === 'navy') {
    // Patrol between ports of the same faction.
    const friendly = world.ports.filter((p) => p.factionKey === npc.faction);
    const target = friendly.length > 1 ? rng.pick(friendly) : rng.pick(world.ports);
    npc.target = { x: target.x, y: target.y };
    npc.targetPortId = target.id;
    npc.state = 'patrol';
    return;
  }

  if (npc.npcKind === 'pirate') {
    // Prowl within dangerous regions rather than making port.
    const lawless = world.regions.filter((r) => r.hazard === HAZARD.PIRATE || r.hazard === HAZARD.DEEP_RISK);
    const region = lawless.length ? rng.pick(lawless) : rng.pick(world.regions);
    npc.target = { x: region.x + rng.range(-2500, 2500), y: region.y + rng.range(-2500, 2500) };
    npc.state = 'prowl';
    return;
  }

  // Traders and transports run between ports, preferring bigger ones.
  const candidates = world.ports.filter((p) => p.id !== npc.targetPortId);
  const target = rng.pickWeighted(candidates, candidates.map((p) => 1 + p.size * 1.5));
  npc.target = { x: target.x, y: target.y };
  npc.targetPortId = target.id;
  npc.state = 'travel';
}

/**
 * Steering.
 *
 * NPCs do not path-find around continents; they steer towards their target and
 * slide along obstacles, and if they stay stuck they pick a new destination.
 * That is cheap and, at sea, usually indistinguishable from navigation.
 */
export function stepNpcs(instance, dt, sim) {
  const rng = sim.rng;
  for (const npc of instance.npcs.values()) {
    npc.stateTimer -= dt;

    if (npc.npcKind === 'pirate' || npc.npcKind === 'navy') {
      updateHunter(instance, npc, dt, sim);
    }

    if (!npc.target || npc.stateTimer <= 0) {
      pickDestination(instance, npc, rng);
      npc.stateTimer = rng.range(90, 300);
    }

    const dx = npc.target.x - npc.x;
    const dy = npc.target.y - npc.y;
    const distance = Math.hypot(dx, dy);

    if (distance < CELL_SIZE * 3) {
      pickDestination(instance, npc, rng);
      npc.stateTimer = rng.range(90, 300);
      continue;
    }

    const [ix, iy] = normalize(dx, dy);
    // Obstacle avoidance: probe ahead, and if it is land, steer around it.
    const probe = CELL_SIZE * 6;
    if (!sim.isWater(npc.x + ix * probe, npc.y + iy * probe)) {
      const turn = npc.avoidDirection ?? (npc.avoidDirection = rng.chance(0.5) ? 1 : -1);
      const angle = Math.atan2(iy, ix) + turn * 0.9;
      npc.input.x = Math.cos(angle);
      npc.input.y = Math.sin(angle);
      npc.stuckFor = (npc.stuckFor ?? 0) + dt;
      if (npc.stuckFor > 12) {
        pickDestination(instance, npc, rng);
        npc.stuckFor = 0;
        npc.avoidDirection = null;
      }
    } else {
      npc.input.x = ix;
      npc.input.y = iy;
      npc.stuckFor = 0;
      npc.avoidDirection = null;
    }

    // Cruise speed: NPCs do not run flat out unless hunting or fleeing.
    const throttle = npc.state === 'chase' || npc.state === 'flee' ? 1 : 0.7;
    npc.input.x *= throttle;
    npc.input.y *= throttle;

    sim.moveShip(npc, dt);
  }
}

/** Pirates chase, the navy chases pirates, and both give up eventually. */
function updateHunter(instance, npc, dt, sim) {
  const huntRange = npc.npcKind === 'pirate' ? 2600 : 3400;
  const giveUpRange = huntRange * 1.8;

  if (npc.chaseTarget) {
    const prey = resolveTarget(instance, npc.chaseTarget);
    const stillValid = prey && dist(prey.x, prey.y, npc.x, npc.y) < giveUpRange;
    if (!stillValid) {
      npc.chaseTarget = null;
      npc.state = npc.npcKind === 'pirate' ? 'prowl' : 'patrol';
    } else {
      npc.target = { x: prey.x, y: prey.y };
      npc.state = 'chase';
      npc.stateTimer = 30;
      return;
    }
  }

  // Look for prey occasionally rather than every tick.
  npc.scanTimer = (npc.scanTimer ?? 0) - dt;
  if (npc.scanTimer > 0) return;
  npc.scanTimer = 1.5;

  const candidates = npc.npcKind === 'pirate'
    ? [...instance.players.values()].filter((p) => !p.docked && !p.protected)
    : [...instance.npcs.values()].filter((n) => n.npcKind === 'pirate');

  let best = null;
  let bestDist = huntRange * huntRange;
  for (const candidate of candidates) {
    const d2 = dist2(candidate.x, candidate.y, npc.x, npc.y);
    if (d2 < bestDist) { bestDist = d2; best = candidate; }
  }
  if (best && Math.random() < npc.aggression) {
    npc.chaseTarget = best.netId ?? `p${best.characterId}`;
    npc.state = 'chase';
    if (best.send) {
      best.send({ t: 'event', kind: 'hunted', by: npc.displayName, npcKind: npc.npcKind });
    }
  }
}

function resolveTarget(instance, netId) {
  if (instance.npcs.has(netId)) return instance.npcs.get(netId);
  for (const player of instance.players.values()) {
    if ((player.netId ?? `p${player.characterId}`) === netId) return player;
  }
  return null;
}

/** Remove sunk NPCs and top the population back up. */
export function reapNpcs(instance) {
  for (const [id, npc] of instance.npcs) {
    if (npc.hull <= 0) instance.npcs.delete(id);
  }
  const rng = new Rng(hashCombine(instance.seed, instance.tick | 0));
  while (instance.npcs.size < targetNpcCount(instance)) {
    const npc = createNpc(instance, rng);
    if (!npc) break;
    instance.npcs.set(npc.netId, npc);
  }
}
