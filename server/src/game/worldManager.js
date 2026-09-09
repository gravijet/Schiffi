/**
 * World instances.
 *
 * A world is expensive to generate (~1-3 s) and identical for every player, so
 * it is built once per process and cached.  The terrain grid is then served to
 * clients as a compressed blob rather than re-generated in the browser: that
 * keeps first load fast on weak hardware and removes any chance of the client
 * and server disagreeing about where the land is.
 */
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { buildWorld } from '@schiffi/shared/world/index.js';
import { WORLDGEN_VERSION, CELLS_X, CELLS_Y, CELL_SIZE } from '@schiffi/shared/world/constants.js';
import { assignFactions, allRelations } from '@schiffi/shared/data/factions.js';
import { Rng, seedFromString } from '@schiffi/shared/util/rng.js';
import { getDatabase } from '../db/index.js';
import config from '../config.js';
import { seedMarketsForWorld } from './economy.js';

/** worldId -> live world instance. */
const instances = new Map();

export function parseSeed(input) {
  if (input === undefined || input === null || input === '') {
    return (Math.random() * 0xffffffff) >>> 0;
  }
  const numeric = Number(input);
  if (Number.isFinite(numeric) && Number.isInteger(numeric)) return numeric >>> 0;
  return seedFromString(String(input));
}

/** Create a new world row and build it. */
export async function createWorld({ name, seed, maxPlayers, createdBy } = {}) {
  const db = getDatabase();
  const resolvedSeed = parseSeed(seed ?? config.game.defaultSeed);
  const now = Date.now();

  const worldId = await db.insert('worlds', {
    name: (name || `Welt ${resolvedSeed.toString(16).slice(0, 6)}`).slice(0, 60),
    seed: resolvedSeed,
    worldgen_version: WORLDGEN_VERSION,
    status: 'open',
    created_at: now,
    tick: 0,
    game_time_ms: 0,
    season: 0,
    settings: '{}',
    max_players: maxPlayers ?? config.game.maxPlayersPerWorld,
  });

  const instance = await loadWorld(worldId);

  // Faction relations start from the static matrix and drift from there.
  for (const rel of allRelations()) {
    await db.insert('faction_relations', {
      world_id: worldId, faction_a: rel.a, faction_b: rel.b,
      relation: rel.value, at_war: rel.value < -0.8 ? 1 : 0, updated_at: now,
    });
  }
  await seedMarketsForWorld(instance);

  return instance;
}

/** Build (or return) the in-memory instance for a world row. */
export async function loadWorld(worldId) {
  const key = String(worldId);
  if (instances.has(key)) return instances.get(key);

  const db = getDatabase();
  const row = await db.get('SELECT * FROM worlds WHERE id = ?', [worldId]);
  if (!row) {
    const error = new Error('world not found');
    error.status = 404;
    error.code = 'error.worldNotFound';
    throw error;
  }
  if (Number(row.worldgen_version) !== WORLDGEN_VERSION) {
    throw new Error(
      `world ${worldId} was generated with worldgen v${row.worldgen_version}, ` +
      `this build is v${WORLDGEN_VERSION}. Refusing to load a world whose land would move.`);
  }

  const started = Date.now();
  const world = buildWorld(Number(row.seed));
  assignFactions(world.ports, world.regions, new Rng(Number(row.seed) ^ 0xfac7));

  const instance = {
    id: row.id,
    name: row.name,
    seed: Number(row.seed),
    status: row.status,
    maxPlayers: Number(row.max_players),
    tick: Number(row.tick),
    gameTimeMs: Number(row.game_time_ms),
    createdAt: Number(row.created_at),
    world,
    portsById: new Map(world.ports.map((p) => [p.id, p])),
    islandsById: new Map(world.islands.map((i) => [i.id, i])),
    // Runtime-only state, rebuilt on restart.
    players: new Map(),
    npcs: new Map(),
    storms: [],
    buildMs: Date.now() - started,
    terrainBlob: null,
    metaCache: null,
  };
  instances.set(key, instance);
  console.log(`[world] built "${instance.name}" seed=${instance.seed} in ${instance.buildMs}ms ` +
    `(${world.ports.length} ports, ${world.islands.length} islands, ${world.stats.undiscoveredCount} uncharted)`);
  return instance;
}

export function getLoadedWorld(worldId) {
  return instances.get(String(worldId)) ?? null;
}

export function loadedWorlds() {
  return [...instances.values()];
}

