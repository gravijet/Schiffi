/**
 * Weather: storms, hurricanes, ice fields and natural disasters.
 *
 * Storms are real moving entities with a position, radius and intensity, not a
 * screen effect: they damage hulls, spoil cargo, cut steering and are visible
 * to every player in range.  Where they form depends on the region's hazard
 * class and climate, so the storm belt is somewhere you can learn to avoid.
 */
import { Rng, hashCombine } from '@schiffi/shared/util/rng.js';
import { clamp, clamp01, dist, TAU } from '@schiffi/shared/util/math.js';
import { CELL_SIZE, CELLS_X, CELLS_Y } from '@schiffi/shared/world/constants.js';
import { HAZARD, regionAt } from '@schiffi/shared/world/regions.js';

export const STORM_KINDS = {
  SQUALL: 'squall',
  STORM: 'storm',
  HURRICANE: 'hurricane',
  ICE_FIELD: 'ice',
  FOG_BANK: 'fog',
};

const KIND_PROFILE = {
  squall: { radius: [600, 1400], intensity: [0.2, 0.45], speed: [30, 70], life: [3, 8] },
  storm: { radius: [1400, 3200], intensity: [0.45, 0.8], speed: [18, 45], life: [6, 16] },
  hurricane: { radius: [3000, 6500], intensity: [0.8, 1.0], speed: [12, 30], life: [10, 26] },
  ice: { radius: [900, 2600], intensity: [0.3, 0.7], speed: [2, 9], life: [20, 60] },
  fog: { radius: [1200, 3000], intensity: [0.15, 0.4], speed: [6, 18], life: [4, 12] },
};

let nextStormId = 1;

/**
 * Advance weather by `dt` seconds of real time.
 * Storms move, age and dissipate; new ones form according to region hazard.
 */
export function stepWeather(instance, sim, dt) {
  const rng = sim.rng;
  const gameHours = (dt * 60) / 3600; // GAME_TIME_SCALE = 60

  // Move and age existing storms.
  for (let i = instance.storms.length - 1; i >= 0; i--) {
    const storm = instance.storms[i];
    storm.x += Math.cos(storm.heading) * storm.speed * dt;
    storm.y += Math.sin(storm.heading) * storm.speed * dt;
    storm.heading += rng.range(-0.05, 0.05) * dt;
    storm.age += gameHours;

    // Fade in over the first hour and out over the last two.
    const remaining = storm.life - storm.age;
    storm.intensity = storm.peakIntensity
      * clamp01(storm.age / 1) * clamp01(remaining / 2);

    const outOfBounds = storm.x < -storm.radius || storm.y < -storm.radius
      || storm.x > CELLS_X * CELL_SIZE + storm.radius
      || storm.y > CELLS_Y * CELL_SIZE + storm.radius;

    if (storm.age >= storm.life || outOfBounds) {
      instance.storms.splice(i, 1);
    }
  }

  // Form new storms. The rate is per region per game hour.
  const capacity = Math.max(6, Math.round(instance.world.regions.length * 0.22));
  if (instance.storms.length < capacity) {
    for (const region of instance.world.regions) {
      const chance = region.stormChance * gameHours * 0.08;
      if (!rng.chance(chance)) continue;
      const storm = spawnStorm(instance, region, rng);
      if (storm) instance.storms.push(storm);
      if (instance.storms.length >= capacity) break;
    }
  }

  applyStormDamage(instance, dt);
}

function spawnStorm(instance, region, rng) {
  const kind = pickKind(region, rng);
  const profile = KIND_PROFILE[kind];
  if (!profile) return null;

  // Place it somewhere inside the region's cell, not exactly on the site.
  const spread = 1800;
  const x = clamp(region.x + rng.range(-spread, spread), 0, CELLS_X * CELL_SIZE);
  const y = clamp(region.y + rng.range(-spread, spread), 0, CELLS_Y * CELL_SIZE);

  const peakIntensity = rng.range(profile.intensity[0], profile.intensity[1]);
  return {
    id: nextStormId++,
    kind,
    x, y,
    radius: rng.range(profile.radius[0], profile.radius[1]),
    peakIntensity,
    intensity: 0,
    speed: rng.range(profile.speed[0], profile.speed[1]),
    heading: rng.range(0, TAU),
    age: 0,
    life: rng.range(profile.life[0], profile.life[1]),
    regionId: region.id,
  };
}

