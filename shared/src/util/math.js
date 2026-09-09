/** Small numeric helpers shared by simulation and renderer. */

export const TAU = Math.PI * 2;

export function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }
export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function invLerp(a, b, v) { return a === b ? 0 : (v - a) / (b - a); }
export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
export function remap(v, inMin, inMax, outMin, outMax) {
  return outMin + (outMax - outMin) * invLerp(inMin, inMax, v);
}

export function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
export function dist2(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  return dx * dx + dy * dy;
}

/** Normalise a vector to unit length; returns [0,0] for the zero vector. */
export function normalize(x, y) {
  const len = Math.hypot(x, y);
  if (len < 1e-9) return [0, 0];
  return [x / len, y / len];
}

/** Shortest signed angular difference from a to b, in radians. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Frame rate independent exponential approach ("lerp towards" done right). */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function roundTo(v, decimals) {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
