/**
 * Water pathfinding for click-to-sail.
 *
 * Replaces the old per-frame greedy raycast dodge: a route is computed once,
 * up front, as a real list of waypoints that bend around land - the ship
 * then steers through them in order. Because the ship's turn rate is capped
 * (see server's `moveShip`), following a sequence of waypoints naturally
 * rounds each corner into a curve instead of snapping, the way a unit in
 * openfront.io tracks a pre-planned route.
 *
 * Two-resolution approach, both derived from the same fine navigability
 * data the renderer/server already use:
 *   - a coarse grid (a handful of fine cells per coarse cell) is what A*
 *     actually searches, so a search spanning a large chunk of the map stays
 *     cheap - it only ever runs once per click, never per frame
 *   - the fine grid is used for line-of-sight checks, both as a fast path
 *     (skip the search entirely when the destination is directly reachable,
 *     the common case in open water) and to string-pull the coarse result
 *     back down into the minimum number of real corner waypoints
 */
import { CELL_SIZE, NAVIGABLE } from '@schiffi/shared/world/constants.js';

const COARSE_FACTOR = 4; // 4 fine cells (96 world units) per coarse cell
const COARSE_MIN_WATER_FRACTION = 0.5;

const coarseCache = new WeakMap();

function isWater(terrain, x, y) {
  const cx = Math.floor(x / terrain.cellSize);
  const cy = Math.floor(y / terrain.cellSize);
  if (cx < 0 || cy < 0 || cx >= terrain.width || cy >= terrain.height) return false;
  return Boolean(NAVIGABLE[terrain.cells[cy * terrain.width + cx]]);
}

/** Stepped raycast on the fine grid: true if every sample along a-b is water. */
function hasLineOfSight(terrain, ax, ay, bx, by) {
  const distance = Math.hypot(bx - ax, by - ay);
  if (distance === 0) return isWater(terrain, ax, ay);
  const steps = Math.max(1, Math.ceil(distance / CELL_SIZE));
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    if (!isWater(terrain, ax + (bx - ax) * t, ay + (by - ay) * t)) return false;
  }
  return true;
}

function buildCoarseGrid(terrain) {
  let grid = coarseCache.get(terrain);
  if (grid) return grid;

  const width = Math.ceil(terrain.width / COARSE_FACTOR);
  const height = Math.ceil(terrain.height / COARSE_FACTOR);
  const navigable = new Uint8Array(width * height);

  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      const x0 = cx * COARSE_FACTOR;
      const y0 = cy * COARSE_FACTOR;
      const x1 = Math.min(terrain.width, x0 + COARSE_FACTOR);
      const y1 = Math.min(terrain.height, y0 + COARSE_FACTOR);
      let water = 0;
      let total = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * terrain.width;
        for (let x = x0; x < x1; x++) {
          total++;
          if (NAVIGABLE[terrain.cells[row + x]]) water++;
        }
      }
      navigable[cy * width + cx] = total > 0 && water / total >= COARSE_MIN_WATER_FRACTION ? 1 : 0;
    }
  }

  grid = { width, height, cellSize: terrain.cellSize * COARSE_FACTOR, navigable };
  coarseCache.set(terrain, grid);
  return grid;
}

/** Nearest navigable coarse cell to (cx, cy), spiralling outward. Null if none found. */
function nearestCoarseCell(grid, cx, cy) {
  if (cx >= 0 && cy >= 0 && cx < grid.width && cy < grid.height && grid.navigable[cy * grid.width + cx]) {
    return { cx, cy };
  }
  for (let radius = 1; radius <= 24; radius++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      for (const y of [cy - radius, cy + radius]) {
        if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
        if (grid.navigable[y * grid.width + x]) return { cx: x, cy: y };
      }
    }
    for (let y = cy - radius + 1; y < cy + radius; y++) {
      for (const x of [cx - radius, cx + radius]) {
        if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
        if (grid.navigable[y * grid.width + x]) return { cx: x, cy: y };
      }
    }
  }
  return null;
}

const NEIGHBOURS = [
  { dx: 1, dy: 0, cost: 1 }, { dx: -1, dy: 0, cost: 1 },
  { dx: 0, dy: 1, cost: 1 }, { dx: 0, dy: -1, cost: 1 },
  { dx: 1, dy: 1, cost: Math.SQRT2 }, { dx: 1, dy: -1, cost: Math.SQRT2 },
  { dx: -1, dy: 1, cost: Math.SQRT2 }, { dx: -1, dy: -1, cost: Math.SQRT2 },
];