function pickKind(region, rng) {
  if (region.hazard === HAZARD.ICE) {
    return rng.chance(0.6) ? STORM_KINDS.ICE_FIELD : STORM_KINDS.STORM;
  }
  if (region.climateName === 'tropical') {
    // The hurricane belt: rare, but the most dangerous thing on the map.
    if (rng.chance(0.12)) return STORM_KINDS.HURRICANE;
    return rng.chance(0.5) ? STORM_KINDS.SQUALL : STORM_KINDS.STORM;
  }
  if (region.hazard === HAZARD.STORMY) {
    return rng.chance(0.65) ? STORM_KINDS.STORM : STORM_KINDS.SQUALL;
  }
  if (rng.chance(0.25)) return STORM_KINDS.FOG_BANK;
  return rng.chance(0.6) ? STORM_KINDS.SQUALL : STORM_KINDS.STORM;
}

/** Storms wear down hulls and sails of everything caught inside them. */
function applyStormDamage(instance, dt) {
  if (instance.storms.length === 0) return;

  for (const entity of [...instance.players.values(), ...instance.npcs.values()]) {
    if (entity.docked) continue;
    let worst = 0;
    let kind = null;
    for (const storm of instance.storms) {
      const d = dist(storm.x, storm.y, entity.x, entity.y);
      if (d > storm.radius) continue;
      // Damage peaks in the middle and tapers to nothing at the edge.
      const falloff = 1 - d / storm.radius;
      const severity = storm.intensity * falloff;
      if (severity > worst) { worst = severity; kind = storm.kind; }
    }

    entity.inStorm = worst > 0.05;
    entity.stormSeverity = worst;
    entity.stormKind = kind;
    if (worst <= 0.05) continue;

    const resist = clamp01(entity.stats?.stormResist ?? 0.2);
    const effective = worst * (1 - resist);

    // Ice grinds the hull; wind tears the sails.
    if (kind === STORM_KINDS.ICE_FIELD) {
      entity.hull = Math.max(0, entity.hull - effective * 5 * dt);
    } else if (kind !== STORM_KINDS.FOG_BANK) {
      entity.sail = Math.max(0, entity.sail - effective * 4 * dt);
      entity.hull = Math.max(0, entity.hull - effective * 2.2 * dt);
    }

    if (entity.hull <= 0 && entity.send) {
      entity.send({ t: 'event', kind: 'sinking' });
    }
  }
}

/** Weather description for a position, used by the HUD and by rumours. */
export function weatherAt(instance, sim, x, y) {
  let strongest = null;
  for (const storm of instance.storms) {
    const d = dist(storm.x, storm.y, x, y);
    if (d > storm.radius) continue;
    const severity = storm.intensity * (1 - d / storm.radius);
    if (!strongest || severity > strongest.severity) strongest = { storm, severity };
  }
  const wind = sim.windAt(x, y);
  return {
    kind: strongest ? strongest.storm.kind : (wind.strength > 22 ? 'clouds' : 'clear'),
    severity: strongest ? Math.round(strongest.severity * 100) / 100 : 0,
    wind: { angle: wind.angle, strength: Math.round(wind.strength) },
    daylight: Math.round(sim.daylight * 100) / 100,
    season: instance.season ?? 0,
  };
}

/**
 * Natural disasters are rarer, region-wide events triggered from the world
 * event system or by chance; they are storms with extreme parameters plus a
 * broadcast so players can react.
 */
export function triggerDisaster(instance, kind, regionId) {
  const region = instance.world.regions[regionId] ?? instance.world.regions[0];
  const rng = new Rng(hashCombine(instance.seed, Date.now() | 0));
  const storm = spawnStorm(instance, region, rng);
  if (!storm) return null;

  storm.kind = kind === 'tsunami' ? STORM_KINDS.HURRICANE : (STORM_KINDS[kind?.toUpperCase()] ?? STORM_KINDS.HURRICANE);
  storm.radius *= 1.8;
  storm.peakIntensity = 1;
  storm.life *= 1.5;
  storm.disaster = kind;
  instance.storms.push(storm);
  return storm;
}
