/**
 * World scale and terrain classification.
 *
 * The world is a fixed size grid of terrain cells.  One cell is CELL_SIZE
 * world units across; ships move in world units with sub-cell precision.
 * Everything here is part of the world *contract*: changing a number changes
 * every world generated from a given seed, so these values are versioned.
 */

export const WORLDGEN_VERSION = 1;

/** Terrain grid resolution.  ~655k cells: fits in one Uint8Array of 640 KiB. */
export const CELLS_X = 1024;
export const CELLS_Y = 640;

/** World units per terrain cell. */
export const CELL_SIZE = 24;

export const WORLD_W = CELLS_X * CELL_SIZE; // 24576
export const WORLD_H = CELLS_Y * CELL_SIZE; // 15360

/** Terrain classes, stored one byte per cell. */
export const T = {
  DEEP_OCEAN: 0,
  OCEAN: 1,
  SHALLOW: 2,
  REEF: 3,
  BEACH: 4,
  PLAIN: 5,
  FOREST: 6,
  HILL: 7,
  MOUNTAIN: 8,
  SNOW: 9,
  DESERT: 10,
  SWAMP: 11,
  VOLCANO: 12,
  ICE: 13,
};

/** Cells a ship can float on. */
export const NAVIGABLE = new Uint8Array(16);
NAVIGABLE[T.DEEP_OCEAN] = 1;
NAVIGABLE[T.OCEAN] = 1;
NAVIGABLE[T.SHALLOW] = 1;
NAVIGABLE[T.REEF] = 1; // navigable, but damages the hull

/** Cells that count as land for island detection. */
export const IS_LAND = new Uint8Array(16);
for (const t of [T.BEACH, T.PLAIN, T.FOREST, T.HILL, T.MOUNTAIN, T.SNOW, T.DESERT, T.SWAMP, T.VOLCANO, T.ICE]) {
  IS_LAND[t] = 1;
}

/** Elevation thresholds applied to the normalised height field [0..1]. */
export const ELEV = {
  DEEP: 0.30,
  OCEAN: 0.42,
  SHALLOW: 0.485,
  COAST: 0.50,   // >= this is land
  PLAIN: 0.58,
  HILL: 0.68,
  MOUNTAIN: 0.78,
  PEAK: 0.88,
};

/** Target fraction of the map that is land.  The generator calibrates to it. */
export const TARGET_LAND_FRACTION = 0.215;

/** Climate bands by absolute latitude (0 = equator, 1 = pole). */
export const CLIMATE = {
  TROPICAL: 0,
  SUBTROPICAL: 1,
  TEMPERATE: 2,
  BOREAL: 3,
  POLAR: 4,
};

export const CLIMATE_NAMES = ['tropical', 'subtropical', 'temperate', 'boreal', 'polar'];

/**
 * Probability that a discovered landmass is an "undiscovered island" -
 * uncharted, no regular port, first-discovery rewards.
 *
 * The design document specifies
 *   3.8257686928648962578264589623749526345962895625623958774666...%
 * which has far more digits than an IEEE-754 double can represent.  We keep
 * the literal on record and use the nearest representable double; the error
 * is below 1e-17 and cannot influence a single generated world.
 */
export const UNDISCOVERED_ISLAND_PROBABILITY_LITERAL =
  '3.8257686928648962578264589623749526345962895625623958774666666666666666666666666666666666666666644444444444444444445692574836592756294597325698364537890475209745';
export const UNDISCOVERED_ISLAND_PROBABILITY = 0.038257686928648962578264589623749526;

/** Undiscovered islands appear in clusters; this is the cluster field scale. */
export const UNDISCOVERED_CLUSTER_FREQ = 3.5;
export const UNDISCOVERED_CLUSTER_BIAS = 5.5;

/** Fog of war is tracked on a coarser grid than terrain to keep saves small. */
export const FOG_CELL_SIZE = CELL_SIZE * 4; // 96 world units
export const FOG_X = Math.ceil(WORLD_W / FOG_CELL_SIZE);
export const FOG_Y = Math.ceil(WORLD_H / FOG_CELL_SIZE);

/** Spatial hash cell used for entity broad-phase queries. */
export const GRID_CELL = 512;
