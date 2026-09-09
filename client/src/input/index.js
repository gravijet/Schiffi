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

const KEY_BINDINGS = {
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
};

export class InputManager extends EventTarget {
  constructor({ settings }) {
    super();
    this.settings = settings;
    this.keys = new Set();
    this.vector = { x: 0, y: 0 };
    this.source = 'keyboard';
    this.gamepadIndex = null;
    this.touchActive = false;
    this.touchVector = { x: 0, y: 0 };
    this.enabled = true;

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
