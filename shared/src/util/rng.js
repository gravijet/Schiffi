/**
 * Deterministic pseudo random numbers.
 *
 * The whole world - terrain, island placement, port names, wreck positions -
 * is derived from a single 32 bit seed.  Server and client run the *same*
 * generator so the client can draw the static world locally while the server
 * stays authoritative for everything mutable.  That means the algorithms in
 * here must never change silently: a changed algorithm changes every world.
 */

/** Fast, well distributed 32 bit hash (MurmurHash3 finaliser style). */
export function hash32(x) {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Combine several integers into one 32 bit seed. */
export function hashCombine(...values) {
  let h = 0x811c9dc5;
  for (const v of values) {
    h = (h ^ hash32(v | 0)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Turn an arbitrary string into a 32 bit seed (FNV-1a). */
export function seedFromString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * mulberry32 - tiny, fast, good enough statistical quality for a game world.
 * Returns a function producing floats in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Small stateful helper around mulberry32 with the operations we need a lot. */
export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
  }
  float() { return this._next(); }
  range(min, max) { return min + this._next() * (max - min); }
  int(min, maxExclusive) { return min + Math.floor(this._next() * (maxExclusive - min)); }
  chance(p) { return this._next() < p; }
  pick(arr) { return arr[Math.floor(this._next() * arr.length)]; }
  /** Weighted pick. `weights[i]` belongs to `arr[i]`; weights need not sum to 1. */
  pickWeighted(arr, weights) {
    let total = 0;
    for (const w of weights) total += w;
    let r = this._next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }
  /** Fisher-Yates, in place. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  /** Box-Muller normal deviate. */
  normal(mean = 0, stddev = 1) {
    const u = 1 - this._next();
    const v = this._next();
    return mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  fork(salt) { return new Rng(hashCombine(this.seed, salt)); }
}
