/**
 * Landmass detection, ocean connectivity, port and anchorage placement.
 *
 * Everything here runs on the terrain byte grid and is pure: same seed and
 * same terrain in, same islands and ports out, on both server and client.
 */
import { Rng, hashCombine } from '../util/rng.js';
import {
  CELLS_X, CELLS_Y, CELL_SIZE, T, IS_LAND, NAVIGABLE,
  UNDISCOVERED_ISLAND_PROBABILITY, UNDISCOVERED_CLUSTER_FREQ, UNDISCOVERED_CLUSTER_BIAS,
} from './constants.js';
import { Noise2D } from '../util/noise.js';
import { generateIslandName, generatePlaceName, CULTURES } from './names.js';

const NO_LABEL = 0xffff;

/**
 * Label connected land components with a 4-neighbour flood fill.
 * @returns {{labels: Uint16Array, islands: Array}}
 */
export function findLandmasses(terrain) {
  const labels = new Uint16Array(CELLS_X * CELLS_Y).fill(NO_LABEL);
  const islands = [];
  const stack = new Int32Array(CELLS_X * CELLS_Y);

  for (let start = 0; start < terrain.length; start++) {
    if (!IS_LAND[terrain[start]] || labels[start] !== NO_LABEL) continue;
    if (islands.length >= NO_LABEL) break; // 65534 islands is far beyond any real map

    const id = islands.length;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;

    let area = 0;
    let sumX = 0, sumY = 0;
    let minX = CELLS_X, minY = CELLS_Y, maxX = -1, maxY = -1;
    let peak = 0;

    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % CELLS_X;
      const y = (idx / CELLS_X) | 0;
      area++;
      sumX += x; sumY += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      const t = terrain[idx];
      if (t > peak) peak = t;

      if (x > 0) push(idx - 1);
      if (x < CELLS_X - 1) push(idx + 1);
      if (y > 0) push(idx - CELLS_X);
      if (y < CELLS_Y - 1) push(idx + CELLS_X);
    }

    function push(n) {
      if (labels[n] === NO_LABEL && IS_LAND[terrain[n]]) {
        labels[n] = id;
        stack[sp++] = n;
      }
    }

    islands.push({
      id,
      area,
      cx: sumX / area,
      cy: sumY / area,
      minX, minY, maxX, maxY,
      peakTerrain: peak,
    });
  }

  return { labels, islands };
}

/**
 * Flood fill the water starting from the map border.  Cells reachable from the
 * open sea form the navigable ocean; enclosed lakes are excluded so we never
 * place a port a ship cannot reach.
 */
export function findOpenOcean(terrain) {
  const ocean = new Uint8Array(CELLS_X * CELLS_Y);
  const stack = new Int32Array(CELLS_X * CELLS_Y);
  let sp = 0;

  const seed = (idx) => {
    if (!ocean[idx] && NAVIGABLE[terrain[idx]]) { ocean[idx] = 1; stack[sp++] = idx; }
  };
  for (let x = 0; x < CELLS_X; x++) { seed(x); seed((CELLS_Y - 1) * CELLS_X + x); }
  for (let y = 0; y < CELLS_Y; y++) { seed(y * CELLS_X); seed(y * CELLS_X + CELLS_X - 1); }

  while (sp > 0) {
    const idx = stack[--sp];
    const x = idx % CELLS_X;
    const y = (idx / CELLS_X) | 0;
    if (x > 0) seed(idx - 1);
    if (x < CELLS_X - 1) seed(idx + 1);
    if (y > 0) seed(idx - CELLS_X);
    if (y < CELLS_Y - 1) seed(idx + CELLS_X);
  }
  return ocean;
}

/** True when a land cell touches open ocean (4-neighbourhood). */
function isCoastal(terrain, ocean, x, y) {
  const idx = y * CELLS_X + x;
  if (!IS_LAND[terrain[idx]]) return false;
  if (x > 0 && ocean[idx - 1]) return true;
  if (x < CELLS_X - 1 && ocean[idx + 1]) return true;
  if (y > 0 && ocean[idx - CELLS_X]) return true;
  if (y < CELLS_Y - 1 && ocean[idx + CELLS_X]) return true;
  return false;
}

/**
 * Score how good a coastal cell is as a harbour: sheltered spots (land on
 * several sides, water access on one) beat exposed straight coastline.
 */
function harbourScore(terrain, ocean, x, y) {
  let land = 0;
  let water = 0;
  let shallow = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= CELLS_X || ny >= CELLS_Y) continue;
      const t = terrain[ny * CELLS_X + nx];
      if (IS_LAND[t]) land++;
      else {
        water++;
        if (t === T.SHALLOW) shallow++;
      }
    }
  }
  if (water < 4) return -1;                   // landlocked pocket
  const shelter = 1 - Math.abs(land / 25 - 0.5) * 2; // best around half and half
  return shelter * 0.7 + (shallow / Math.max(1, water)) * 0.3;
}

/**
 * Decide which landmasses stay uncharted.  Clusters come from a low frequency
 * noise field: where the field is high, the effective probability is boosted,
 * so uncharted islands bunch together in remote archipelagos instead of being
 * sprinkled uniformly.
 */
