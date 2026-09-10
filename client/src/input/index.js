/**
 * Input.
 *
 * Three sources produce the same thing: a direction vector in [-1, 1]^2 that
 * the network layer sends as intent. Keyboard gives a normalised diagonal,
 * gamepad applies a dead zone and rescales so the stick still reaches full
 * tilt, and touch drives a virtual joystick.
 *
 * The vector is normalised here as well as on the server: locally so diagonal
 * movement is not faster than cardinal, and on the server because a client is
 * not to be trusted with that.
 */
import { normalize } from '@schiffi/shared/util/math.js';
import { CELL_SIZE, NAVIGABLE } from '@schiffi/shared/world/constants.js';

// Sailing is point-and-click. Keyboard events remain available for shortcuts,
// but WASD/arrow keys no longer turn the ship into a twin-stick vehicle.
const KEY_BINDINGS = {};

export class InputManager extends EventTarget {
  constructor({ settings, position, terrain }) {
    super();
    this.settings = settings;
    this.keys = new Set();
    this.vector = { x: 0, y: 0 };
    this.source = 'keyboard';
    this.gamepadIndex = null;
    this.touchActive = false;
    this.touchVector = { x: 0, y: 0 };
    this.enabled = true;
    this.position = position;
    this.terrain = terrain;
    this.destination = null;
    this.avoidSign = 0;

    this._onKeyDown = (event) => this.onKeyDown(event);
    this._onKeyUp = (event) => this.onKeyUp(event);
    this._onBlur = () => { this.keys.clear(); this.update(); };
    this._onGamepadConnected = (event) => this.onGamepadConnected(event);
    this._onGamepadDisconnected = (event) => this.onGamepadDisconnected(event);

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('gamepadconnected', this._onGamepadConnected);
    window.addEventListener('gamepaddisconnected', this._onGamepadDisconnected);

    // A gamepad already connected before load only appears after the first
    // interaction, so poll once at startup as well.
    this.detectGamepad();
  }