export async function listWorlds() {
  const db = getDatabase();
  const rows = await db.all('SELECT * FROM worlds ORDER BY created_at');
  const counts = await db.all(
    'SELECT world_id, COUNT(*) AS n FROM characters WHERE deleted_at IS NULL GROUP BY world_id');
  const countMap = new Map(counts.map((r) => [String(r.world_id), Number(r.n)]));

  return rows.map((r) => {
    const live = instances.get(String(r.id));
    return {
      id: r.id,
      name: r.name,
      seed: Number(r.seed),
      status: r.status,
      maxPlayers: Number(r.max_players),
      characters: countMap.get(String(r.id)) ?? 0,
      online: live ? live.players.size : 0,
      createdAt: Number(r.created_at),
      loaded: Boolean(live),
    };
  });
}

/**
 * Static description of a world: ports, regions, islands and the start area.
 * Everything here is derivable from the seed, so it is safe to cache hard.
 */
export function worldMeta(instance) {
  if (instance.metaCache) return instance.metaCache;
  const { world } = instance;

  instance.metaCache = {
    id: instance.id,
    name: instance.name,
    seed: instance.seed,
    version: WORLDGEN_VERSION,
    grid: { cellsX: CELLS_X, cellsY: CELLS_Y, cellSize: CELL_SIZE },
    start: world.start,
    ports: world.ports.map((p) => ({
      id: p.id, name: p.name, x: p.x, y: p.y, size: p.size,
      regionId: p.regionId, faction: p.factionKey, culture: p.culture,
      climate: p.climate, hazard: p.hazard, islandId: p.islandId,
    })),
    regions: world.regions.map((r) => ({
      id: r.id, name: r.name, x: r.x, y: r.y,
      climate: r.climateName, hazard: r.hazardName, pvp: r.pvp,
      stormChance: Math.round(r.stormChance * 100) / 100,
      pirateDensity: Math.round(r.pirateDensity * 100) / 100,
      faction: r.factionKey,
    })),
    // Uncharted islands are listed without a name: the client needs to know a
    // landing is possible, not what is on it.
    anchorages: world.anchorages.map((a) => ({ islandId: a.islandId, x: a.x, y: a.y })),
    islands: world.islands
      .filter((i) => i.area >= 6)
      .map((i) => ({
        id: i.id, name: i.name, area: i.area,
        cx: i.cx * CELL_SIZE, cy: i.cy * CELL_SIZE,
        uncharted: Boolean(i.undiscovered),
        culture: i.culture,
      })),
    stats: world.stats,
  };
  return instance.metaCache;
}

/**
 * The terrain grid as a compressed blob.
 *
 * Layout: a 16-byte header (magic, version, width, height, cellSize) followed
 * by one byte per cell.  Brotli gets 640 KiB of terrain down to a few tens of
 * kilobytes because the field is highly repetitive, which is the difference
 * between an instant load and a stall on a slow connection.
 */
export function terrainBlob(instance, encoding = 'br') {
  if (instance.terrainBlob?.[encoding]) return instance.terrainBlob[encoding];

  const header = Buffer.alloc(16);
  header.write('SCHF', 0, 'ascii');
  header.writeUInt16LE(WORLDGEN_VERSION, 4);
  header.writeUInt16LE(CELLS_X, 6);
  header.writeUInt16LE(CELLS_Y, 8);
  header.writeUInt16LE(CELL_SIZE, 10);
  header.writeUInt32LE(instance.seed, 12);

  const raw = Buffer.concat([header, Buffer.from(instance.world.terrain.buffer,
    instance.world.terrain.byteOffset, instance.world.terrain.byteLength)]);

  const compressed = encoding === 'br'
    ? brotliCompressSync(raw, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    })
    : gzipSync(raw, { level: 9 });

  instance.terrainBlob = instance.terrainBlob ?? {};
  instance.terrainBlob[encoding] = compressed;
  instance.terrainBlob.rawSize = raw.length;
  return compressed;
}

export async function persistWorldTick(instance) {
  const db = getDatabase();
  await db.run('UPDATE worlds SET tick = ?, game_time_ms = ?, season = ? WHERE id = ?',
    [instance.tick, instance.gameTimeMs, instance.season ?? 0, instance.id]);
}

/** Ensure at least one world exists, so a fresh install is playable. */
export async function ensureDefaultWorld() {
  const db = getDatabase();
  const existing = await db.get('SELECT id FROM worlds ORDER BY created_at LIMIT 1');
  if (existing) return loadWorld(existing.id);
  console.log('[world] no world yet - creating the first one');
  return createWorld({ name: 'Nordmeer', seed: config.game.defaultSeed || undefined });
}
