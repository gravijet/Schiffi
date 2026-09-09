/**
 * World assembly: terrain -> islands -> ports -> regions -> start area.
 *
 * `buildWorld(seed)` is the single entry point and is deterministic: the same
 * seed always yields the same world on server and client.  Mutable state
 * (who owns what, who discovered what, current prices) lives in the database
 * and is layered on top of this immutable base.
 */
import { generateTerrain } from './terrain.js';
import { findLandmasses, findOpenOcean, markUndiscovered, placePorts } from './islands.js';
import { buildRegions, HAZARD } from './regions.js';
import { CELLS_X, CELLS_Y, CELL_SIZE, WORLDGEN_VERSION, NAVIGABLE, T } from './constants.js';
import { Rng, hashCombine } from '../util/rng.js';

export function buildWorld(seed) {
  const t0 = Date.now();
  const terrainData = generateTerrain(seed);
  const { labels, islands } = findLandmasses(terrainData.terrain);
  const ocean = findOpenOcean(terrainData.terrain);
  const undiscoveredCount = markUndiscovered(seed, islands);
  const { ports, anchorages } = placePorts(seed, terrainData.terrain, ocean, labels, islands);
  const regions = buildRegions(seed, terrainData.terrain, ports, terrainData.climate);

  // Ports inherit hazard/faction context from their region.
  for (const port of ports) {
    const region = regions[port.regionId];
    port.climate = region.climateName;
    port.hazard = region.hazardName;
  }

  const start = chooseStartArea(seed, ports, regions, terrainData.terrain, ocean);

  return {
    seed,
    version: WORLDGEN_VERSION,
    width: CELLS_X,
    height: CELLS_Y,
    cellSize: CELL_SIZE,
    terrain: terrainData.terrain,
    heightField: terrainData.height,
    climate: terrainData.climate,
    temperature: terrainData.temperature,
    moisture: terrainData.moisture,
    ocean,
    labels,
    islands,
    ports,
    anchorages,
    regions,
    start,
    stats: {
      undiscoveredCount,
      islandCount: islands.length,
      portCount: ports.length,
      buildMs: Date.now() - t0,
    },
  };
}

/**
 * Pick the starting harbour.  A new captain must be able to reach several
 * ports without crossing dangerous water, so we score candidate ports by how
 * many other ports sit within a short sail through calm or normal seas.
 */
function chooseStartArea(seed, ports, regions, terrain, ocean) {
  const rng = new Rng(hashCombine(seed, 0x57a2));
  const NEAR = 90 * CELL_SIZE; // "a short sail"
  let best = null;
  let bestScore = -Infinity;

  // A beginner harbour must be in policed water: never pirate, storm, deep
  // risk or ice.  If a seed produces no such port we relax the rule below.
  const SAFE = [HAZARD.CALM, HAZARD.NORMAL];
  for (const port of ports) {
    const region = regions[port.regionId];
    if (!SAFE.includes(region.hazard)) continue;
    if (port.size < 2) continue; // needs a shipyard and a real market

    let neighbours = 0;
    for (const other of ports) {
      if (other === port) continue;
      if (Math.hypot(other.x - port.x, other.y - port.y) <= NEAR) neighbours++;
    }
    if (neighbours < 3) continue;

    const calm = region.hazard === HAZARD.CALM ? 2.5 : region.hazard === HAZARD.NORMAL ? 1.0 : -1.0;
    const score = neighbours * 1.0 + calm + port.size * 0.8 + rng.float() * 0.5;
    if (score > bestScore) { bestScore = score; best = port; }
  }

  // Fall back to the largest port if the scoring found nothing (tiny worlds).
  if (!best) {
    best = ports.slice().sort((a, b) => b.size - a.size)[0];
  }
  if (!best) throw new Error('world has no ports - seed is unusable');

  const spawn = findSpawnWater(terrain, ocean, best);
  return {
    portId: best.id,
    portName: best.name,
    regionId: best.regionId,
    x: spawn.x,
    y: spawn.y,
  };
}

/** Nearest navigable cell to a port, where new ships materialise. */
function findSpawnWater(terrain, ocean, port) {
  for (let r = 1; r < 40; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = port.cellX + dx;
        const y = port.cellY + dy;
        if (x < 0 || y < 0 || x >= CELLS_X || y >= CELLS_Y) continue;
        const idx = y * CELLS_X + x;
        if (ocean[idx] && NAVIGABLE[terrain[idx]] && terrain[idx] !== T.REEF) {
          return { x: (x + 0.5) * CELL_SIZE, y: (y + 0.5) * CELL_SIZE };
        }
      }
    }
  }
  return { x: port.x, y: port.y };
}

/** Terrain lookup helpers shared by simulation and renderer. */
export function terrainAt(world, worldX, worldY) {
  const cx = Math.floor(worldX / CELL_SIZE);
  const cy = Math.floor(worldY / CELL_SIZE);
  if (cx < 0 || cy < 0 || cx >= CELLS_X || cy >= CELLS_Y) return T.DEEP_OCEAN;
  return world.terrain[cy * CELLS_X + cx];
}

export function isNavigable(world, worldX, worldY) {
  return NAVIGABLE[terrainAt(world, worldX, worldY)] === 1;
}

export * from './constants.js';
export { HAZARD, HAZARD_NAMES, regionAt } from './regions.js';
