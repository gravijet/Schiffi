/**
 * The world portrait: a small PNG of the whole map, drawn on the server.
 *
 * The main menu needs to show the actual world, not a decorative background.
 * The obvious way - hand the client the terrain blob and let it draw - costs a
 * 44 KiB download plus a 655 000 cell decode before the menu can paint, which
 * is exactly the wrong trade on the weak devices this game is meant to run on.
 *
 * So the server draws it once per world and per theme, into a ~9 KiB PNG that
 * the browser decodes on its own thread. It is derived purely from the seed,
 * so it is cached in memory here and may be cached forever downstream.
 *
 * PNG is written by hand: it is a few hundred bytes of framing around a zlib
 * stream, and pulling in an image library to emit fourteen colours would be a
 * poor trade for the dependency.
 */
import { deflateSync, crc32 } from 'node:zlib';
import { T, CELLS_X, CELLS_Y, CELL_SIZE } from '@schiffi/shared/world/constants.js';
import { TERRAIN_COLOURS, TERRAIN_COLOURS_LIGHT } from '@schiffi/shared/world/palette.js';

/** Portrait size. Wide enough to read a coastline, small enough to be free. */
const WIDTH = 512;
const HEIGHT = 320;

const cache = new Map();   // `${worldId}:${seed}:${theme}` -> Buffer

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Encode 8-bit truecolour RGB.
 *
 * Filter byte 0 (none) on every row: the image is 512 px of noisy terrain
 * classes, where the adaptive filters buy a few per cent for a lot of work.
 */
function encodePng(width, height, rgb) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: truecolour
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Sample the terrain grid down to the portrait size.
 *
 * Nearest neighbour on purpose: terrain cells are *classes*, not values, and
 * averaging class 0 (deep ocean) with class 8 (mountain) yields class 4
 * (beach), which would sprinkle imaginary beaches across the open sea.
 */
function drawTerrain(terrain, cellsX, cellsY, palette) {
  const out = Buffer.alloc(WIDTH * HEIGHT * 3);

  for (let y = 0; y < HEIGHT; y++) {
    const sy = Math.min(cellsY - 1, Math.floor((y / HEIGHT) * cellsY));
    for (let x = 0; x < WIDTH; x++) {
      const sx = Math.min(cellsX - 1, Math.floor((x / WIDTH) * cellsX));
      const cls = terrain[sy * cellsX + sx];
      const variants = palette[cls] ?? palette[T.DEEP_OCEAN];
      // The same cheap hash the live renderer uses, so the portrait has the
      // same grain as the map it is a portrait of.
      const colour = variants[((sx * 73856093) ^ (sy * 19349663)) & 1];
      const at = (y * WIDTH + x) * 3;
      out[at] = colour.r;
      out[at + 1] = colour.g;
      out[at + 2] = colour.b;
    }
  }
  return out;
}

/** Mark the ports, so the portrait shows a world that is inhabited. */
function drawPorts(pixels, ports, cellsX, cellsY, cellSize) {
  const dot = { r: 240, g: 212, b: 120 };
  for (const port of ports) {
    const x = Math.round((port.x / (cellsX * cellSize)) * WIDTH);
    const y = Math.round((port.y / (cellsY * cellSize)) * HEIGHT);
    if (x < 1 || y < 1 || x >= WIDTH - 1 || y >= HEIGHT - 1) continue;
    const at = (y * WIDTH + x) * 3;
    pixels[at] = dot.r; pixels[at + 1] = dot.g; pixels[at + 2] = dot.b;
  }
}

/**
 * The portrait for a loaded world instance.
 * Cached per world, seed and theme; the seed is in the key so a regenerated
 * world cannot serve a stale picture of the previous one.
 */
export function worldPortrait(instance, theme = 'dark') {
  const key = `${instance.id}:${instance.seed}:${theme}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const palette = theme === 'light' ? TERRAIN_COLOURS_LIGHT : TERRAIN_COLOURS;

  const pixels = drawTerrain(instance.world.terrain, CELLS_X, CELLS_Y, palette);
  drawPorts(pixels, instance.world.ports ?? [], CELLS_X, CELLS_Y, CELL_SIZE);

  const png = encodePng(WIDTH, HEIGHT, pixels);
  cache.set(key, png);
  return png;
}

export const PORTRAIT_SIZE = { width: WIDTH, height: HEIGHT };
