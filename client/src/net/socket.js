/**
 * Game socket.
 *
 * Sends movement intent at a fixed rate and applies server snapshots with
 * interpolation, so a 10 Hz snapshot stream still renders as smooth motion at
 * any frame rate. Reconnects with backoff; the game state comes from the
 * server on every reconnect, never from a local cache.
 */
import { MSG, PROTOCOL_VERSION } from '@schiffi/shared/net/protocol.js';

const INPUT_HZ = 20;
const PING_INTERVAL = 4000;
/** How far behind the latest snapshot we render, to have something to lerp to. */
const INTERPOLATION_DELAY_MS = 120;

export class GameSocket extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.characterId = null;
    this.connected = false;
    this.closing = false;

    this.seq = 0;
    this.input = { x: 0, y: 0 };
    this.lastSentInput = { x: 0, y: 0, at: 0 };

    this.ping = 0;
    this.wsLatency = 0;
    this.snapshotsPerSecond = 0;
    this.bytesIn = 0;

    // Entity interpolation buffers: netId -> [{t, x, y, h}, …]
    this.entities = new Map();
    this.self = null;
    this.selfBuffer = [];
    this.storms = [];
    this.wind = { a: 0, s: 0 };
    this.light = 1;
    this.serverTimeOffset = 0;

    this._reconnectAttempt = 0;
    this._snapshotCount = 0;
    this._snapshotWindow = performance.now();
  }

  connect(characterId) {
    this.characterId = characterId;
    this.closing = false;
    this.open();
  }

  open() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/ws`);
    this.ws.binaryType = 'arraybuffer';

    this.ws.addEventListener('open', () => {
      this._reconnectAttempt = 0;
      this.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, characterId: this.characterId });
    });

    this.ws.addEventListener('message', (event) => {
      this.bytesIn += typeof event.data === 'string' ? event.data.length : event.data.byteLength;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      this.handle(message);
    });

    this.ws.addEventListener('close', (event) => {
      this.connected = false;
      this.stopTimers();
      this.dispatchEvent(new CustomEvent('disconnected', { detail: { code: event.code, reason: event.reason } }));
      if (!this.closing && event.code !== 4004 && event.code !== 4003) this.scheduleReconnect();
    });

    this.ws.addEventListener('error', () => { /* close follows */ });
  }

  scheduleReconnect() {
    // Exponential backoff with jitter, capped: a server restart should not be
    // met with a thundering herd.
    const attempt = Math.min(6, ++this._reconnectAttempt);
    const delay = Math.min(15_000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
    this.dispatchEvent(new CustomEvent('reconnecting', { detail: { inMs: Math.round(delay), attempt } }));
    this._reconnectTimer = setTimeout(() => this.open(), delay);
  }

  handle(message) {
    switch (message.t) {
      case MSG.WELCOME:
        this.connected = true;
        this.serverTimeOffset = 0;
        this.startTimers();
        this.dispatchEvent(new CustomEvent('welcome', { detail: message }));
        break;

      case MSG.SNAPSHOT:
        this.applySnapshot(message);
        break;

      case MSG.PONG: {
        this.ping = Math.round(performance.now() - message.c);
        this.wsLatency = this.ping;
        break;
      }

      case MSG.CHAT:
        this.dispatchEvent(new CustomEvent('chat', { detail: message }));
        break;

      case MSG.EVENT:
        this.dispatchEvent(new CustomEvent('game-event', { detail: message }));
        break;

      case MSG.RESULT: {
        const pending = this._pending?.get(message.rid);
        if (pending) {
          this._pending.delete(message.rid);
          if (message.error) pending.reject(Object.assign(new Error(message.message ?? message.error), { code: message.error }));
          else pending.resolve(message.result);
        }
        this.dispatchEvent(new CustomEvent('result', { detail: message }));
        break;
      }

      case MSG.ERROR:
        this.dispatchEvent(new CustomEvent('server-error', { detail: message }));
        break;

      case MSG.KICK:
        this.closing = true;
        this.dispatchEvent(new CustomEvent('kicked', { detail: message }));
        break;

      default:
        break;
    }
  }

  applySnapshot(snapshot) {
    const now = performance.now();
    this._snapshotCount++;
    if (now - this._snapshotWindow >= 1000) {
      this.snapshotsPerSecond = this._snapshotCount;
      this._snapshotCount = 0;
      this._snapshotWindow = now;
    }

    this.self = snapshot.self;
    this.selfBuffer.push({ t: now, x: snapshot.self.x, y: snapshot.self.y, h: snapshot.self.h });
    if (this.selfBuffer.length > 8) this.selfBuffer.shift();

    this.wind = snapshot.wind;
    this.light = snapshot.light;
    this.storms = snapshot.storms ?? [];
    this.tick = snapshot.tick;
    this.gameTimeMs = snapshot.time;

    const seen = new Set();
    for (const entity of snapshot.e ?? []) {
      seen.add(entity.id);
      let buffer = this.entities.get(entity.id);
      if (!buffer) {
        buffer = { id: entity.id, kind: entity.k, name: entity.n, faction: entity.f, samples: [] };
        this.entities.set(entity.id, buffer);
      }
      buffer.name = entity.n;
      buffer.hp = entity.hp;
      buffer.speed = entity.v;
      buffer.samples.push({ t: now, x: entity.x, y: entity.y, h: entity.h });
      if (buffer.samples.length > 6) buffer.samples.shift();
      buffer.lastSeen = now;
    }
    // Entities that dropped out of view are kept briefly, then forgotten.
    for (const [id, buffer] of this.entities) {
      if (!seen.has(id) && now - buffer.lastSeen > 2000) this.entities.delete(id);
    }

    this.dispatchEvent(new CustomEvent('snapshot', { detail: snapshot }));
  }

  /**
   * Interpolated position for rendering.
   *
   * Rendering INTERPOLATION_DELAY_MS in the past means there are almost always
   * two samples to blend between, which is what turns 10 snapshots per second
   * into smooth motion.
   */
  interpolate(samples, now = performance.now()) {
    if (!samples || samples.length === 0) return null;
    if (samples.length === 1) return samples[0];
    const target = now - INTERPOLATION_DELAY_MS;

    for (let i = samples.length - 1; i > 0; i--) {
      const b = samples[i];
      const a = samples[i - 1];
      if (a.t <= target && target <= b.t) {
        const span = b.t - a.t;
        const alpha = span > 0 ? (target - a.t) / span : 1;
        return {
          x: a.x + (b.x - a.x) * alpha,
          y: a.y + (b.y - a.y) * alpha,
          h: lerpAngle(a.h, b.h, alpha),
        };
      }
    }
    // Behind the buffer: extrapolate briefly from the last two samples.
    const last = samples[samples.length - 1];
    const previous = samples[samples.length - 2];
    const ahead = Math.min(200, target - last.t);
    if (ahead <= 0) return last;
    const span = Math.max(1, last.t - previous.t);
    return {
      x: last.x + ((last.x - previous.x) / span) * ahead,
      y: last.y + ((last.y - previous.y) / span) * ahead,
      h: last.h,
    };
  }

  selfPosition() {
    return this.interpolate(this.selfBuffer) ?? (this.self ? { x: this.self.x, y: this.self.y, h: this.self.h } : null);
  }

  setInput(x, y) {
    this.input.x = x;
    this.input.y = y;
  }

  setViewport(w, h, zoom) {
    this.send({ t: MSG.SUBSCRIBE, viewport: { w, h, zoom } });
  }

  /** Fire an action and await its result. */
  action(name, payload = {}) {
    if (!this._pending) this._pending = new Map();
    const rid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    return new Promise((resolve, reject) => {
      this._pending.set(rid, { resolve, reject });
      this.send({ t: MSG.ACTION, rid, action: name, payload });
      setTimeout(() => {
        if (this._pending.has(rid)) {
          this._pending.delete(rid);
          reject(Object.assign(new Error('action timed out'), { code: 'error.network' }));
        }
      }, 12_000);
    });
  }

  chat(channel, body, extra = {}) {
    this.send({ t: MSG.CHAT_SEND, channel, body, ...extra });
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  startTimers() {
    this.stopTimers();
    this._inputTimer = setInterval(() => {
      const { x, y } = this.input;
      const changed = x !== this.lastSentInput.x || y !== this.lastSentInput.y;
      const stale = performance.now() - this.lastSentInput.at > 500;
      // Only send when something changed, plus a keep-alive: idle players cost
      // the server nothing.
      if (!changed && !stale) return;
      this.lastSentInput = { x, y, at: performance.now() };
      this.send({ t: MSG.INPUT, s: ++this.seq, x, y, d: 1 / INPUT_HZ });
    }, 1000 / INPUT_HZ);

    this._pingTimer = setInterval(() => {
      this.send({ t: MSG.PING, c: performance.now() });
    }, PING_INTERVAL);
  }

  stopTimers() {
    clearInterval(this._inputTimer);
    clearInterval(this._pingTimer);
    clearTimeout(this._reconnectTimer);
  }

  close() {
    this.closing = true;
    this.stopTimers();
    this.ws?.close(1000, 'client closed');
  }
}

function lerpAngle(a, b, t) {
  let delta = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

export const socket = new GameSocket();
