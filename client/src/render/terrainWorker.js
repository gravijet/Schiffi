/**
 * Terrain image builder, off the main thread.
 *
 * Painting 655 360 cells with a neighbour test on each is the single most
 * expensive thing the client does at load. On the main thread it has to be
 * sliced and yielded between slices, which makes it slower overall and still
 * stutters the boot animation. In a worker it runs straight through, and the
 * finished bitmap comes back as a transferable, so nothing is copied.
 *
 * The palette is passed in as packed integers rather than imported: the worker
 * then has no dependency on the DOM side of the render code, and a theme
 * change is just a different message.
 */
import { IS_LAND, NAVIGABLE } from '@schiffi/shared/world/constants.js';

self.onmessage = async (event) => {
  const { id, cells, width, height, variantA, variantB, detail } = event.data;
  try {
    const image = new ImageData(width, height);
    const words = new Uint32Array(image.data.buffer);
    paint(words, cells, width, height, variantA, variantB, detail);
    const bitmap = await createImageBitmap(image);
    self.postMessage({ id, bitmap }, [bitmap]);
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};

/** Shared with the main-thread fallback in terrain.js; keep the two in step. */
function paint(words, cells, width, height, variantA, variantB, detail) {
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const index = row + x;
      const t = cells[index];
      // A cheap hash decides which variant a cell uses: enough irregularity to
      // break up flat areas, and stable between frames.
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
}

function darken(colour, factor) {
  const r = Math.round((colour & 0xff) * factor);
  const g = Math.round(((colour >> 8) & 0xff) * factor);
  const b = Math.round(((colour >> 16) & 0xff) * factor);
  return (255 << 24) | (b << 16) | (g << 8) | r;
}
