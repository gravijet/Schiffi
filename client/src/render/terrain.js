/**
 * Terrain decoding and base-image construction.
 *
 * The server sends the terrain grid as one compressed byte-per-cell blob. The
 * client turns it into a single ImageBitmap at one pixel per cell, which the
 * renderer then draws scaled. That is the whole trick behind the map being
 * cheap: no per-cell work happens during a frame, only one drawImage.
 *
 * The image is built in a worker where there is one, so decoding never stalls
 * the main thread; on a browser without workers it falls back to painting in
 * slices across several frames, which is slower but never freezes the page.
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
 * Build the base map image.
 *
 * Handed to a worker when the browser has one, which is both faster (no
 * yielding between slices) and smoother (the boot animation keeps running).
 * The main-thread path is kept as a fallback and slices as it always did, so
 * a browser without workers still gets a map rather than an error.
 *
 * @param {(progress:number)=>void} onProgress
 */
export async function buildTerrainImage(terrain, { theme = 'dark', detail = 1, onProgress } = {}) {
  const { width, height, cells } = terrain;
  const palette = theme === 'light' ? TERRAIN_COLOURS_LIGHT : TERRAIN_COLOURS;

  // Precompute the two variants per terrain class as packed integers.
  const variantA = new Uint32Array(16);
  const variantB = new Uint32Array(16);
  for (let t = 0; t < 16; t++) {
    const entry = palette[t] ?? palette[T.DEEP_OCEAN];
    variantA[t] = pack(entry[0]);
    variantB[t] = pack(entry[1]);
  }

  const offloaded = await buildInWorker({ cells, width, height, variantA, variantB, detail, onProgress });
  if (offloaded) return offloaded;
  return buildOnMainThread({ cells, width, height, variantA, variantB, detail, onProgress });
}

let workerFailed = false;

/** Try the worker. Returns null if there is none, or if it could not be used. */
async function buildInWorker({ cells, width, height, variantA, variantB, detail, onProgress }) {
  if (workerFailed || typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') return null;

  let worker;
  try {
    worker = new Worker(new URL('./terrainWorker.js', import.meta.url), { type: 'module' });
  } catch {
    workerFailed = true;
    return null;
  }

  // The worker gets its own copy of the cells: `terrain.cells` is a view on the
  // blob the rest of the client still reads for collision and the minimap, so
  // it must not be transferred away.
  const copy = cells.slice();

  try {
    const bitmap = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('terrain worker timed out')), 30_000);
      worker.onmessage = (event) => {
        clearTimeout(timer);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.bitmap);
      };
      worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)); };
      worker.postMessage(
        { id: 1, cells: copy, width, height, variantA, variantB, detail },
        [copy.buffer]);
    });
    onProgress?.(1);
    return bitmap;
  } catch (error) {
    // Fall back rather than fail: a map is not optional.
    console.warn('[terrain] worker unavailable, painting on the main thread:', error.message);
    workerFailed = true;
    return null;
  } finally {
    worker.terminate();
  }
}

/** The fallback: same painting, sliced so the page keeps responding. */
async function buildOnMainThread({ cells, width, height, variantA, variantB, detail, onProgress }) {
  const image = new ImageData(width, height);
  const words = new Uint32Array(image.data.buffer);

  const SLICE_ROWS = 64;
  for (let y0 = 0; y0 < height; y0 += SLICE_ROWS) {
    const y1 = Math.min(height, y0 + SLICE_ROWS);
    paintRows(words, cells, width, height, variantA, variantB, detail, y0, y1);
    onProgress?.(y1 / height);
    // Yield to the event loop: the boot screen keeps animating.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return createImageBitmap(image);
}

/**
 * Paint rows [y0, y1) into `words`.
 *
 * Shared with the worker in intent, deliberately duplicated in code: importing
 * this module from the worker would pull the whole render palette and its DOM
 * assumptions into the worker bundle. The two must be kept in step.
 */
function paintRows(words, cells, width, height, variantA, variantB, detail, y0, y1) {
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const index = row + x;
      const t = cells[index];
      const h = ((x * 73856093) ^ (y * 19349663)) & 0xff;
      let colour = h < 128 * detail ? variantA[t] : variantB[t];

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