export function markUndiscovered(seed, islands) {
  const cluster = new Noise2D(hashCombine(seed, 0xc105));
  const rng = new Rng(hashCombine(seed, 0xd15c));
  let count = 0;
  for (const isl of islands) {
    // Big landmasses are the charted, settled world.
    if (isl.area > 900) { isl.undiscovered = false; continue; }
    const nx = isl.cx / CELLS_X;
    const ny = isl.cy / CELLS_Y;
    const field = cluster.fbm(nx * UNDISCOVERED_CLUSTER_FREQ, ny * UNDISCOVERED_CLUSTER_FREQ, 3) * 0.5 + 0.5;
    // Cluster weight has mean ~1, so the global rate stays at the target.
    const weight = Math.exp((field - 0.5) * UNDISCOVERED_CLUSTER_BIAS) / clusterNormaliser();
    const p = Math.min(1, UNDISCOVERED_ISLAND_PROBABILITY * weight);
    isl.undiscovered = rng.chance(p);
    if (isl.undiscovered) count++;
  }
  return count;
}

/**
 * E[exp((field-0.5)*bias)] for our field distribution, precomputed so the
 * cluster boost does not change the global undiscovered rate.
 */
let _norm = 0;
function clusterNormaliser() {
  if (_norm) return _norm;
  // fbm is approximately normal with sigma ~0.16 after the 0.5 offset.
  const sigma = 0.16;
  _norm = Math.exp((UNDISCOVERED_CLUSTER_BIAS ** 2 * sigma ** 2) / 2);
  return _norm;
}

/**
 * Place ports on charted landmasses and anchorages on uncharted ones.
 * Port count scales with the square root of the island area, so a continent
 * gets many ports without the map turning into a wall of icons.
 */
export function placePorts(seed, terrain, ocean, labels, islands) {
  const rng = new Rng(hashCombine(seed, 0x9081));
  const ports = [];
  const anchorages = [];

  for (const isl of islands) {
    if (isl.area < 6) continue; // rocks, not islands

    // Gather candidate coastal cells for this island.
    const candidates = [];
    for (let y = isl.minY; y <= isl.maxY; y++) {
      for (let x = isl.minX; x <= isl.maxX; x++) {
        const idx = y * CELLS_X + x;
        if (labels[idx] !== isl.id) continue;
        if (!isCoastal(terrain, ocean, x, y)) continue;
        const score = harbourScore(terrain, ocean, x, y);
        if (score > 0) candidates.push({ x, y, score });
      }
    }
    if (candidates.length === 0) continue;

    isl.coastCells = candidates.length;
    const culture = CULTURES[Math.abs(hashCombine(seed, isl.id)) % CULTURES.length];
    isl.culture = culture;
    isl.name = isl.undiscovered ? null : generateIslandName(hashCombine(seed, isl.id, 3), culture);

    if (isl.undiscovered) {
      // One or two landing beaches; no harbour infrastructure.
      const n = isl.area > 200 ? 2 : 1;
      for (const c of pickSpread(candidates, n, 6, rng)) {
        anchorages.push({
          islandId: isl.id,
          x: (c.x + 0.5) * CELL_SIZE,
          y: (c.y + 0.5) * CELL_SIZE,
          cellX: c.x, cellY: c.y,
        });
      }
      continue;
    }

    const portCount = Math.max(1, Math.min(14, Math.round(Math.sqrt(isl.area) / 7)));
    const minSpacing = Math.max(8, Math.sqrt(isl.area) / 2.2);
    const chosen = pickSpread(candidates, portCount, minSpacing, rng);
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i];
      ports.push({
        id: `p${ports.length}`,
        islandId: isl.id,
        name: generatePlaceName(hashCombine(seed, isl.id, i * 31 + 5), culture, 'port'),
        culture,
        x: (c.x + 0.5) * CELL_SIZE,
        y: (c.y + 0.5) * CELL_SIZE,
        cellX: c.x,
        cellY: c.y,
        // Size drives market depth, shipyard tier and mission volume.
        size: sizeFor(isl.area, i, rng),
      });
    }
  }

  return { ports, anchorages };
}

function sizeFor(islandArea, index, rng) {
  // The first port on a big island is its capital.
  if (index === 0 && islandArea > 4000) return 4;
  if (index === 0 && islandArea > 1200) return 3;
  if (islandArea > 4000) return rng.pickWeighted([1, 2, 3], [0.3, 0.45, 0.25]);
  if (islandArea > 400) return rng.pickWeighted([1, 2, 3], [0.45, 0.4, 0.15]);
  return rng.pickWeighted([0, 1, 2], [0.35, 0.45, 0.2]);
}

/**
 * Greedy farthest-point selection: take the best scoring candidate, then keep
 * taking the best candidate that is at least `minDist` cells away.
 */
function pickSpread(candidates, count, minDist, rng) {
  const pool = candidates.slice().sort((a, b) => b.score - a.score);
  // Break ties randomly so ports do not all hug the same coast orientation.
  rng.shuffle(pool.slice(0, Math.min(8, pool.length)));
  const chosen = [];
  const minD2 = minDist * minDist;
  for (const c of pool) {
    if (chosen.length >= count) break;
    let ok = true;
    for (const p of chosen) {
      const dx = p.x - c.x, dy = p.y - c.y;
      if (dx * dx + dy * dy < minD2) { ok = false; break; }
    }
    if (ok) chosen.push(c);
  }
  return chosen;
}