  destroy() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('gamepadconnected', this._onGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this._onGamepadDisconnected);
    this.detachJoystick();
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
    const layout = this.settings.get('controls.keyboardLayout', 'arrows');
    for (const [action, codes] of Object.entries(KEY_BINDINGS)) {
      for (const candidate of codes) {
        const isArrow = candidate.startsWith('Arrow');
        if (layout === 'arrows' && !isArrow) continue;
        if (layout === 'wasd' && isArrow) continue;
        if (candidate === code) return action;
      }
    }
    return null;
  }

  onGamepadConnected(event) {
    this.gamepadIndex = event.gamepad.index;
    this.dispatchEvent(new CustomEvent('gamepad', { detail: { connected: true, id: event.gamepad.id } }));
  }

  onGamepadDisconnected(event) {
    if (this.gamepadIndex === event.gamepad.index) this.gamepadIndex = null;
    this.detectGamepad();
    this.dispatchEvent(new CustomEvent('gamepad', { detail: { connected: false, id: event.gamepad.id } }));
  }

  detectGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (pad?.connected) { this.gamepadIndex = pad.index; return; }
    }
  }

  /** Called once per frame: gamepads must be polled, they do not fire events. */
  poll() {
    if (!this.enabled) return this.vector;
    if (this.touchActive) {
      this.vector = { ...this.touchVector };
      this.source = 'touch';
      return this.vector;
    }
    if (this.destination) {
      const current = this.position?.();
      if (current) {
        const dx = this.destination.x - current.x;
        const dy = this.destination.y - current.y;
        const distance = Math.hypot(dx, dy);
        if (distance <= 28) {
          this.destination = null;
          this.vector = { x: 0, y: 0 };
          this.dispatchEvent(new CustomEvent('destination', { detail: null }));
        } else {
          const [x, y] = normalize(dx, dy);
          this.vector = this.steerAroundLand(current, { x, y }, distance);
          this.source = 'pointer';
        }
        return this.vector;
      }
    }
    if (this.gamepadIndex !== null) {
      const pad = navigator.getGamepads?.()[this.gamepadIndex];
      if (pad?.connected) {
        const deadzone = this.settings.get('controls.deadzone', 0.12);
        const raw = { x: pad.axes[0] ?? 0, y: pad.axes[1] ?? 0 };
        const magnitude = Math.hypot(raw.x, raw.y);
        if (magnitude > deadzone) {
          // Rescale past the dead zone so full tilt is still full speed.
          const scaled = (magnitude - deadzone) / (1 - deadzone);
          const [nx, ny] = normalize(raw.x, raw.y);
          const invert = this.settings.get('controls.invertY', false) ? -1 : 1;
          this.vector = { x: nx * scaled, y: ny * scaled * invert };
          this.source = 'gamepad';
          return this.vector;
        }
        // The stick is centred: fall through to the keyboard so both work.
        if (this.keys.size === 0 && this.source === 'gamepad') {
          this.vector = { x: 0, y: 0 };
          return this.vector;
        }
      } else {
        this.gamepadIndex = null;
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
    this.destination = point && Number.isFinite(point.x) && Number.isFinite(point.y)
      ? this.nearestWater(point) : null;
    this.avoidSign = 0;
    this.keys.clear();
    this.dispatchEvent(new CustomEvent('destination', { detail: this.destination }));
  }

  /** Keep click-to-sail useful when the direct line brushes an island. */
  steerAroundLand(current, desired, distance) {
    if (!this.terrain || this.waterAhead(current, desired, Math.min(distance, 110))) {
      this.avoidSign = 0;
      return desired;
    }
    const base = Math.atan2(desired.y, desired.x);
    const signs = this.avoidSign ? [this.avoidSign, -this.avoidSign] : [1, -1];
    for (let degrees = 15; degrees <= 165; degrees += 15) {
      for (const sign of signs) {
        const angle = base + sign * degrees * Math.PI / 180;
        const candidate = { x: Math.cos(angle), y: Math.sin(angle) };
        if (this.waterAhead(current, candidate, 110)) {
          this.avoidSign = sign;
          return candidate;
        }
      }
    }
    return { x: 0, y: 0 };
  }

  waterAhead(current, vector, distance) {
    const steps = Math.max(1, Math.ceil(distance / CELL_SIZE));
    for (let step = 1; step <= steps; step++) {
      const scale = Math.min(distance, step * CELL_SIZE);
      if (!this.isWater(current.x + vector.x * scale, current.y + vector.y * scale)) return false;
    }
    return true;
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

  // --- virtual joystick ----------------------------------------------------

  attachJoystick(element) {
    this.joystick = element;
    const knob = element.querySelector('.knob');
    const radius = element.clientWidth / 2;
    let pointerId = null;

    const setFrom = (clientX, clientY) => {
      const rect = element.getBoundingClientRect();
      const dx = clientX - (rect.left + rect.width / 2);
      const dy = clientY - (rect.top + rect.height / 2);
      const distance = Math.min(radius, Math.hypot(dx, dy));
      const angle = Math.atan2(dy, dx);
      const magnitude = distance / radius;
      const deadzone = this.settings.get('controls.deadzone', 0.12);

      knob.style.transform = `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px)`;
      if (magnitude < deadzone) {
        this.touchVector = { x: 0, y: 0 };
      } else {
        const scaled = (magnitude - deadzone) / (1 - deadzone);
        this.touchVector = { x: Math.cos(angle) * scaled, y: Math.sin(angle) * scaled };
      }
    };

    this._joystickDown = (event) => {
      if (pointerId !== null) return;
      pointerId = event.pointerId;
      element.setPointerCapture(pointerId);
      this.touchActive = true;
      this.destination = null;
      setFrom(event.clientX, event.clientY);
      event.preventDefault();
    };
    this._joystickMove = (event) => {
      if (event.pointerId !== pointerId) return;
      setFrom(event.clientX, event.clientY);
      event.preventDefault();
    };
    this._joystickUp = (event) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      this.touchActive = false;
      this.touchVector = { x: 0, y: 0 };
      this.vector = { x: 0, y: 0 };
      knob.style.transform = 'translate(0, 0)';
    };

    element.addEventListener('pointerdown', this._joystickDown);
    element.addEventListener('pointermove', this._joystickMove);
    element.addEventListener('pointerup', this._joystickUp);
    element.addEventListener('pointercancel', this._joystickUp);
  }

  detachJoystick() {
    if (!this.joystick) return;
    this.joystick.removeEventListener('pointerdown', this._joystickDown);
    this.joystick.removeEventListener('pointermove', this._joystickMove);
    this.joystick.removeEventListener('pointerup', this._joystickUp);
    this.joystick.removeEventListener('pointercancel', this._joystickUp);
    this.joystick = null;
  }
}

/** Should the on-screen joystick be shown? */
export function shouldUseTouch(settings) {
  const mode = settings.get('controls.virtualJoystick', 'auto');
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return matchMedia('(pointer: coarse)').matches;
}