/** A* over the coarse grid. Returns a list of {cx, cy} cells, or null. */
function searchCoarsePath(grid, start, goal) {
  const key = (cx, cy) => cy * grid.width + cx;
  const startKey = key(start.cx, start.cy);
  const goalKey = key(goal.cx, goal.cy);
  if (startKey === goalKey) return [start];

  const open = new MinHeap();
  const gScore = new Map([[startKey, 0]]);
  const cameFrom = new Map();
  const octile = (cx, cy) => {
    const dx = Math.abs(cx - goal.cx);
    const dy = Math.abs(cy - goal.cy);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  open.push({ key: startKey, cx: start.cx, cy: start.cy, f: octile(start.cx, start.cy) });

  const visited = new Set();
  // A generous but bounded expansion cap: a one-shot click-time search
  // should never be allowed to stall the main thread on a pathological map.
  const maxExpansions = 40_000;
  let expansions = 0;

  while (!open.isEmpty() && expansions < maxExpansions) {
    const current = open.pop();
    if (visited.has(current.key)) continue;
    visited.add(current.key);
    expansions++;

    if (current.key === goalKey) {
      const path = [];
      let node = current.key;
      while (node !== undefined) {
        const cy = Math.floor(node / grid.width);
        const cx = node - cy * grid.width;
        path.push({ cx, cy });
        node = cameFrom.get(node);
      }
      path.reverse();
      return path;
    }

    const baseG = gScore.get(current.key);
    for (const { dx, dy, cost } of NEIGHBOURS) {
      const nx = current.cx + dx;
      const ny = current.cy + dy;
      if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
      if (!grid.navigable[ny * grid.width + nx]) continue;
      // No cutting diagonally between two blocked orthogonal cells - a ship
      // must not clip a land corner just because both diagonal neighbours
      // happen to be water.
      if (dx !== 0 && dy !== 0) {
        if (!grid.navigable[current.cy * grid.width + nx]) continue;
        if (!grid.navigable[ny * grid.width + current.cx]) continue;
      }
      const nKey = key(nx, ny);
      if (visited.has(nKey)) continue;
      const tentativeG = baseG + cost;
      if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
        gScore.set(nKey, tentativeG);
        cameFrom.set(nKey, current.key);
        open.push({ key: nKey, cx: nx, cy: ny, f: tentativeG + octile(nx, ny) });
      }
    }
  }
  return null;
}

/** Minimal binary min-heap keyed by `.f`, just enough for A*'s open set. */
class MinHeap {
  constructor() { this.items = []; }
  isEmpty() { return this.items.length === 0; }
  push(item) {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].f <= items[i].f) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = i * 2 + 2;
        let smallest = i;
        if (l < items.length && items[l].f < items[smallest].f) smallest = l;
        if (r < items.length && items[r].f < items[smallest].f) smallest = r;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/** Collapse a dense point list to the minimum waypoints, via fine-grid line-of-sight. */
function stringPull(terrain, points) {
  if (points.length <= 2) return points;
  const result = [points[0]];
  let index = 0;
  while (index < points.length - 1) {
    let next = index + 1;
    for (let j = points.length - 1; j > index + 1; j--) {
      if (hasLineOfSight(terrain, points[index].x, points[index].y, points[j].x, points[j].y)) {
        next = j;
        break;
      }
    }
    result.push(points[next]);
    index = next;
  }
  return result;
}

/**
 * Find a sailing route from `from` to `to`, both world points. `to` is
 * assumed already snapped onto navigable water by the caller.
 *
 * @returns {{x:number,y:number}[]} always at least [from, to] - falls back
 *   to a direct line if no route can be found, rather than stranding input.
 */
export function findPath(terrain, from, to) {
  if (!terrain) return [from, to];
  if (hasLineOfSight(terrain, from.x, from.y, to.x, to.y)) return [from, to];

  const grid = buildCoarseGrid(terrain);
  const start = nearestCoarseCell(grid, Math.floor(from.x / grid.cellSize), Math.floor(from.y / grid.cellSize));
  const goal = nearestCoarseCell(grid, Math.floor(to.x / grid.cellSize), Math.floor(to.y / grid.cellSize));
  if (!start || !goal) return [from, to];

  const coarsePath = searchCoarsePath(grid, start, goal);
  if (!coarsePath) return [from, to];

  const points = [
    from,
    ...coarsePath.map(({ cx, cy }) => ({
      x: (cx + 0.5) * grid.cellSize,
      y: (cy + 0.5) * grid.cellSize,
    })),
    to,
  ];
  return stringPull(terrain, points);
}
