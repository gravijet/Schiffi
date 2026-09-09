/**
 * Sea regions and hazard zones.
 *
 * Regions are the coarse political / economic subdivision of the ocean: they
 * own a name, a climate, a controlling faction and a set of ports, and the
 * economy uses them to make prices regional rather than per-port random.
 * Hazard zones sit on top and drive storms, piracy and PvP rules.
 */
import { Rng, hashCombine } from '../util/rng.js';
import { Noise2D } from '../util/noise.js';
import { CELLS_X, CELLS_Y, CELL_SIZE, CLIMATE, CLIMATE_NAMES } from './constants.js';
import { generateRegionName } from './names.js';

export const HAZARD = {
  CALM: 0,        // safe waters: no PvP, mild weather
  NORMAL: 1,
  STORMY: 2,      // frequent storms
  PIRATE: 3,      // pirate infested, PvP allowed
  DEEP_RISK: 4,   // high risk / high reward, full PvP
  ICE: 5,         // ice fields, hull damage
};

export const HAZARD_NAMES = ['calm', 'normal', 'stormy', 'pirate', 'deepRisk', 'ice'];

/** Regions are a Voronoi partition over seeded sites, one per ~55x55 cells. */
export function buildRegions(seed, terrain, ports, climate) {
  const rng = new Rng(hashCombine(seed, 0x5e91));
  const sitesX = 12;
  const sitesY = 8;
  const sites = [];
  for (let gy = 0; gy < sitesY; gy++) {
    for (let gx = 0; gx < sitesX; gx++) {
      // Jittered grid: Voronoi cells stay roughly equal sized but irregular.
      const x = (gx + rng.range(0.15, 0.85)) * (CELLS_X / sitesX);
      const y = (gy + rng.range(0.15, 0.85)) * (CELLS_Y / sitesY);
      const idx = Math.min(terrain.length - 1, (Math.floor(y) * CELLS_X + Math.floor(x)));
      sites.push({
        id: sites.length,
        cx: x,
        cy: y,
        x: x * CELL_SIZE,
        y: y * CELL_SIZE,
        climate: climate[idx],
        portIds: [],
      });
    }
  }

  // Ports are assigned first: hazard selection needs to know how settled a
  // region is, and port -> region is a pure nearest-site lookup.
  for (const port of ports) {
    let best = 0;
    let bestD = Infinity;
    for (const s of sites) {
      const d = (s.cx - port.cellX) ** 2 + (s.cy - port.cellY) ** 2;
      if (d < bestD) { bestD = d; best = s.id; }
    }
    port.regionId = best;
    sites[best].portIds.push(port.id);
  }
  const maxPorts = Math.max(1, ...sites.map((s) => s.portIds.length));

  const hazardNoise = new Noise2D(hashCombine(seed, 0x4a20));
  for (const site of sites) {
    const nx = site.cx / CELLS_X;
    const ny = site.cy / CELLS_Y;
    site.name = generateRegionName(hashCombine(seed, site.id * 7717));
    site.climateName = CLIMATE_NAMES[site.climate];
    site.hazard = pickHazard(site, hazardNoise, nx, ny, rng, site.portIds.length / maxPorts);
    site.hazardName = HAZARD_NAMES[site.hazard];
    // Storm and piracy intensity are continuous, the class is just a label.
    site.stormChance = clamp(0.02 + (hazardNoise.fbm(nx * 5 + 11, ny * 5 + 3, 3) * 0.5 + 0.5) * 0.28
      + (site.hazard === HAZARD.STORMY ? 0.25 : 0), 0, 0.75);
    site.pirateDensity = clamp((hazardNoise.fbm(nx * 4 + 51, ny * 4 + 17, 3) * 0.5 + 0.5) * 0.6
      + (site.hazard === HAZARD.PIRATE ? 0.35 : 0) + (site.hazard === HAZARD.DEEP_RISK ? 0.2 : 0), 0, 1);
    site.pvp = site.hazard === HAZARD.PIRATE || site.hazard === HAZARD.DEEP_RISK;
  }

  return sites;
}

/**
 * Hazard class from weighted selection.  Weights are modulated by climate,
 * remoteness and how settled the area is, which keeps the global mix stable
 * while still putting pirates in the lawless corners and ice at the poles.
 */
function pickHazard(site, noise, nx, ny, rng, portDensity) {
  const w = {
    [HAZARD.CALM]: 0.20,
    [HAZARD.NORMAL]: 0.38,
    [HAZARD.STORMY]: 0.16,
    [HAZARD.PIRATE]: 0.16,
    [HAZARD.DEEP_RISK]: 0.07,
    [HAZARD.ICE]: 0.03,
  };

  if (site.climate === CLIMATE.POLAR) {
    w[HAZARD.ICE] *= 14;
    w[HAZARD.STORMY] *= 1.6;
    w[HAZARD.CALM] *= 0.25;
    w[HAZARD.PIRATE] *= 0.4;
  } else if (site.climate === CLIMATE.BOREAL) {
    w[HAZARD.ICE] *= 3;
    w[HAZARD.STORMY] *= 1.4;
  } else if (site.climate === CLIMATE.TROPICAL) {
    w[HAZARD.STORMY] *= 1.5; // hurricane belt
    w[HAZARD.PIRATE] *= 1.3;
  }

  // Remoteness: 0 at the map edge, 0.5 in the middle.
  const remote = Math.min(nx, ny, 1 - nx, 1 - ny);
  if (remote < 0.14) {
    w[HAZARD.DEEP_RISK] *= 6;
    w[HAZARD.PIRATE] *= 2.2;
    w[HAZARD.CALM] *= 0.2;
    w[HAZARD.NORMAL] *= 0.5;
  }

  // Settled water is policed water.
  if (portDensity > 0.6) {
    w[HAZARD.CALM] *= 2.4;
    w[HAZARD.PIRATE] *= 0.45;
    w[HAZARD.DEEP_RISK] *= 0.2;
  } else if (portDensity < 0.15) {
    w[HAZARD.PIRATE] *= 1.6;
    w[HAZARD.CALM] *= 0.5;
  }

  // A slow noise field makes neighbouring regions correlate instead of
  // alternating at random, so hazards form belts rather than a checkerboard.
  const f = noise.fbm(nx * 3.1 + 90, ny * 3.1 + 40, 3) * 0.5 + 0.5;
  w[HAZARD.PIRATE] *= 0.4 + f * 1.6;
  w[HAZARD.STORMY] *= 0.4 + (1 - f) * 1.6;

  const keys = Object.keys(w).map(Number);
  return rng.pickWeighted(keys, keys.map((k) => w[k]));
}

/** Which region contains a world position. */
export function regionAt(regions, worldX, worldY) {
  const cx = worldX / CELL_SIZE;
  const cy = worldY / CELL_SIZE;
  let best = regions[0];
  let bestD = Infinity;
  for (const r of regions) {
    const d = (r.cx - cx) ** 2 + (r.cy - cy) ** 2;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
