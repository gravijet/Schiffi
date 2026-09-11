/**
 * WebSocket gateway.
 *
 * One connection per playing character.  The server is authoritative: the
 * client may send movement intent, chat and *action requests*, and receives
 * snapshots, events and action results.  Nothing the client sends is trusted
 * as a value - only as a request.
 */
import { WebSocketServer } from 'ws';
import { MSG, PROTOCOL_VERSION, ACTION_SET } from '@schiffi/shared/net/protocol.js';
import { resolveSession } from '../services/auth.js';
import { getDatabase } from '../db/index.js';
import { loadWorld, getLoadedWorld } from './../game/worldManager.js';
import { loadCharacter, loadFog, saveFog, describeCrew, cargoUsage } from '../game/characters.js';
import { effectiveStats } from '@schiffi/shared/data/ships.js';
import { aggregateCrewBonus, requiredCrew } from '@schiffi/shared/data/crew.js';
import { parseCookies } from '../http/server.js';
import { dispatchAction } from './actions.js';
import { handleChat, joinChannels, leaveChannels } from './chat.js';
import config from '../config.js';

/** Client message budget: generous for movement, tight for everything else. */
const RATE_LIMITS = {
  [MSG.INPUT]: { perSecond: 40, burst: 60 },
  [MSG.PING]: { perSecond: 4, burst: 8 },
  [MSG.ACTION]: { perSecond: 8, burst: 16 },
  [MSG.CHAT_SEND]: { perSecond: 2, burst: 5 },
  [MSG.SUBSCRIBE]: { perSecond: 4, burst: 8 },
};

const MAX_MESSAGE_BYTES = 8 * 1024;

