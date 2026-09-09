/**
 * Terrain field generation.
 *
 * Pure noise produces one dominant mega-continent surrounded by pixel speckle,
 * which is useless for a seafaring game.  Schiffi therefore *places* landmasses
 * explicitly - continents, large islands, archipelago chains and lone rocks -
 * and only uses noise to shape them:
 *
 *   1. Nuclei are scattered with a rejection sampler so they never overlap.
 *      That fixes the size distribution: a world always has a handful of
 *      continents plus a long tail of islands worth exploring.
 *   2. Each nucleus is rasterised as a radial falloff whose radius is bent by
 *      angular noise, which turns circles into lobed coastlines with capes,
 *      bays and peninsulas.
 *   3. A gentle global field adds depth variation to the open sea and lets
 *      shoals appear far from land.
 *   4. Sea level is calibrated per seed from a histogram, so every world hits
 *      the same land fraction regardless of how the noise fell.
 */
import { Noise2D } from '../util/noise.js';
import { Rng, hashCombine } from '../util/rng.js';
import { clamp01, smoothstep, lerp } from '../util/math.js';
import {
  CELLS_X, CELLS_Y, T, ELEV, TARGET_LAND_FRACTION, CLIMATE,
} from './constants.js';

/** Shape parameters. Part of the world contract - see WORLDGEN_VERSION. */
const SHAPE = {
  reach: 1.55,      // how far past its radius a nucleus can still raise land
  lobe: 2.4,        // angular frequency of the outline wobble
  wobAmp: 0.30,     // outline wobble strength (0 = perfect circle)
  detFreq: 0.02,    // per-cell surface detail frequency
  detAmp: 0.14,     // per-cell surface detail strength
  inner: 0.35,      // fraction of the radius that stays at full height
  pow: 0.85,        // falloff curve; < 1 gives broad plateaus
  wLand: 0.86,      // weight of the landmass field
  wGlobal: 0.14,    // weight of the global sea-floor field
};

/** How many nuclei of each class a world gets. */
const POPULATION = {
  continent: [4, 7], continentR: [62, 105],
  large: [18, 30], largeR: [18, 40],
  chains: [14, 22], chainLen: [4, 10], chainR: [5, 14], chainStep: [18, 34],
  small: [90, 150], smallR: [4, 13],
};

/**
 * Scatter landmass nuclei.  Rejection sampling with a separation rule keeps
 * islands apart; chains walk a jittered heading so archipelagos read as arcs.
 */
export function generateNuclei(seed) {
  const rng = new Rng(hashCombine(seed, 0x4e55));
  const out = [];
  const margin = 48;

  const fits = (x, y, r, slack) => {
    if (x < margin || y < margin || x > CELLS_X - margin || y > CELLS_Y - margin) return false;
    for (const n of out) {
      if (Math.hypot(n.x - x, n.y - y) < (n.r + r) * slack) return false;
    }
    return true;
  };
  const place = (r, kind, tries = 60) => {
    for (let t = 0; t < tries; t++) {
      const x = rng.range(margin, CELLS_X - margin);
      const y = rng.range(margin, CELLS_Y - margin);
      if (fits(x, y, r, 0.82)) { out.push({ x, y, r, kind }); return true; }
    }
    return false;
  };

  const n = (range) => rng.int(range[0], range[1] + 1);
  const r = (range) => rng.range(range[0], range[1]);

  for (let i = n(POPULATION.continent); i > 0; i--) place(r(POPULATION.continentR), 'continent');
  for (let i = n(POPULATION.large); i > 0; i--) place(r(POPULATION.largeR), 'large');

  for (let c = n(POPULATION.chains); c > 0; c--) {
    let x = rng.range(margin, CELLS_X - margin);
    let y = rng.range(margin, CELLS_Y - margin);
    let ang = rng.range(0, Math.PI * 2);
    for (let i = n(POPULATION.chainLen); i > 0; i--) {
      const rad = r(POPULATION.chainR);
      if (fits(x, y, rad, 0.85)) out.push({ x, y, r: rad, kind: 'chain' });
      ang += rng.range(-0.5, 0.5);
      const step = r(POPULATION.chainStep);
      x += Math.cos(ang) * step;
      y += Math.sin(ang) * step;
    }
  }

  for (let i = n(POPULATION.small); i > 0; i--) place(r(POPULATION.smallR), 'small', 25);
  return out;
}

/**
 * @param {number} seed
 * @returns {{height: Float32Array, terrain: Uint8Array, temperature: Uint8Array,
 *            moisture: Uint8Array, climate: Uint8Array, nuclei: Array}}
 */
