/**
 * Terrain decoding and base-image construction.
 *
 * The server sends the terrain grid as one compressed byte-per-cell blob. The
 * client turns it into a single ImageBitmap at one pixel per cell, which the
 * renderer then draws scaled. That is the whole trick behind the map being
 * cheap: no per-cell work happens during a frame, only one drawImage.
 *
 * The image is built in slices across several frames so a weak device never
 * stalls for a second while it decodes.
 */
import { CELLS_X, CELLS_Y, CELL_SIZE, T, IS_LAND, NAVIGABLE } from '@schiffi/shared/world/constants.js';
import { TERRAIN_COLOURS, TERRAIN_COLOURS_LIGHT } from './palette.js';

const MAGIC = 'SCHF';

/** Parse the blob the server serves at /api/worlds/:id/terrain. */
export function decodeTerrain(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== MAGIC) throw new Error('not a Schiffi terrain blob');

  const version = view.getUint16(4, true);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  const cellSize = view.getUint16(10, true);
  const seed = view.getUint32(12, true);

  const cells = new Uint8Array(buffer, 16, width * height);
  if (width !== CELLS_X || height !== CELLS_Y) {
    throw new Error(`terrain is ${width}x${height}, this build expects ${CELLS_X}x${CELLS_Y}`);
  }
  return { version, width, height, cellSize, seed, cells };
}

/**
 * Build the base map image, yielding between slices.
 * @param {(progress:number)=>void} onProgress
 */
export async function buildTerrainImage(terrain, { theme = 'dark', detail = 1, onProgress } = {}) {
  const { width, height, cells } = terrain;
  const palette = theme === 'light' ? TERRAIN_COLOURS_LIGHT : TERRAIN_COLOURS;
  const image = new ImageData(width, height);
  const pixels = image.data;

  // Precompute the two variants per terrain class as packed integers.
  const variantA = new Uint32Array(16);
  const variantB = new Uint32Array(16);
  for (let t = 0; t < 16; t++) {
    const entry = palette[t] ?? palette[T.DEEP_OCEAN];
    variantA[t] = pack(entry[0]);
    variantB[t] = pack(entry[1]);
  }
  const words = new Uint32Array(pixels.buffer);

  const SLICE_ROWS = 64;
  for (let y0 = 0; y0 < height; y0 += SLICE_ROWS) {
    const y1 = Math.min(height, y0 + SLICE_ROWS);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        const t = cells[index];
        // A cheap hash decides which variant a cell uses: enough irregularity
        // to break up flat areas, and stable between frames.
        const h = ((x * 73856093) ^ (y * 19349663)) & 0xff;
        let colour = h < 128 * detail ? variantA[t] : variantB[t];

        // Coastlines get a darker rim so the shore reads at low zoom.
        if (IS_LAND[t] && detail > 0.25) {
          const left = x > 0 ? cells[index - 1] : t;
          const right = x < width - 1 ? cells[index + 1] : t;
          const up = y > 0 ? cells[index - width] : t;
          const down = y < height - 1 ? cells[index + width] : t;
          if (NAVIGABLE[left] || NAVIGABLE[right] || NAVIGABLE[up] || NAVIGABLE[down]) {
            colour = darken(colour, 0.72);
          }
        }
        words[index] = colour;
      }
    }
    onProgress?.(y1 / height);
    // Yield to the event loop: the boot screen keeps animating.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return createImageBitmap(image);
}

/** A small overview image for the minimap, at one pixel per four cells. */
export function buildMinimapImage(terrain, theme = 'dark') {
  const scale = 4;
  const width = Math.ceil(terrain.width / scale);
  const height = Math.ceil(terrain.height / scale);
  const image = new ImageData(width, height);
  const words = new Uint32Array(image.data.buffer);
  const palette = theme === 'light' ? TERRAIN_COLOURS_LIGHT : TERRAIN_COLOURS;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Sample the middle of the block: averaging terrain classes is meaningless.
      const sx = Math.min(terrain.width - 1, x * scale + 2);
      const sy = Math.min(terrain.height - 1, y * scale + 2);
      const t = terrain.cells[sy * terrain.width + sx];
      words[y * width + x] = pack((palette[t] ?? palette[T.DEEP_OCEAN])[0]);
    }
  }
  return { image, width, height, scale };
}

/** Terrain class at a world position. */
export function terrainAtWorld(terrain, x, y) {
  const cx = Math.floor(x / CELL_SIZE);
  const cy = Math.floor(y / CELL_SIZE);
  if (cx < 0 || cy < 0 || cx >= terrain.width || cy >= terrain.height) return T.DEEP_OCEAN;
  return terrain.cells[cy * terrain.width + cx];
}

export function isWaterAtWorld(terrain, x, y) {
  return NAVIGABLE[terrainAtWorld(terrain, x, y)] === 1;
}

function pack({ r, g, b }) {
  // Little-endian RGBA.
  return (255 << 24) | (b << 16) | (g << 8) | r;
}

function darken(colour, factor) {
  const r = Math.round((colour & 0xff) * factor);
  const g = Math.round(((colour >> 8) & 0xff) * factor);
  const b = Math.round(((colour >> 16) & 0xff) * factor);
  return (255 << 24) | (b << 16) | (g << 8) | r;
}
