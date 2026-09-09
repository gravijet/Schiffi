/**
 * The world simulation.
 *
 * One fixed-rate loop per loaded world advances everything the server owns:
 * ship movement, wind and current, weather, day/night, cargo spoilage, crew
 * condition and NPC behaviour.  Clients send *intent* (a direction vector);
 * the server integrates it, so speed hacks and wall clipping are not a client
 * decision to make.
 *
 * The loop is deliberately split into rates:
 *   tick    (20 Hz)  movement and collision
 *   snapshot(10 Hz)  network updates, viewport-culled
 *   slow    (1 Hz)   weather, fog, morale, NPC decisions
 *   hourly           markets, spoilage, price history, persistence
 */
import { Noise2D } from '@schiffi/shared/util/noise.js';
import { Rng, hashCombine } from '@schiffi/shared/util/rng.js';
import { clamp, clamp01, normalize, TAU, angleDelta, dist } from '@schiffi/shared/util/math.js';
import { CELL_SIZE, CELLS_X, CELLS_Y, NAVIGABLE, T, GRID_CELL } from '@schiffi/shared/world/constants.js';
import { HAZARD } from '@schiffi/shared/world/regions.js';
import { goodById } from '@schiffi/shared/data/goods.js';
import { DISEASES, dailyProvisions } from '@schiffi/shared/data/crew.js';
import { getDatabase } from '../db/index.js';
import config from '../config.js';
import { stepMarkets, recordPriceHistory } from './economy.js';
import { revealFog, saveFog, loadFog } from './characters.js';
import { persistWorldTick } from './worldManager.js';
import { spawnNpcs, stepNpcs, reapNpcs } from './npc.js';
import { sweepAuctions, stepRoutes } from './market.js';
import { stepWeather } from './weather.js';

/** One real second is one game minute: a full day passes in 24 real minutes. */
export const GAME_TIME_SCALE = 60;
export const GAME_DAY_MS = 24 * 3_600_000;
export const GAME_SEASON_DAYS = 7;