export function generateTerrain(seed) {
  const nShape = new Noise2D(hashCombine(seed, 11));
  const nGlobal = new Noise2D(hashCombine(seed, 12));
  const nMoist = new Noise2D(hashCombine(seed, 4));
  const nTemp = new Noise2D(hashCombine(seed, 5));
  const nDetail = new Noise2D(hashCombine(seed, 2));

  const height = new Float32Array(CELLS_X * CELLS_Y);
  const nuclei = generateNuclei(seed);

  // --- 1. Rasterise landmasses --------------------------------------------
  for (const nuc of nuclei) {
    const reach = nuc.r * SHAPE.reach;
    const x0 = Math.max(0, Math.floor(nuc.x - reach));
    const x1 = Math.min(CELLS_X - 1, Math.ceil(nuc.x + reach));
    const y0 = Math.max(0, Math.floor(nuc.y - reach));
    const y1 = Math.min(CELLS_Y - 1, Math.ceil(nuc.y + reach));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - nuc.x;
        const dy = y - nuc.y;
        const ang = Math.atan2(dy, dx);
        // Sampling the wobble on a circle keeps it seamless at +/-PI.
        const wob = nShape.fbm(
          Math.cos(ang) * SHAPE.lobe + nuc.x * 0.017,
          Math.sin(ang) * SHAPE.lobe + nuc.y * 0.017, 4) * SHAPE.wobAmp;
        const local = nShape.fbm(x * SHAPE.detFreq, y * SHAPE.detFreq, 4) * SHAPE.detAmp;
        const d = Math.hypot(dx, dy) / (nuc.r * (1 + wob));
        let v = 1 - smoothstep(SHAPE.inner, 1.0, d);
        v = Math.pow(clamp01(v), SHAPE.pow) + local * clamp01(1.25 - d);
        const i = y * CELLS_X + x;
        if (v > height[i]) height[i] = v;
      }
    }
  }

  // --- 2. Global sea floor + edge falloff ---------------------------------
  let min = Infinity;
  let max = -Infinity;
  for (let y = 0; y < CELLS_Y; y++) {
    for (let x = 0; x < CELLS_X; x++) {
      const i = y * CELLS_X + x;
      const g = nGlobal.fbm(x * 0.006, y * 0.006, 4) * 0.5 + 0.5;
      let v = height[i] * SHAPE.wLand + g * SHAPE.wGlobal;
      v *= edgeFalloff(x / CELLS_X, y / CELLS_Y);
      height[i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  // --- 3. Sea level, hypsometry and shelves -------------------------------
  // Raising land with radial falloffs leaves the height distribution far too
  // top heavy (most of a nucleus sits on its plateau) and the open sea
  // completely flat.  Both are fixed by re-mapping *ranks* instead of values:
  // the shape of the coastline is kept, the distribution is replaced.
  const seaLevelRaw = percentileThreshold(height, min, max, 1 - TARGET_LAND_FRACTION);
  const land = new Uint8Array(CELLS_X * CELLS_Y);
  for (let i = 0; i < height.length; i++) land[i] = height[i] >= seaLevelRaw ? 1 : 0;

  const seaDistance = distanceToLand(land);
  remapLand(height, land, seaLevelRaw, max);
  remapWater(height, land, seaDistance);

  // --- 4. Climate ----------------------------------------------------------
  const temperature = new Uint8Array(CELLS_X * CELLS_Y);
  const moisture = new Uint8Array(CELLS_X * CELLS_Y);
  const climate = new Uint8Array(CELLS_X * CELLS_Y);
  for (let y = 0; y < CELLS_Y; y++) {
    const lat = Math.abs((y / (CELLS_Y - 1)) * 2 - 1); // 0 equator, 1 pole
    const band = climateBand(lat);
    for (let x = 0; x < CELLS_X; x++) {
      const i = y * CELLS_X + x;
      const nx = x / CELLS_X;
      const ny = y / CELLS_Y;
      const h = height[i];

      let t = 1 - lat;
      t += nTemp.fbm(nx * 6, ny * 4, 3) * 0.12;
      t -= Math.max(0, h - ELEV.COAST) * 0.52;  // altitude cools
      temperature[i] = Math.round(clamp01(t) * 255);

      let m = nMoist.fbm(nx * 9 + 31.7, ny * 6 + 12.3, 4) * 0.5 + 0.56;
      m += smoothstep(0.75, 1.0, 1 - lat) * 0.18;                        // wet tropics
      m -= smoothstep(0.0, 0.35, 1 - Math.abs(lat - 0.28) / 0.28) * 0.30; // dry horse latitudes
      moisture[i] = Math.round(clamp01(m) * 255);

      climate[i] = band;
    }
  }

  const terrain = classify(height, temperature, moisture, nDetail);
  return { height, terrain, temperature, moisture, climate, nuclei };
}

function climateBand(lat) {
  if (lat < 0.20) return CLIMATE.TROPICAL;
  if (lat < 0.38) return CLIMATE.SUBTROPICAL;
  if (lat < 0.66) return CLIMATE.TEMPERATE;
  if (lat < 0.88) return CLIMATE.BOREAL;
  return CLIMATE.POLAR;
}

function classify(height, temperature, moisture, nDetail) {
  const terrain = new Uint8Array(CELLS_X * CELLS_Y);
  for (let y = 0; y < CELLS_Y; y++) {
    for (let x = 0; x < CELLS_X; x++) {
      const i = y * CELLS_X + x;
      const h = height[i];
      const t = temperature[i] / 255;
      const m = moisture[i] / 255;

      if (h < ELEV.DEEP) { terrain[i] = T.DEEP_OCEAN; continue; }
      if (h < ELEV.OCEAN) { terrain[i] = T.OCEAN; continue; }
      if (h < ELEV.SHALLOW) {
        const reefish = t > 0.62 && nDetail.noise(x * 0.21, y * 0.21) > 0.34;
        terrain[i] = reefish ? T.REEF : T.SHALLOW;
        continue;
      }
      if (h < ELEV.COAST) { terrain[i] = t < 0.14 ? T.ICE : T.SHALLOW; continue; }
      if (h < ELEV.COAST + 0.022) { terrain[i] = t < 0.14 ? T.ICE : T.BEACH; continue; }
      if (h >= ELEV.PEAK) { terrain[i] = t < 0.34 ? T.SNOW : T.MOUNTAIN; continue; }
      if (h >= ELEV.MOUNTAIN) {
        if (t > 0.66 && m < 0.42 && nDetail.noise(x * 0.05 + 90, y * 0.05) > 0.42) {
          terrain[i] = T.VOLCANO;
        } else {
          terrain[i] = t < 0.20 ? T.SNOW : T.MOUNTAIN;
        }
        continue;
      }
      if (h >= ELEV.HILL) { terrain[i] = T.HILL; continue; }
      if (t < 0.18) { terrain[i] = T.SNOW; continue; }
      if (t > 0.55 && m < 0.30) { terrain[i] = T.DESERT; continue; }
      if (m > 0.74 && h < ELEV.PLAIN + 0.02) { terrain[i] = T.SWAMP; continue; }
      if (m > 0.46) { terrain[i] = T.FOREST; continue; }
      terrain[i] = T.PLAIN;
    }
  }
  return terrain;
}

/** Smooth falloff so the map is ringed by open ocean on all four sides. */
function edgeFalloff(nx, ny) {
  const d = Math.max(Math.abs(nx * 2 - 1), Math.abs(ny * 2 - 1));
  return 1 - smoothstep(0.80, 1.0, d);
}

/** Bilinear sample of a coarse grid at fractional coordinates. */
export function sampleBilinear(grid, w, h, fx, fy) {
  const x0 = Math.min(w - 1, Math.max(0, Math.floor(fx)));
  const y0 = Math.min(h - 1, Math.max(0, Math.floor(fy)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  return lerp(
    lerp(grid[y0 * w + x0], grid[y0 * w + x1], tx),
    lerp(grid[y1 * w + x0], grid[y1 * w + x1], tx),
    ty);
}

/** Land elevation bands as (cumulative share of land, elevation) pairs. */
const HYPSOMETRY = [
  [0.00, ELEV.COAST],
  [0.07, ELEV.COAST + 0.022], // beaches
  [0.55, ELEV.HILL],          // plains, forest, desert, swamp
  [0.81, ELEV.MOUNTAIN],      // hills
  [0.93, ELEV.PEAK],          // mountains
  [1.00, 1.0],                // peaks
];

/** Share of the whole map that should be shallow water and open ocean. */
const SHALLOW_SHARE = 0.085;
const OCEAN_SHARE = 0.26;

/**
 * Replace land heights by their rank within the land, mapped through
 * HYPSOMETRY.  A world therefore always has mostly lowland with a minority of
 * hills and a thin crown of peaks, whatever the noise did.
 */
function remapLand(height, land, seaLevelRaw, max) {
  const BUCKETS = 4096;
  const hist = new Uint32Array(BUCKETS);
  const scale = (BUCKETS - 1) / Math.max(1e-6, max - seaLevelRaw);
  let total = 0;
  for (let i = 0; i < height.length; i++) {
    if (!land[i]) continue;
    hist[Math.min(BUCKETS - 1, ((height[i] - seaLevelRaw) * scale) | 0)]++;
    total++;
  }
  if (total === 0) return;

  // Cumulative share -> target elevation, per bucket.
  const lut = new Float32Array(BUCKETS);
  let acc = 0;
  for (let b = 0; b < BUCKETS; b++) {
    const q = acc / total;
    lut[b] = mapThroughBands(q, HYPSOMETRY);
    acc += hist[b];
  }
  for (let i = 0; i < height.length; i++) {
    if (!land[i]) continue;
    height[i] = lut[Math.min(BUCKETS - 1, ((height[i] - seaLevelRaw) * scale) | 0)];
  }
}

/**
 * Give the sea a floor.  Depth follows distance from the nearest coast, so
 * every island gets a continental shelf and the deep basins sit where they
 * belong - in the middle of open water.  Thresholds are percentiles of the
 * distance field, so the shallow/ocean/deep split is stable across seeds.
 */
function remapWater(height, land, seaDistance) {
  let count = 0;
  for (let i = 0; i < land.length; i++) if (!land[i]) count++;
  if (count === 0) return;

  const maxD = 512;
  const hist = new Uint32Array(maxD + 1);
  for (let i = 0; i < land.length; i++) {
    if (land[i]) continue;
    hist[Math.min(maxD, seaDistance[i])]++;
  }
  const shallowCut = distancePercentile(hist, count, SHALLOW_SHARE / (count / land.length));
  const oceanCut = distancePercentile(hist, count, (SHALLOW_SHARE + OCEAN_SHARE) / (count / land.length));

  for (let i = 0; i < land.length; i++) {
    if (land[i]) continue;
    const d = seaDistance[i];
    // The three depth bands map exactly onto the three water classes, so the
    // shading gradient and the classification never disagree.
    let h;
    if (d <= shallowCut) {
      h = lerp(ELEV.COAST, ELEV.OCEAN, d / Math.max(1, shallowCut));
    } else if (d <= oceanCut) {
      const t = (d - shallowCut) / Math.max(1, oceanCut - shallowCut);
      h = lerp(ELEV.OCEAN, ELEV.DEEP, t);
    } else {
      const t = clamp01((d - oceanCut) / Math.max(1, oceanCut));
      h = lerp(ELEV.DEEP, 0.02, t);
    }
    height[i] = h;
  }
}

function distancePercentile(hist, total, fraction) {
  const target = total * Math.min(1, Math.max(0, fraction));
  let acc = 0;
  for (let d = 0; d < hist.length; d++) {
    acc += hist[d];
    if (acc >= target) return d;
  }
  return hist.length - 1;
}

/** Piecewise linear interpolation through (share, value) control points. */
function mapThroughBands(q, bands) {
  for (let i = 1; i < bands.length; i++) {
    if (q <= bands[i][0]) {
      const [q0, v0] = bands[i - 1];
      const [q1, v1] = bands[i];
      return lerp(v0, v1, (q - q0) / Math.max(1e-6, q1 - q0));
    }
  }
  return bands[bands.length - 1][1];
}

/**
 * Multi-source BFS giving every water cell its Chebyshev-ish distance to the
 * nearest land cell, in cells.  Land cells get 0.
 */
export function distanceToLand(land) {
  const dist = new Int32Array(land.length).fill(-1);
  const queue = new Int32Array(land.length);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < land.length; i++) {
    if (land[i]) { dist[i] = 0; queue[tail++] = i; }
  }
  while (head < tail) {
    const i = queue[head++];
    const d = dist[i] + 1;
    const x = i % CELLS_X;
    const y = (i / CELLS_X) | 0;
    if (x > 0 && dist[i - 1] < 0) { dist[i - 1] = d; queue[tail++] = i - 1; }
    if (x < CELLS_X - 1 && dist[i + 1] < 0) { dist[i + 1] = d; queue[tail++] = i + 1; }
    if (y > 0 && dist[i - CELLS_X] < 0) { dist[i - CELLS_X] = d; queue[tail++] = i - CELLS_X; }
    if (y < CELLS_Y - 1 && dist[i + CELLS_X] < 0) { dist[i + CELLS_X] = d; queue[tail++] = i + CELLS_X; }
  }
  for (let i = 0; i < dist.length; i++) if (dist[i] < 0) dist[i] = CELLS_X;
  return dist;
}

/**
 * Value below which `fraction` of the samples fall, via a 2048 bucket
 * histogram: O(n) and exact enough for a sea level.
 */
function percentileThreshold(data, min, max, fraction) {
  const BUCKETS = 8192;
  const hist = new Uint32Array(BUCKETS);
  const scale = (BUCKETS - 1) / Math.max(1e-6, max - min);
  for (let i = 0; i < data.length; i++) hist[((data[i] - min) * scale) | 0]++;
  const target = data.length * fraction;
  let acc = 0;
  for (let b = 0; b < BUCKETS; b++) {
    const next = acc + hist[b];
    if (next >= target) {
      // Interpolate inside the bucket, otherwise a spike (the flat open sea)
      // costs us up to a whole bucket of land fraction.
      const within = hist[b] === 0 ? 0 : (target - acc) / hist[b];
      return min + (b + within) / scale;
    }
    acc = next;
  }
  return max;
}
