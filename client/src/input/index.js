/**
 * Input.
 *
 * Sailing is point-and-click, full stop: click (or tap - Pointer Events make
 * mouse, touch and pen the same code path in `main.js`) a spot on the water
 * and the ship follows a real, pre-computed route there. There is no
 * joystick, virtual or physical - a connected gamepad and a twin-stick feel
 * are exactly what a captain should not be able to fall back on, so neither
 * is wired up here. Keyboard events remain available for non-movement
 * shortcuts (see `KEY_BINDINGS`, currently empty, and the `shortcut` event).
 */
import { normalize } from '@schiffi/shared/util/math.js';
import { NAVIGABLE } from '@schiffi/shared/world/constants.js';
import { findPath } from './pathfinding.js';

// Sailing is point-and-click. Keyboard events remain available for shortcuts,
// but WASD/arrow keys no longer turn the ship into a twin-stick vehicle.
const KEY_BINDINGS = {};

/** Advance to the next waypoint once within this many world units of it. */
const WAYPOINT_RADIUS = 60;
/** Stop once within this many world units of the final destination. */
const ARRIVAL_RADIUS = 28;

export class InputManager extends EventTarget {
  constructor({ settings, position, terrain }) {
    super();
    this.settings = settings;
    this.keys = new Set();
    this.vector = { x: 0, y: 0 };
    this.source = 'keyboard';
    this.enabled = true;
    this.position = position;
    this.terrain = terrain;
    this.destination = null;
    this.path = null;
    this.pathIndex = 0;

    this._onKeyDown = (event) => this.onKeyDown(event);
    this._onKeyUp = (event) => this.onKeyUp(event);
    this._onBlur = () => { this.keys.clear(); this.update(); };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  destroy() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
  }

  /** True while a text field has focus: movement keys must not steal typing. */
  static isTyping() {
    const active = document.activeElement;
    if (!active) return false;
    const tag = active.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable;
  }

  onKeyDown(event) {
    if (!this.enabled || InputManager.isTyping()) return;
    const action = this.actionFor(event.code);
    if (action) {
      event.preventDefault();
      if (!this.keys.has(action)) {
        this.keys.add(action);
        this.source = 'keyboard';
        this.update();
      }
      return;
    }
    this.dispatchEvent(new CustomEvent('shortcut', { detail: { code: event.code, event } }));
  }

  onKeyUp(event) {
    const action = this.actionFor(event.code);
    if (!action) return;
    this.keys.delete(action);
    this.update();
  }

  actionFor(code) {
    for (const [action, codes] of Object.entries(KEY_BINDINGS)) {
      if (codes.includes(code)) return action;
    }
    return null;
  }

  /** Called once per frame. */
  poll() {
    if (!this.enabled) return this.vector;
    if (this.path && this.path.length) {
      const current = this.position?.();
      if (current) {
        // A waypoint reached this frame may put the next one within radius
        // too (short legs near a tight corner) - walk forward as far as
        // the ship's actual position allows, not just one step.
        while (this.pathIndex < this.path.length - 1
          && Math.hypot(this.path[this.pathIndex].x - current.x, this.path[this.pathIndex].y - current.y) <= WAYPOINT_RADIUS) {
          this.pathIndex++;
        }

        const target = this.path[this.pathIndex];
        const dx = target.x - current.x;
        const dy = target.y - current.y;
        const distance = Math.hypot(dx, dy);
        const isFinalWaypoint = this.pathIndex === this.path.length - 1;

        if (isFinalWaypoint && distance <= ARRIVAL_RADIUS) {
          this.clearDestination();
        } else {
          const [x, y] = normalize(dx, dy);
          this.vector = { x, y };
          this.source = 'pointer';
        }
        return this.vector;
      }
    }
    return this.vector;
  }

  update() {
    let x = 0;
    let y = 0;
    if (this.keys.has('left')) x -= 1;
    if (this.keys.has('right')) x += 1;
    if (this.keys.has('up')) y -= 1;
    if (this.keys.has('down')) y += 1;
    // Diagonals must not be faster than the cardinals.
    const [nx, ny] = normalize(x, y);
    this.vector = { x: nx, y: ny };
  }

  setDestination(point) {
    const current = this.position?.();
    const target = point && Number.isFinite(point.x) && Number.isFinite(point.y)
      ? this.nearestWater(point) : null;

    if (target && current) {
      this.destination = target;
      this.path = findPath(this.terrain, current, target);
      this.pathIndex = 0;
    } else {
      this.destination = null;
      this.path = null;
      this.pathIndex = 0;
    }
    this.keys.clear();
    this.dispatchEvent(new CustomEvent('destination', {
      detail: this.destination ? { target: this.destination, path: this.path } : null,
    }));
  }

  clearDestination() {
    this.destination = null;
    this.path = null;
    this.pathIndex = 0;
    this.vector = { x: 0, y: 0 };
    this.dispatchEvent(new CustomEvent('destination', { detail: null }));
  }

  isWater(x, y) {
    const terrain = this.terrain;
    if (!terrain) return true;
    const cx = Math.floor(x / terrain.cellSize);
    const cy = Math.floor(y / terrain.cellSize);
    if (cx < 0 || cy < 0 || cx >= terrain.width || cy >= terrain.height) return false;
    return Boolean(NAVIGABLE[terrain.cells[cy * terrain.width + cx]]);
  }

  /** A click on the shore targets the closest navigable cell, not dry land. */
  nearestWater(point) {
    if (!this.terrain || this.isWater(point.x, point.y)) return { x: point.x, y: point.y };
    const { width, height, cellSize } = this.terrain;
    const originX = Math.max(0, Math.min(width - 1, Math.floor(point.x / cellSize)));
    const originY = Math.max(0, Math.min(height - 1, Math.floor(point.y / cellSize)));
    for (let radius = 1; radius <= 64; radius++) {
      for (let x = originX - radius; x <= originX + radius; x++) {
        for (const y of [originY - radius, originY + radius]) {
          if (this.isWater((x + 0.5) * cellSize, (y + 0.5) * cellSize)) {
            return { x: (x + 0.5) * cellSize, y: (y + 0.5) * cellSize };
          }
        }
      }
      for (let y = originY - radius + 1; y < originY + radius; y++) {
        for (const x of [originX - radius, originX + radius]) {
          if (this.isWater((x + 0.5) * cellSize, (y + 0.5) * cellSize)) {
            return { x: (x + 0.5) * cellSize, y: (y + 0.5) * cellSize };
          }
        }
      }
    }
    return null;
  }
}
