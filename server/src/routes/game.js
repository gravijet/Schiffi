/**
 * Game data endpoints.
 *
 * Read-heavy things live here (world metadata, terrain, market listings,
 * price history); everything that *changes* game state goes through the
 * WebSocket action channel so it runs against the live simulation.
 */
import { listWorlds, loadWorld, getLoadedWorld, worldMeta, terrainBlob, createWorld } from '../game/worldManager.js';
import { listCharacters, createCharacter, loadCharacter } from '../game/characters.js';
import { marketFor, priceStats } from '../game/economy.js';
import { crewOffers, creditLimit } from '../game/actions.js';
import { boardFor } from '../game/missions.js';
import { chatHistory } from '../ws/chat.js';
import { codeStats } from '../game/codes.js';
import { weatherAt } from '../game/weather.js';
import { getDatabase } from '../db/index.js';
import { allGoods, goodById, CATEGORIES } from '@schiffi/shared/data/goods.js';
import { SHIP_CLASSES, UPGRADES } from '@schiffi/shared/data/ships.js';
import { ROLES, SPECIALISATIONS } from '@schiffi/shared/data/crew.js';
import { FACTIONS } from '@schiffi/shared/data/factions.js';
import { notFound, badRequest, forbidden } from '../http/respond.js';
import { WORLDGEN_VERSION } from '@schiffi/shared/world/constants.js';

