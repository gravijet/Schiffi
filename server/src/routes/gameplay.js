/**
 * Read endpoints for the systems driven over the WebSocket.
 *
 * Anything that changes state goes through the action channel; these routes
 * only answer "what is there right now", which keeps them cacheable and keeps
 * the mutation path in one place.
 */
import { getLoadedWorld, loadWorld } from '../game/worldManager.js';
import { boardFor, activeMissions } from '../game/missions.js';
import { album, pendingNames, moderateName } from '../game/exploration.js';
import { listBounties } from '../game/combat.js';
import { listFriends, guildFor, listGuilds, convoyFor } from '../game/social.js';
import { listMarket, routesFor, outpostsFor, premiumFor } from '../game/market.js';
import { achievementsFor, ACHIEVEMENTS, PROFESSIONS, xpForLevel, levelForXp } from '../game/progression.js';
import { WILDLIFE, FINDINGS, ACTIVITIES } from '@schiffi/shared/data/discoveries.js';
import { getDatabase } from '../db/index.js';
import { notFound, forbidden, badRequest } from '../http/respond.js';

export function registerGameplayRoutes(router, { gateway }) {
  // --- static reference data ----------------------------------------------
  router.get('/api/data/progression', async (ctx) => {
    ctx.res.setHeader('Cache-Control', 'public, max-age=3600');
    return {
      achievements: ACHIEVEMENTS,
      professions: PROFESSIONS,
      levels: Array.from({ length: 60 }, (_, i) => ({ level: i + 1, xp: xpForLevel(i + 1) })),
    };
  }, { auth: false });

  router.get('/api/data/discoveries', async (ctx) => {
    ctx.res.setHeader('Cache-Control', 'public, max-age=3600');
    // The album needs to know what the complete set looks like, not just how
    // big it is, so it can show "12 of 40" and grey out what is still missing.
    const collectables = FINDINGS
      .filter((finding) => finding.album)
      .map((finding) => ({ kind: finding.album, key: finding.good }));
    return {
      activities: ACTIVITIES,
      wildlife: WILDLIFE.map((animal) => ({ key: animal.key, rarity: animal.rarity })),
      collectables,
      findings: FINDINGS.length,
    };
  }, { auth: false });

  // --- missions ------------------------------------------------------------
  router.get('/api/worlds/:worldId/ports/:portId/missions', async (ctx) => {
    const instance = getLoadedWorld(ctx.params.worldId) ?? await loadWorld(ctx.params.worldId);
    const port = instance.portsById.get(ctx.params.portId);
    if (!port) throw notFound();
    return { missions: await boardFor(instance, port) };
  });

  router.get('/api/characters/:id/missions', async (ctx) => {
    await assertOwnership(ctx, ctx.params.id);
    return { missions: await activeMissions(ctx.params.id) };
  });

  // --- exploration ---------------------------------------------------------
  router.get('/api/characters/:id/album', async (ctx) => {
    await assertOwnership(ctx, ctx.params.id);
    return { album: await album(ctx.params.id) };
  });

  router.get('/api/characters/:id/achievements', async (ctx) => {
    await assertOwnership(ctx, ctx.params.id);
    const db = getDatabase();
    const row = await db.get('SELECT user_id, xp, level FROM characters WHERE id = ?', [ctx.params.id]);
    return {
      achievements: await achievementsFor(row.user_id),
      level: Number(row.level),
      xp: Number(row.xp),
      nextLevelXp: xpForLevel(Number(row.level) + 1),
    };
  });

  // --- social --------------------------------------------------------------
  router.get('/api/friends', async (ctx) => listFriends(ctx.user.id, gateway));

  router.get('/api/characters/:id/guild', async (ctx) => {
    await assertOwnership(ctx, ctx.params.id);
    return { guild: await guildFor(ctx.params.id) };
  });

  router.get('/api/worlds/:worldId/guilds', async (ctx) => ({
    guilds: await listGuilds(ctx.params.worldId),
  }), { auth: false });

  router.get('/api/characters/:id/convoy', async (ctx) => {
    await assertOwnership(ctx, ctx.params.id);
    const db = getDatabase();
    const row = await db.get('SELECT world_id FROM characters WHERE id = ?', [ctx.params.id]);
    const instance = getLoadedWorld(row.world_id);
    return { convoy: await convoyFor(ctx.params.id, instance) };
  });

  // --- markets -------------------------------------------------------------
  router.get('/api/worlds/:worldId/market', async (ctx) => listMarket(ctx.params.worldId, {
    goodId: ctx.query.goodId ? Number(ctx.query.goodId) : null,
    limit: Number(ctx.query.limit) || 60,
  }));

  router.get('/api/worlds/:worldId/bounties', async (ctx) => ({
    bounties: await listBounties(ctx.params.worldId),
  }), { auth: false });

  router.get('/api/characters/:id/routes', async (ctx) => {
    await assertOwnership(ctx, ctx.params.id);
    return { routes: await routesFor(ctx.params.id) };
  });

  router.get('/api/worlds/:worldId/outposts', async (ctx) => ({
    outposts: await outpostsFor(ctx.params.worldId, ctx.query.characterId ?? null),
  }), { auth: false });

  router.get('/api/characters/:id/insurance', async (ctx) => {
    await assertOwnership(ctx, ctx.params.id);
    const db = getDatabase();
    const character = await db.get('SELECT * FROM characters WHERE id = ?', [ctx.params.id]);
    const ship = await db.get('SELECT * FROM ships WHERE id = ?', [character.active_ship_id]);
    const instance = getLoadedWorld(character.world_id);
    const port = instance?.portsById.get(character.current_port_id);
    const policies = await db.all(
      'SELECT * FROM insurance_policies WHERE character_id = ? ORDER BY starts_at DESC LIMIT 10',
      [ctx.params.id]);

    return {
      policies: policies.map((row) => ({
        id: row.id, premium: Number(row.premium), coverage: Number(row.coverage),
        startsAt: Number(row.starts_at), endsAt: Number(row.ends_at),
        claimedAt: row.claimed_at ? Number(row.claimed_at) : null,
        payout: row.payout ? Number(row.payout) : null,
      })),
      quote: ship && port
        ? { days: 7, premium: premiumFor(ship.class_key, 7, port.hazard) }
        : null,
    };
  });

  // --- moderation ----------------------------------------------------------
  router.get('/api/admin/worlds/:worldId/names', async (ctx) => ({
    pending: (await pendingNames(ctx.params.worldId)).map((row) => ({
      islandId: Number(row.island_id),
      proposed: row.proposed_name,
      player: row.player_name,
      at: Number(row.discovered_at),
    })),
  }), { permission: 'names.moderate' });

  router.post('/api/admin/worlds/:worldId/names/:islandId', async (ctx) => {
    const body = await ctx.body();
    if (!['approve', 'reject', 'rename'].includes(body.decision)) throw badRequest();
    return moderateName({
      worldId: ctx.params.worldId,
      islandId: Number(ctx.params.islandId),
      decision: body.decision,
      replacement: body.name,
      actor: ctx.actor,
    });
  }, { permission: 'names.moderate' });

  // --- chat moderation -----------------------------------------------------
  router.delete('/api/admin/chat/:id', async (ctx) => {
    const db = getDatabase();
    await db.run('UPDATE chat_messages SET deleted_at = ?, deleted_by = ? WHERE id = ?',
      [Date.now(), ctx.user.id, ctx.params.id]);
    return { deleted: true };
  }, { permission: 'chat.moderate' });

  router.post('/api/admin/users/:id/mute', async (ctx) => {
    const body = await ctx.body();
    const db = getDatabase();
    const minutes = Math.max(1, Math.min(60 * 24 * 30, Number(body.minutes) || 60));
    await db.insert('chat_mutes', {
      user_id: ctx.params.id, until: Date.now() + minutes * 60_000,
      reason: String(body.reason ?? '').slice(0, 200), by: ctx.user.id, at: Date.now(),
    });
    return { muted: true, minutes };
  }, { permission: 'chat.mute' });

  router.get('/api/admin/reports', async (ctx) => {
    const db = getDatabase();
    const rows = await db.all(
      'SELECT * FROM reports WHERE status = ? ORDER BY at DESC LIMIT 100', [ctx.query.status ?? 'open']);
    return { reports: rows };
  }, { permission: 'reports.view' });

  router.post('/api/reports', async (ctx) => {
    const body = await ctx.body();
    if (!body.targetType || !body.targetId || !body.reason) throw badRequest();
    const db = getDatabase();
    const id = await db.insert('reports', {
      reporter_id: ctx.user.id,
      target_type: String(body.targetType).slice(0, 40),
      target_id: String(body.targetId).slice(0, 80),
      reason: String(body.reason).slice(0, 120),
      detail: String(body.detail ?? '').slice(0, 1000),
      status: 'open', at: Date.now(),
    });
    return { reportId: id };
  });

  router.post('/api/admin/reports/:id', async (ctx) => {
    const body = await ctx.body();
    const db = getDatabase();
    await db.run(
      'UPDATE reports SET status = ?, handled_by = ?, handled_at = ?, resolution = ? WHERE id = ?',
      [body.status ?? 'closed', ctx.user.id, Date.now(),
        String(body.resolution ?? '').slice(0, 500), ctx.params.id]);
    return { ok: true };
  }, { permission: 'reports.handle' });

  // --- world events (the admin event editor) -------------------------------
  router.get('/api/admin/worlds/:worldId/events', async (ctx) => {
    const db = getDatabase();
    const rows = await db.all(
      'SELECT * FROM world_events WHERE world_id = ? ORDER BY starts_at DESC LIMIT 100',
      [ctx.params.worldId]);
    return {
      events: rows.map((row) => ({
        id: row.id, kind: row.kind, scope: row.scope,
        regionId: row.region_id, portId: row.port_id,
        title: JSON.parse(row.title || '{}'), body: JSON.parse(row.body || '{}'),
        effects: JSON.parse(row.effects || '{}'),
        startsAt: Number(row.starts_at), endsAt: Number(row.ends_at),
        active: row.active === 1,
      })),
    };
  }, { permission: 'world.events' });

  router.post('/api/admin/worlds/:worldId/events', async (ctx) => {
    const body = await ctx.body();
    const db = getDatabase();
    const instance = getLoadedWorld(ctx.params.worldId);

    const id = await db.insert('world_events', {
      world_id: ctx.params.worldId,
      kind: String(body.kind ?? 'notice').slice(0, 40),
      scope: String(body.scope ?? 'global').slice(0, 20),
      region_id: body.regionId ?? null,
      port_id: body.portId ?? null,
      title: JSON.stringify(body.title ?? {}),
      body: JSON.stringify(body.body ?? {}),
      effects: JSON.stringify(body.effects ?? {}),
      starts_at: Number(body.startsAt) || Date.now(),
      ends_at: Number(body.endsAt) || Date.now() + 3_600_000,
      active: 1, created_by: ctx.user.id, created_at: Date.now(),
    });

    // Take effect immediately rather than at the next reload.
    if (instance) await reloadEvents(instance);
    return { eventId: id };
  }, { permission: 'world.events' });

  router.delete('/api/admin/worlds/:worldId/events/:id', async (ctx) => {
    const db = getDatabase();
    await db.run('UPDATE world_events SET active = 0 WHERE id = ? AND world_id = ?',
      [ctx.params.id, ctx.params.worldId]);
    const instance = getLoadedWorld(ctx.params.worldId);
    if (instance) await reloadEvents(instance);
    return { ok: true };
  }, { permission: 'world.events' });

  router.post('/api/admin/worlds/:worldId/disaster', async (ctx) => {
    const body = await ctx.body();
    const instance = getLoadedWorld(ctx.params.worldId) ?? await loadWorld(ctx.params.worldId);
    const { triggerDisaster } = await import('../game/weather.js');
    const storm = triggerDisaster(instance, body.kind ?? 'hurricane', Number(body.regionId) || 0);
    if (!storm) throw badRequest();
    return { stormId: storm.id, kind: storm.kind, x: Math.round(storm.x), y: Math.round(storm.y),
      radius: Math.round(storm.radius) };
  }, { permission: 'world.events' });
}

/** Load the active event set into a world instance; the economy reads it. */
export async function reloadEvents(instance) {
  const db = getDatabase();
  const now = Date.now();
  const rows = await db.all(
    'SELECT * FROM world_events WHERE world_id = ? AND active = 1 AND starts_at <= ? AND ends_at > ?',
    [instance.id, now, now]);
  instance.activeEvents = rows.map((row) => ({
    id: row.id, kind: row.kind, scope: row.scope,
    region_id: row.region_id, port_id: row.port_id,
    title: JSON.parse(row.title || '{}'), body: JSON.parse(row.body || '{}'),
    effects: JSON.parse(row.effects || '{}'),
    startsAt: Number(row.starts_at), endsAt: Number(row.ends_at),
  }));
  return instance.activeEvents.length;
}

async function assertOwnership(ctx, characterId) {
  const db = getDatabase();
  const row = await db.get('SELECT user_id FROM characters WHERE id = ?', [characterId]);
  if (!row) throw notFound();
  if (String(row.user_id) !== String(ctx.user?.id)) throw forbidden();
}