export class Simulation {
  constructor(instance, { broadcast } = {}) {
    this.instance = instance;
    this.broadcast = broadcast ?? (() => {});
    this.tickMs = 1000 / config.game.tickHz;
    this.snapshotMs = 1000 / config.game.snapshotHz;
    this.running = false;

    this.accumulator = 0;
    this.lastTime = 0;
    this.sinceSnapshot = 0;
    this.sinceSlow = 0;
    this.gameHour = Math.floor(instance.gameTimeMs / 3_600_000);

    this.windNoise = new Noise2D(hashCombine(instance.seed, 0x717d));
    this.currentNoise = new Noise2D(hashCombine(instance.seed, 0xc077));
    this.rng = new Rng(hashCombine(instance.seed, 0x5100));

    // Broad-phase grid, rebuilt each snapshot for interest management.
    this.grid = new Map();
    this.metrics = { tps: 0, tickMs: 0, entities: 0, lastReport: Date.now(), ticks: 0 };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    spawnNpcs(this.instance);
    const loop = () => {
      if (!this.running) return;
      const now = performance.now();
      let delta = now - this.lastTime;
      this.lastTime = now;
      // A long stall (GC, a suspended laptop) must not fast-forward the world.
      if (delta > 250) delta = 250;

      this.accumulator += delta;
      const started = performance.now();
      let steps = 0;
      while (this.accumulator >= this.tickMs && steps < 6) {
        this.step(this.tickMs / 1000);
        this.accumulator -= this.tickMs;
        steps++;
      }
      this.metrics.tickMs = performance.now() - started;
      this.metrics.ticks += steps;

      this.sinceSnapshot += delta;
      if (this.sinceSnapshot >= this.snapshotMs) {
        this.sinceSnapshot = 0;
        this.emitSnapshots();
      }
      this.sinceSlow += delta;
      if (this.sinceSlow >= 1000) {
        this.slowStep(this.sinceSlow / 1000).catch((e) => console.error('[sim] slow step', e));
        this.sinceSlow = 0;
      }

      if (Date.now() - this.metrics.lastReport > 10_000) {
        this.metrics.tps = this.metrics.ticks / 10;
        this.metrics.ticks = 0;
        this.metrics.lastReport = Date.now();
      }
      this.timer = setTimeout(loop, Math.max(1, this.tickMs - (performance.now() - now)));
      this.timer.unref();
    };
    loop();
    console.log(`[sim] world ${this.instance.id} running at ${config.game.tickHz} Hz`);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  // --- fixed step ---------------------------------------------------------

  step(dt) {
    const instance = this.instance;
    instance.tick++;
    instance.gameTimeMs += dt * 1000 * GAME_TIME_SCALE;

    for (const player of instance.players.values()) {
      if (player.docked) continue;
      this.moveShip(player, dt);
    }
    stepNpcs(instance, dt, this);
  }

  /**
   * Integrate one ship.
   *
   * Input is a direction vector the client sends; it is re-normalised here so
   * a client cannot claim a length of 5.  Wind and current are added as world
   * forces, and land is a hard stop resolved per axis so a ship slides along a
   * coastline instead of sticking to it.
   */
  moveShip(entity, dt) {
    const stats = entity.stats;
    if (!stats) return;

    let [ix, iy] = normalize(entity.input?.x ?? 0, entity.input?.y ?? 0);

    // Crew shortage and damaged sails cost speed.
    const sailFactor = clamp01(entity.sail / Math.max(1, stats.sail)) * 0.6 + 0.4;
    const crewFactor = entity.crewFactor ?? 1;
    const loadFactor = 1 - clamp01((entity.cargoWeight ?? 0) / (stats.cargo * 260)) * 0.28;
    const maxSpeed = stats.speed * sailFactor * crewFactor * loadFactor;

    const wind = this.windAt(entity.x, entity.y);
    const current = this.currentAt(entity.x, entity.y);

    // A tailwind helps, a headwind hurts, and a beam wind pushes you sideways.
    const alignment = ix * wind.x + iy * wind.y;
    const windSpeed = wind.strength * (0.35 + 0.65 * stats.sail / 150);
    const targetVx = ix * maxSpeed * (1 + alignment * 0.28) + wind.x * windSpeed * 0.25 + current.x * current.strength;
    const targetVy = iy * maxSpeed * (1 + alignment * 0.28) + wind.y * windSpeed * 0.25 + current.y * current.strength;

    // Storms shove the ship around and cut control.
    if (entity.inStorm) {
      const gust = this.rng.range(-1, 1);
      entity.vx += gust * 12 * dt;
      entity.vy += this.rng.range(-1, 1) * 12 * dt;
    }

    const accel = stats.accel * (entity.inStorm ? 0.6 : 1);
    entity.vx += (targetVx - entity.vx) * clamp01(accel * dt / Math.max(1, maxSpeed) * 4);
    entity.vy += (targetVy - entity.vy) * clamp01(accel * dt / Math.max(1, maxSpeed) * 4);

    // Drag keeps the ship from accelerating without bound.
    const speed = Math.hypot(entity.vx, entity.vy);
    const cap = maxSpeed * 1.6;
    if (speed > cap) {
      entity.vx *= cap / speed;
      entity.vy *= cap / speed;
    }

    if (ix !== 0 || iy !== 0) {
      const desired = Math.atan2(iy, ix);
      const turn = stats.turn * dt * (entity.inStorm ? 0.55 : 1);
      entity.heading += clamp(angleDelta(entity.heading, desired), -turn, turn);
      entity.heading = (entity.heading + TAU) % TAU;
    }

    // Per-axis resolution: blocked north still lets you slide east.
    const nextX = entity.x + entity.vx * dt;
    const nextY = entity.y + entity.vy * dt;
    if (this.isWater(nextX, entity.y)) entity.x = nextX; else entity.vx = 0;
    if (this.isWater(entity.x, nextY)) entity.y = nextY; else entity.vy = 0;

    entity.x = clamp(entity.x, CELL_SIZE, CELLS_X * CELL_SIZE - CELL_SIZE);
    entity.y = clamp(entity.y, CELL_SIZE, CELLS_Y * CELL_SIZE - CELL_SIZE);
    entity.speed = Math.hypot(entity.vx, entity.vy);
    entity.distance = (entity.distance ?? 0) + entity.speed * dt;

    // Reefs grind the hull.
    if (this.terrainAt(entity.x, entity.y) === T.REEF) {
      entity.hull = Math.max(0, entity.hull - 4 * dt * (entity.speed / Math.max(1, stats.speed)));
      entity.reefWarning = true;
    } else {
      entity.reefWarning = false;
    }
  }

  terrainAt(x, y) {
    const cx = Math.floor(x / CELL_SIZE);
    const cy = Math.floor(y / CELL_SIZE);
    if (cx < 0 || cy < 0 || cx >= CELLS_X || cy >= CELLS_Y) return T.DEEP_OCEAN;
    return this.instance.world.terrain[cy * CELLS_X + cx];
  }

  isWater(x, y) {
    return NAVIGABLE[this.terrainAt(x, y)] === 1;
  }

  /** Wind field: slow-moving noise, so weather has direction and persistence. */
  windAt(x, y) {
    const t = this.instance.gameTimeMs / 3_600_000 * 0.05;
    const angle = this.windNoise.fbm(x / 9000 + t, y / 9000, 3) * Math.PI * 2;
    const strength = 6 + (this.windNoise.fbm(x / 5000 + 40, y / 5000 - t, 2) * 0.5 + 0.5) * 22;
    return { x: Math.cos(angle), y: Math.sin(angle), strength, angle };
  }

  /** Ocean currents: slower, larger scale and effectively static. */
  currentAt(x, y) {
    const angle = this.currentNoise.fbm(x / 16000, y / 16000, 2) * Math.PI * 2;
    const strength = (this.currentNoise.fbm(x / 12000 + 9, y / 12000, 2) * 0.5 + 0.5) * 7;
    return { x: Math.cos(angle), y: Math.sin(angle), strength };
  }

  /** Fraction of the game day, 0 = midnight. */
  get dayFraction() {
    return (this.instance.gameTimeMs % GAME_DAY_MS) / GAME_DAY_MS;
  }

  get season() {
    return Math.floor(this.instance.gameTimeMs / GAME_DAY_MS / GAME_SEASON_DAYS) % 4;
  }

  /** 0 at midnight, 1 at noon - drives visibility and NPC behaviour. */
  get daylight() {
    return clamp01(Math.sin((this.dayFraction - 0.25) * TAU) * 0.5 + 0.5);
  }

  // --- one hertz ----------------------------------------------------------

  async slowStep(dt) {
    const instance = this.instance;
    instance.season = this.season;
    stepWeather(instance, this, dt);

    for (const player of instance.players.values()) {
      if (player.docked) continue;
      // Sight radius shrinks at night and in fog.
      const sight = (player.stats?.range ?? 1200) * 0.22 * (0.55 + 0.45 * this.daylight);
      if (player.fog) {
        const revealed = revealFog(player.fog, player.x, player.y, sight);
        if (revealed > 0) player.fogDirty = true;
      }
      player.inStorm = instance.storms.some((s) => dist(s.x, s.y, player.x, player.y) < s.radius);
    }

    // Player-driven systems that must keep running with nobody watching.
    this.sinceMarketSweep = (this.sinceMarketSweep ?? 0) + dt;
    if (this.sinceMarketSweep >= 20) {
      this.sinceMarketSweep = 0;
      await sweepAuctions(instance).catch((e) => console.error('[sim] auctions', e.message));
      await stepRoutes(instance).catch((e) => console.error('[sim] routes', e.message));
      reapNpcs(instance);
    }

    const hour = Math.floor(instance.gameTimeMs / 3_600_000);
    if (hour > this.gameHour) {
      const hours = Math.min(6, hour - this.gameHour);
      this.gameHour = hour;
      await this.hourlyStep(hours).catch((e) => console.error('[sim] hourly', e));
    }
  }

  // --- one game hour ------------------------------------------------------

  async hourlyStep(hours) {
    const instance = this.instance;
    await stepMarkets(instance, hours);
    await this.spoilCargo(hours);
    await this.crewUpkeep(hours);
    await persistWorldTick(instance);
    await this.persistPlayers();

    if (this.gameHour % 6 === 0) await recordPriceHistory(instance);
    this.broadcast({ t: 'event', kind: 'time', gameTimeMs: instance.gameTimeMs, season: instance.season });
  }

  /**
   * Spoilage.
   *
   * Perishable cargo loses freshness; when a lot rots through, the units are
   * destroyed outright and the player is told exactly what and how much - no
   * refund, as designed.  Cooling and a watertight hold slow this down.
   */
  async spoilCargo(hours) {
    const db = getDatabase();
    const losses = new Map();

    for (const player of this.instance.players.values()) {
      if (!player.shipId) continue;
      const lots = await db.all('SELECT * FROM cargo WHERE ship_id = ?', [player.shipId]);
      if (lots.length === 0) continue;

      const stats = player.stats ?? {};
      const protection = clamp01((stats.cargoProtect ?? 0) + (stats.cooling ?? 0) * 0.06);
      const stormPenalty = player.inStorm ? 1.8 : 1;

      for (const lot of lots) {
        const good = goodById(Number(lot.good_id));
        if (!good || good.perish === 0) continue;
        // Fast-perishing goods lose ~6 % of freshness per game hour unprotected.
        const rate = [0, 0.012, 0.032, 0.06][good.perish] * (1 - protection * 0.75) * stormPenalty;
        const freshness = Number(lot.freshness) - rate * hours;

        if (freshness > 0.05) {
          await db.run('UPDATE cargo SET freshness = ? WHERE id = ?', [freshness, lot.id]);
          continue;
        }
        // Rotten through: the whole lot is gone.
        const qty = Number(lot.qty);
        await db.run('DELETE FROM cargo WHERE id = ?', [lot.id]);
        await db.run(
          'UPDATE player_stats SET cargo_lost = cargo_lost + ?, updated_at = ? WHERE character_id = ?',
          [qty, Date.now(), player.characterId]);

        const list = losses.get(player.characterId) ?? [];
        list.push({
          goodId: good.id, key: good.key, qty,
          reason: good.cat === 'grain' || good.cat === 'produce' ? 'mouldy' : 'spoiled',
        });
        losses.set(player.characterId, list);
      }
    }

    for (const [characterId, list] of losses) {
      const player = [...this.instance.players.values()].find((p) => p.characterId === characterId);
      if (player?.send) player.send({ t: 'event', kind: 'cargoLoss', losses: list });
    }
  }

  /**
   * Crew upkeep: provisions are consumed, morale drifts, disease can break out
   * and a sick untreated crew loses health.
   */
  async crewUpkeep(hours) {
    const db = getDatabase();
    for (const player of this.instance.players.values()) {
      if (!player.shipId) continue;
      const crew = await db.all('SELECT * FROM crew_members WHERE ship_id = ?', [player.shipId]);
      if (crew.length === 0) continue;

      const hasDoctor = crew.some((c) => c.role === 'doctor');
      const hasCook = crew.some((c) => c.role === 'cook');
      const provisions = dailyProvisions(crew.length, hasCook ? 1.2 : 1);
      const fed = await this.consumeProvisions(player.shipId, provisions, hours / 24);

      for (const member of crew) {
        let morale = Number(member.morale);
        let health = Number(member.health);
        let disease = member.disease;

        morale += fed ? 0.4 * hours : -1.6 * hours;
        if (player.docked) morale += 0.6 * hours;
        if (player.inStorm) morale -= 0.9 * hours;

        // Long voyages wear people down.
        if (!player.docked) morale -= 0.15 * hours;

        if (!disease) {
          const risk = (fed ? 0.0012 : 0.006) * hours * (player.inStorm ? 2 : 1);
          if (Math.random() < risk) {
            disease = DISEASES[Math.floor(Math.random() * DISEASES.length)].key;
            morale -= 10;
            if (player.send) {
              player.send({ t: 'event', kind: 'disease', crewName: member.name, disease });
            }
          }
        } else {
          const entry = DISEASES.find((d) => d.key === disease);
          const recovery = hasDoctor ? 0.35 : 0.08;
          health -= (entry?.severity ?? 1) * (hasDoctor ? 0.3 : 0.9) * hours;
          if (Math.random() < recovery * hours / 12) disease = null;
        }
        if (!disease) health = Math.min(100, health + 0.5 * hours);

        morale = clamp(morale, 0, 100);
        health = clamp(health, 0, 100);

        if (health <= 0) {
          await db.run('DELETE FROM crew_members WHERE id = ?', [member.id]);
          if (player.send) player.send({ t: 'event', kind: 'crewDied', crewName: member.name });
          continue;
        }
        await db.run('UPDATE crew_members SET morale = ?, health = ?, disease = ? WHERE id = ?',
          [Math.round(morale), Math.round(health), disease, member.id]);
      }
    }
  }

  /** Eat and drink from the hold. Returns false when the crew went hungry. */
  async consumeProvisions(shipId, need, dayFraction) {
    const db = getDatabase();
    const foodKeys = ['hardtack', 'salted_meat', 'saltfish', 'cheese', 'potatoes', 'rice', 'flour'];
    const waterKeys = ['water_casks', 'beer', 'cider'];
    const wanted = {
      food: Math.max(0, need.food * dayFraction),
      water: Math.max(0, need.water * dayFraction),
    };

    let satisfied = true;
    for (const [kind, keys] of [['food', foodKeys], ['water', waterKeys]]) {
      let remaining = wanted[kind];
      if (remaining <= 0) continue;
      const lots = await db.all('SELECT * FROM cargo WHERE ship_id = ?', [shipId]);
      for (const lot of lots) {
        if (remaining <= 0) break;
        const good = goodById(Number(lot.good_id));
        if (!good || !keys.includes(good.baseKey)) continue;
        const take = Math.min(remaining, Number(lot.qty));
        const left = Number(lot.qty) - take;
        if (left <= 0) await db.run('DELETE FROM cargo WHERE id = ?', [lot.id]);
        else await db.run('UPDATE cargo SET qty = ? WHERE id = ?', [left, lot.id]);
        remaining -= take;
      }
      if (remaining > 0.5) satisfied = false;
    }
    return satisfied;
  }

  // --- persistence --------------------------------------------------------

  async persistPlayers() {
    const db = getDatabase();
    for (const player of this.instance.players.values()) {
      try {
        await db.run(
          'UPDATE characters SET x = ?, y = ?, heading = ?, docked = ?, last_seen_at = ?, ' +
          'playtime_ms = playtime_ms + ? WHERE id = ?',
          [Number(player.x) || 0, Number(player.y) || 0, Number(player.heading) || 0,
            player.docked ? 1 : 0, Date.now(),
            Date.now() - (player.lastPersist ?? Date.now()), player.characterId]);
        player.lastPersist = Date.now();

        if (player.shipId) {
          await db.run('UPDATE ships SET hull = ?, sail = ? WHERE id = ?',
            [Number(player.hull) || 0, Number(player.sail) || 0, player.shipId]);
        }
        if (player.fogDirty && player.fog) {
          await saveFog(player.characterId, player.fog);
          player.fogDirty = false;
        }
        if (player.distance) {
          await db.run(
            'UPDATE player_stats SET distance = distance + ?, updated_at = ? WHERE character_id = ?',
            [player.distance, Date.now(), player.characterId]);
          player.distance = 0;
        }
      } catch (error) {
        console.error('[sim] persist failed for character', player.characterId, error.message);
      }
    }
  }

  // --- networking ---------------------------------------------------------

  /** Rebuild the broad-phase grid used for interest management. */
  rebuildGrid() {
    this.grid.clear();
    const put = (entity) => {
      const key = `${Math.floor(entity.x / GRID_CELL)},${Math.floor(entity.y / GRID_CELL)}`;
      let bucket = this.grid.get(key);
      if (!bucket) { bucket = []; this.grid.set(key, bucket); }
      bucket.push(entity);
    };
    for (const p of this.instance.players.values()) if (!p.docked) put(p);
    for (const n of this.instance.npcs.values()) put(n);
    this.metrics.entities = this.instance.players.size + this.instance.npcs.size;
  }

  /** Entities within a rectangle, using the grid rather than a full scan. */
  queryArea(x, y, halfW, halfH) {
    const out = [];
    const x0 = Math.floor((x - halfW) / GRID_CELL);
    const x1 = Math.floor((x + halfW) / GRID_CELL);
    const y0 = Math.floor((y - halfH) / GRID_CELL);
    const y1 = Math.floor((y + halfH) / GRID_CELL);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const bucket = this.grid.get(`${gx},${gy}`);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }

  emitSnapshots() {
    this.rebuildGrid();
    const instance = this.instance;

    for (const player of instance.players.values()) {
      if (!player.send) continue;
      const view = player.viewport ?? { w: 1920, h: 1080, zoom: 1 };
      // A margin beyond the viewport keeps entities from popping in at the edge.
      const halfW = (view.w / 2) / Math.max(0.15, view.zoom) + 400;
      const halfH = (view.h / 2) / Math.max(0.15, view.zoom) + 400;

      const nearby = this.queryArea(player.x, player.y, halfW, halfH);
      const entities = [];
      for (const entity of nearby) {
        if (entity === player) continue;
        entities.push(packEntity(entity));
      }

      const storms = instance.storms
        .filter((s) => Math.abs(s.x - player.x) < halfW + s.radius && Math.abs(s.y - player.y) < halfH + s.radius)
        .map((s) => ({ id: s.id, x: Math.round(s.x), y: Math.round(s.y), r: Math.round(s.radius),
          i: Math.round(s.intensity * 100) / 100, k: s.kind }));

      const wind = this.windAt(player.x, player.y);
      player.send({
        t: 'snapshot',
        tick: instance.tick,
        time: instance.gameTimeMs,
        self: {
          x: Math.round(player.x * 10) / 10,
          y: Math.round(player.y * 10) / 10,
          h: Math.round(player.heading * 1000) / 1000,
          v: Math.round(player.speed * 10) / 10,
          hull: Math.round(player.hull),
          sail: Math.round(player.sail),
          storm: player.inStorm ? 1 : 0,
          reef: player.reefWarning ? 1 : 0,
          docked: player.docked ? 1 : 0,
          ack: player.lastInputSeq ?? 0,
        },
        wind: { a: Math.round(wind.angle * 100) / 100, s: Math.round(wind.strength) },
        light: Math.round(this.daylight * 100) / 100,
        e: entities,
        storms,
      });
    }
  }
}

function packEntity(entity) {
  return {
    id: entity.netId,
    k: entity.kind,
    x: Math.round(entity.x),
    y: Math.round(entity.y),
    h: Math.round(entity.heading * 100) / 100,
    v: Math.round(entity.speed ?? 0),
    n: entity.displayName,
    f: entity.faction ?? null,
    hp: entity.hull !== undefined ? Math.round(clamp01(entity.hull / Math.max(1, entity.maxHull ?? 1)) * 100) : null,
  };
}