export function registerGameRoutes(router, { simulations }) {
  // --- static game data (cacheable, identical for everyone) ---------------
  router.get('/api/data/goods', async (ctx) => {
    const lang = ctx.query.lang;
    const goods = allGoods();
    ctx.res.setHeader('Cache-Control', 'public, max-age=3600');
    return {
      count: goods.length,
      categories: CATEGORIES,
      goods: goods.map((g) => ({
        id: g.id, key: g.key, cat: g.cat, price: g.price, weight: g.weight,
        vol: g.vol, perish: g.perish, rare: g.rare, clim: g.clim, spread: g.spread,
        name: lang ? (g.names[lang] ?? g.names.en) : undefined,
        names: lang ? undefined : g.names,
      })),
    };
  }, { auth: false });

  router.get('/api/data/ships', async (ctx) => {
    ctx.res.setHeader('Cache-Control', 'public, max-age=3600');
    return { classes: SHIP_CLASSES, upgrades: UPGRADES };
  }, { auth: false });

  router.get('/api/data/crew', async (ctx) => {
    ctx.res.setHeader('Cache-Control', 'public, max-age=3600');
    return { roles: ROLES, specialisations: SPECIALISATIONS };
  }, { auth: false });

  router.get('/api/data/factions', async (ctx) => {
    ctx.res.setHeader('Cache-Control', 'public, max-age=3600');
    return { factions: FACTIONS };
  }, { auth: false });

  router.get('/api/data/codes', async () => ({ codes: await codeStats() }),
    { permission: 'system.status' });

  // --- worlds --------------------------------------------------------------
  router.get('/api/worlds', async () => ({ worlds: await listWorlds(), worldgenVersion: WORLDGEN_VERSION }),
    { auth: false });

  router.post('/api/worlds', async (ctx) => {
    const body = await ctx.body();
    const instance = await createWorld({
      name: body.name, seed: body.seed, maxPlayers: body.maxPlayers, createdBy: ctx.user.id,
    });
    return { id: instance.id, name: instance.name, seed: instance.seed, buildMs: instance.buildMs };
  }, { permission: 'world.manage' });

  router.get('/api/worlds/:id', async (ctx) => {
    const instance = getLoadedWorld(ctx.params.id) ?? await loadWorld(ctx.params.id);
    ctx.res.setHeader('Cache-Control', 'private, max-age=300');
    return worldMeta(instance);
  }, { auth: false });

  /**
   * The terrain grid, pre-compressed.  It is derived purely from the seed, so
   * it may be cached forever under a seed-and-version keyed ETag.
   */
  router.get('/api/worlds/:id/terrain', async (ctx) => {
    const instance = getLoadedWorld(ctx.params.id) ?? await loadWorld(ctx.params.id);
    const accept = ctx.req.headers['accept-encoding'] ?? '';
    const encoding = /\bbr\b/.test(accept) ? 'br' : 'gzip';
    const body = terrainBlob(instance, encoding);
    const etag = `"terrain-${instance.seed}-${WORLDGEN_VERSION}-${encoding}"`;

    if (ctx.req.headers['if-none-match'] === etag) {
      ctx.res.writeHead(304, { ETag: etag });
      return ctx.res.end();
    }
    ctx.res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': encoding,
      'Content-Length': body.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: etag,
      Vary: 'Accept-Encoding',
    });
    ctx.res.end(body);
    return undefined;
  }, { auth: false });

  router.get('/api/worlds/:id/status', async (ctx) => {
    const instance = getLoadedWorld(ctx.params.id);
    const simulation = simulations.get(String(ctx.params.id));
    if (!instance) return { loaded: false };
    return {
      loaded: true,
      online: instance.players.size,
      npcs: instance.npcs.size,
      storms: instance.storms.length,
      tick: instance.tick,
      gameTimeMs: instance.gameTimeMs,
      season: instance.season ?? 0,
      tps: simulation?.metrics.tps ?? 0,
      tickMs: Math.round((simulation?.metrics.tickMs ?? 0) * 100) / 100,
    };
  }, { auth: false });

  router.get('/api/worlds/:id/weather', async (ctx) => {
    const instance = getLoadedWorld(ctx.params.id) ?? await loadWorld(ctx.params.id);
    const simulation = simulations.get(String(ctx.params.id));
    if (!simulation) throw notFound();
    const x = Number(ctx.query.x) || instance.world.start.x;
    const y = Number(ctx.query.y) || instance.world.start.y;
    return weatherAt(instance, simulation, x, y);
  }, { auth: false });

  // --- characters ----------------------------------------------------------
  router.get('/api/characters', async (ctx) => ({ characters: await listCharacters(ctx.user.id) }));

  router.post('/api/characters', async (ctx) => {
    const body = await ctx.body();
    const instance = getLoadedWorld(body.worldId) ?? await loadWorld(body.worldId);
    const id = await createCharacter({
      userId: ctx.user.id, worldId: instance.id, name: body.name, mode: body.mode ?? 'trader',
    }, instance);
    return { id, character: await loadCharacter(id) };
  });

  router.get('/api/characters/:id', async (ctx) => {
    const character = await loadCharacter(ctx.params.id);
    await assertOwnership(ctx, ctx.params.id);
    return character;
  });

  router.delete('/api/characters/:id', async (ctx) => {
    await assertOwnership(ctx, ctx.params.id);
    const db = getDatabase();
    await db.run('UPDATE characters SET deleted_at = ? WHERE id = ?', [Date.now(), ctx.params.id]);
    return { ok: true };
  });

  // --- ports and markets ---------------------------------------------------
  router.get('/api/worlds/:worldId/ports/:portId', async (ctx) => {
    const instance = getLoadedWorld(ctx.params.worldId) ?? await loadWorld(ctx.params.worldId);
    const port = instance.portsById.get(ctx.params.portId);
    if (!port) throw notFound();

    const characterId = ctx.query.characterId;
    let character = null;
    if (characterId) {
      await assertOwnership(ctx, characterId);
      character = { id: characterId };
    }

    const missions = await boardFor(instance, port);

    return {
      port: {
        id: port.id, name: port.name, x: port.x, y: port.y, size: port.size,
        faction: port.factionKey, culture: port.culture, climate: port.climate,
        hazard: port.hazard, regionId: port.regionId,
        region: instance.world.regions[port.regionId]?.name,
      },
      facilities: facilitiesFor(port),
      market: await marketFor(instance, port.id, character),
      crewOffers: crewOffers(instance, port, port.size >= 2 ? 10 : 5),
      missions,
    };
  });

  router.get('/api/worlds/:worldId/ports/:portId/prices/:goodId', async (ctx) => {
    const instance = getLoadedWorld(ctx.params.worldId) ?? await loadWorld(ctx.params.worldId);
    const good = goodById(Number(ctx.params.goodId));
    if (!good) throw notFound();
    return {
      goodId: good.id,
      key: good.key,
      basePrice: good.price,
      ...await priceStats(instance, ctx.params.portId, good.id),
    };
  }, { auth: false });

  // --- chat history --------------------------------------------------------
  router.get('/api/worlds/:worldId/chat', async (ctx) => ({
    messages: await chatHistory({
      worldId: ctx.params.worldId,
      channel: ctx.query.channel ?? 'global',
      scopeId: ctx.query.scopeId ?? null,
      limit: Number(ctx.query.limit) || 60,
      before: ctx.query.before ? Number(ctx.query.before) : null,
    }),
  }));

  // --- leaderboards --------------------------------------------------------
  router.get('/api/worlds/:worldId/leaderboard', async (ctx) => {
    const db = getDatabase();
    const board = ctx.query.board ?? 'wealth';
    const limit = Math.min(100, Number(ctx.query.limit) || 25);

    const queries = {
      wealth: 'SELECT name AS display_name, (coins + bank_balance) AS score FROM characters ' +
        'WHERE world_id = ? AND deleted_at IS NULL ORDER BY score DESC LIMIT ?',
      level: 'SELECT name AS display_name, xp AS score FROM characters ' +
        'WHERE world_id = ? AND deleted_at IS NULL ORDER BY score DESC LIMIT ?',
      trade: 'SELECT c.name AS display_name, s.goods_sold AS score FROM player_stats s ' +
        'JOIN characters c ON c.id = s.character_id WHERE c.world_id = ? ORDER BY score DESC LIMIT ?',
      discoveries: 'SELECT c.name AS display_name, s.islands_found AS score FROM player_stats s ' +
        'JOIN characters c ON c.id = s.character_id WHERE c.world_id = ? ORDER BY score DESC LIMIT ?',
      distance: 'SELECT c.name AS display_name, CAST(s.distance AS INTEGER) AS score FROM player_stats s ' +
        'JOIN characters c ON c.id = s.character_id WHERE c.world_id = ? ORDER BY score DESC LIMIT ?',
    };
    const sql = queries[board];
    if (!sql) throw badRequest();

    const rows = await db.all(sql, [ctx.params.worldId, limit]);
    return {
      board,
      entries: rows.map((r, i) => ({ rank: i + 1, name: r.display_name, score: Number(r.score) })),
    };
  }, { auth: false });

  // --- discoveries ---------------------------------------------------------
  router.get('/api/worlds/:worldId/discoveries', async (ctx) => {
    const db = getDatabase();
    const rows = await db.all(
      'SELECT * FROM island_discoveries WHERE world_id = ? ORDER BY discovered_at DESC LIMIT 200',
      [ctx.params.worldId]);
    return {
      discoveries: rows.map((r) => ({
        islandId: Number(r.island_id),
        player: r.player_name,
        at: Number(r.discovered_at),
        name: r.final_name ?? r.proposed_name,
        nameStatus: r.name_status,
      })),
    };
  }, { auth: false });
}

/** Which facilities a port offers, derived from its size and faction. */
function facilitiesFor(port) {
  return {
    market: true,
    shipyard: port.size >= 1,
    warehouse: port.size >= 1,
    bank: port.size >= 2,
    insurance: port.size >= 2,
    crewMarket: true,
    missions: true,
    noticeBoard: true,
    customs: port.size >= 1,
    tavern: true,
    auction: port.size >= 3,
    shipyardTier: Math.min(5, port.size + 1),
  };
}

async function assertOwnership(ctx, characterId) {
  const db = getDatabase();
  const row = await db.get('SELECT user_id FROM characters WHERE id = ?', [characterId]);
  if (!row) throw notFound();
  if (String(row.user_id) !== String(ctx.user?.id)) throw forbidden();
}
