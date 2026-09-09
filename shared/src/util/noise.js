/**
 * Gradient noise used by the world generator.
 *
 * Classic 2D Perlin noise with a seed-derived permutation table, plus fBm and
 * ridged variants and a domain-warp helper.  Domain warping is what stops the
 * coastlines from looking like blurry blobs - it bends the noise field with
 * another noise field, which produces the fjords, peninsulas and bays that
 * make a map read as "natural" rather than "pixel soup".
 */
import { Rng } from './rng.js';

export class Noise2D {
  constructor(seed) {
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    rng.shuffle(p);
    // Doubled table avoids an index wrap in the hot loop.
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 8;
    }
  }

  /** Raw Perlin noise in roughly [-1, 1]. */
  noise(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const perm = this.perm;
    const aa = perm[perm[X] + Y];
    const ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y];
    const bb = perm[perm[X + 1] + Y + 1];
    const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
    const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }

  /** Fractal Brownian motion: octaves of noise at doubling frequency. */
  fbm(x, y, octaves = 5, lacunarity = 2.0, gain = 0.5) {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal - produces mountain ridges and sharp island spines. */
  ridged(x, y, octaves = 5, lacunarity = 2.0, gain = 0.5) {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return (sum / norm) * 2 - 1;
  }
}

/**
 * Warp a sample point with a second noise field before sampling the first.
 * `strength` is in the same units as the input coordinates.
 */
export function domainWarp(noise, x, y, strength, freq = 1) {
  const wx = noise.fbm(x * freq + 5.2, y * freq + 1.3, 3);
  const wy = noise.fbm(x * freq + 9.7, y * freq + 4.1, 3);
  return [x + wx * strength, y + wy * strength];
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + t * (b - a); }
function grad(hash, x, y) {
  // 8 evenly spaced gradient directions.
  switch (hash & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x * 1.4142135;
    case 5: return -x * 1.4142135;
    case 6: return y * 1.4142135;
    default: return -y * 1.4142135;
  }
}