export class Gateway {
  constructor({ simulations }) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    this.simulations = simulations;         // worldId -> Simulation
    this.connections = new Set();
    this.heartbeat = setInterval(() => this.pingAll(), 30_000);
    this.heartbeat.unref();
  }

  attach(httpServer) {
    httpServer.onUpgrade((req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });
  }

  close() {
    clearInterval(this.heartbeat);
    for (const conn of this.connections) conn.ws.close(1001, 'server shutting down');
    this.wss.close();
  }

  pingAll() {
    const now = Date.now();
    for (const conn of this.connections) {
      if (now - conn.lastSeen > 90_000) { conn.ws.terminate(); continue; }
      try { conn.ws.ping(); } catch { /* already closing */ }
    }
  }

  async onConnection(ws, req) {
    const conn = {
      ws,
      req,
      user: null,
      player: null,
      instance: null,
      lastSeen: Date.now(),
      buckets: new Map(),
      send: (message) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(message));
        }
      },
    };
    this.connections.add(conn);

    ws.on('pong', () => { conn.lastSeen = Date.now(); });
    ws.on('message', (data) => {
      conn.lastSeen = Date.now();
      this.onMessage(conn, data).catch((error) => {
        conn.send({ t: MSG.ERROR, code: error.code ?? 'error.generic', message: error.message });
      });
    });
    ws.on('close', () => this.onClose(conn));
    ws.on('error', () => this.onClose(conn));

    // The client must say hello within ten seconds or the socket is dropped.
    conn.helloTimer = setTimeout(() => {
      if (!conn.player) ws.close(4001, 'no hello');
    }, 10_000);
  }

  async onMessage(conn, data) {
    let message;
    try {
      message = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      throw Object.assign(new Error('bad json'), { code: 'error.validation' });
    }
    if (!message || typeof message.t !== 'string') {
      throw Object.assign(new Error('bad message'), { code: 'error.validation' });
    }
    if (!this.allow(conn, message.t)) {
      conn.send({ t: MSG.ERROR, code: 'error.rateLimited' });
      return;
    }

    if (message.t === MSG.HELLO) return this.onHello(conn, message);
    if (!conn.player) throw Object.assign(new Error('not joined'), { code: 'error.unauthorized' });

    switch (message.t) {
      case MSG.PING:
        return conn.send({ t: MSG.PONG, c: message.c, s: Date.now() });
      case MSG.INPUT:
        return this.onInput(conn, message);
      case MSG.SUBSCRIBE:
        return this.onSubscribe(conn, message);
      case MSG.CHAT_SEND:
        return handleChat(this, conn, message);
      case MSG.ACTION:
        return this.onAction(conn, message);
      default:
        throw Object.assign(new Error(`unknown message ${message.t}`), { code: 'error.validation' });
    }
  }

  /** Token bucket per message type. */
  allow(conn, type) {
    const limit = RATE_LIMITS[type];
    if (!limit) return true;
    const now = Date.now();
    let bucket = conn.buckets.get(type);
    if (!bucket) {
      bucket = { tokens: limit.burst, last: now };
      conn.buckets.set(type, bucket);
    }
    bucket.tokens = Math.min(limit.burst, bucket.tokens + ((now - bucket.last) / 1000) * limit.perSecond);
    bucket.last = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  async onHello(conn, message) {
    clearTimeout(conn.helloTimer);
    if (message.v !== PROTOCOL_VERSION) {
      conn.ws.close(4002, `protocol ${PROTOCOL_VERSION} required`);
      return;
    }

    const cookies = parseCookies(conn.req.headers.cookie);
    const token = message.token || cookies.sid;
    const session = token ? await resolveSession(token) : null;
    if (!session) { conn.ws.close(4003, 'unauthorized'); return; }
    conn.user = session.user;

    const characterId = message.characterId;
    const character = await loadCharacter(characterId);
    const db = getDatabase();
    const owner = await db.get('SELECT user_id FROM characters WHERE id = ?', [characterId]);
    if (!owner || String(owner.user_id) !== String(session.user.id)) {
      conn.ws.close(4004, 'not your character');
      return;
    }

    const instance = getLoadedWorld(character.worldId) ?? await loadWorld(character.worldId);
    if (instance.players.size >= instance.maxPlayers) {
      conn.ws.close(4005, 'world full');
      return;
    }

    // One session per character: a second connection displaces the first, so a
    // character can never be steered from two places at once.
    for (const other of this.connections) {
      if (other !== conn && other.player?.characterId === String(characterId)) {
        other.send({ t: MSG.KICK, reason: 'replaced' });
        other.ws.close(4006, 'replaced by a newer session');
      }
    }

    const crew = character.crew ?? [];
    const stats = character.ship
      ? effectiveStats(character.ship.classKey, character.ship.upgrades, aggregateCrewBonus(crew))
      : null;
    const { weight } = character.ship ? await cargoUsage(character.ship.id) : { weight: 0 };

    const player = {
      netId: `p${characterId}`,
      kind: 1,
      characterId: String(characterId),
      userId: String(session.user.id),
      displayName: character.name,
      x: character.x,
      y: character.y,
      heading: character.heading,
      vx: 0, vy: 0, speed: 0,
      hull: character.ship?.hull ?? 0,
      sail: character.ship?.sail ?? 0,
      maxHull: stats?.hull ?? 1,
      shipId: character.ship?.id ?? null,
      stats,
      cargoWeight: weight,
      crewFactor: crewFactorFor(crew, stats),
      combatBonus: aggregateCrewBonus(crew).combat ?? 1,
      cannons: character.ship?.cannons ?? 0,
      ammunition: character.ship?.ammunition ?? 0,
      reloadedAt: 0,
      docked: character.docked,
      protected: character.protectionUntil ? character.protectionUntil > Date.now() : false,
      input: { x: 0, y: 0 },
      lastInputSeq: 0,
      viewport: { w: 1600, h: 900, zoom: 1 },
      fog: await loadFog(characterId),
      fogDirty: false,
      lastPersist: Date.now(),
      distance: 0,
      send: conn.send,
      conn,
    };

    conn.player = player;
    conn.instance = instance;
    instance.players.set(player.netId, player);
    joinChannels(this, conn);

    const simulation = this.simulations.get(String(instance.id));
    conn.send({
      t: MSG.WELCOME,
      v: PROTOCOL_VERSION,
      worldId: instance.id,
      worldName: instance.name,
      seed: instance.seed,
      tickHz: config.game.tickHz,
      snapshotHz: config.game.snapshotHz,
      gameTimeMs: instance.gameTimeMs,
      season: instance.season ?? 0,
      character,
      fog: Buffer.from(player.fog.bits).toString('base64'),
      online: instance.players.size,
      metrics: simulation ? { tps: simulation.metrics.tps } : null,
    });

    this.broadcastToWorld(instance, {
      t: MSG.EVENT, kind: 'playerJoined', name: character.name, online: instance.players.size,
    }, conn);
  }

  onInput(conn, message) {
    const player = conn.player;
    const seq = Number(message.s) || 0;
    // Out-of-order UDP-style reordering does not exist on a WebSocket, but a
    // replayed frame does: ignore anything not newer than the last accepted.
    if (seq <= player.lastInputSeq) return;
    player.lastInputSeq = seq;

    const x = Number(message.x);
    const y = Number(message.y);
    player.input.x = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
    player.input.y = Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0;
  }

  onSubscribe(conn, message) {
    const view = message.viewport;
    if (view && Number.isFinite(view.w) && Number.isFinite(view.h)) {
      conn.player.viewport = {
        // Clamp so a client cannot subscribe to the whole map at once.
        w: Math.min(4096, Math.max(320, view.w)),
        h: Math.min(4096, Math.max(240, view.h)),
        zoom: Math.min(4, Math.max(0.15, Number(view.zoom) || 1)),
      };
    }
  }

  async onAction(conn, message) {
    const name = message.action;
    if (!ACTION_SET.has(name)) {
      return conn.send({ t: MSG.RESULT, rid: message.rid, error: 'error.validation', message: 'unknown action' });
    }
    try {
      const result = await dispatchAction(this, conn, name, message.payload ?? {});
      conn.send({ t: MSG.RESULT, rid: message.rid, action: name, result });
    } catch (error) {
      conn.send({
        t: MSG.RESULT, rid: message.rid, action: name,
        error: error.code ?? 'error.generic',
        message: error.message,
        // Structured details let the UI act on the failure rather than only
        // print it - a cooldown, for instance, becomes a live countdown.
        details: error.details ?? undefined,
      });
    }
  }

  async onClose(conn) {
    if (!this.connections.has(conn)) return;
    this.connections.delete(conn);
    clearTimeout(conn.helloTimer);
    leaveChannels(this, conn);

    const player = conn.player;
    const instance = conn.instance;
    if (!player || !instance) return;
    instance.players.delete(player.netId);

    // Flush the character's authoritative state on the way out.
    try {
      const db = getDatabase();
      await db.run(
        'UPDATE characters SET x = ?, y = ?, heading = ?, docked = ?, last_seen_at = ? WHERE id = ?',
        [Number(player.x) || 0, Number(player.y) || 0, Number(player.heading) || 0,
          player.docked ? 1 : 0, Date.now(), player.characterId]);
      if (player.shipId) {
        await db.run('UPDATE ships SET hull = ?, sail = ? WHERE id = ?',
          [Number(player.hull) || 0, Number(player.sail) || 0, player.shipId]);
      }
      // Distance is otherwise only flushed once per in-game hour
      // (simulation.js persistPlayers); without this, sailing distance
      // accrued since the last flush is lost on disconnect.
      if (player.distance) {
        await db.run(
          'UPDATE player_stats SET distance = distance + ?, updated_at = ? WHERE character_id = ?',
          [player.distance, Date.now(), player.characterId]);
        player.distance = 0;
      }
      if (player.fogDirty) await saveFog(player.characterId, player.fog);
    } catch (error) {
      console.error('[ws] failed to flush character on disconnect', error.message);
    }

    this.broadcastToWorld(instance, {
      t: MSG.EVENT, kind: 'playerLeft', name: player.displayName, online: instance.players.size,
    });
  }

  broadcastToWorld(instance, message, except = null) {
    for (const conn of this.connections) {
      if (conn === except) continue;
      if (conn.instance !== instance) continue;
      conn.send(message);
    }
  }

  connectionsForWorld(instance) {
    return [...this.connections].filter((c) => c.instance === instance);
  }

  get stats() {
    return {
      connections: this.connections.size,
      players: [...this.connections].filter((c) => c.player).length,
    };
  }
}

/** Under-crewed ships sail slower; a full, healthy crew gives a small bonus. */
function crewFactorFor(crew, stats) {
  if (!stats) return 1;
  const needed = requiredCrew(stats);
  if (crew.length === 0) return 0.35;
  const ratio = Math.min(1.2, crew.length / needed);
  const condition = crew.reduce((sum, c) => sum + (c.morale * 0.6 + c.health * 0.4) / 100, 0) / crew.length;
  return Math.max(0.35, Math.min(1.1, ratio * (0.7 + condition * 0.35)));
}

export { crewFactorFor };
