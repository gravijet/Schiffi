/**
 * Server status, health and integrations.
 *
 * `/api/status` is public and deliberately thin; everything that reveals
 * internals sits behind system.status.
 */
import { loadedWorlds, listWorlds } from '../game/worldManager.js';
import * as cloudflare from '../services/cloudflare.js';
import { getDatabase } from '../db/index.js';
import config from '../config.js';
import { LOCALES } from '@schiffi/shared/i18n/index.js';
import { GOODS_COUNT } from '@schiffi/shared/data/goods.js';

const startedAt = Date.now();

export function registerSystemRoutes(router, { gateway, simulations }) {
  router.get('/api/status', async () => {
    const worlds = await listWorlds();
    return {
      status: 'online',
      uptimeMs: Date.now() - startedAt,
      worlds: worlds.map((w) => ({ id: w.id, name: w.name, status: w.status, online: w.online })),
      playersOnline: worlds.reduce((sum, w) => sum + w.online, 0),
      locales: LOCALES.map((l) => ({ code: l.code, name: l.nativeName })),
      goods: GOODS_COUNT,
    };
  }, { auth: false });

  router.get('/api/health', async (ctx) => {
    const db = getDatabase();
    let dbOk = true;
    try { await db.get('SELECT 1 AS ok'); } catch { dbOk = false; }
    if (!dbOk) ctx.res.statusCode = 503;
    return { ok: dbOk, db: db.dialect, uptimeMs: Date.now() - startedAt };
  }, { auth: false });

  router.get('/api/admin/system', async () => {
    const memory = process.memoryUsage();
    return {
      env: config.env,
      node: process.version,
      uptimeMs: Date.now() - startedAt,
      memory: {
        rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal,
        external: memory.external,
      },
      database: getDatabase().dialect,
      websocket: gateway.stats,
      worlds: loadedWorlds().map((w) => {
        const sim = simulations.get(String(w.id));
        return {
          id: w.id, name: w.name, seed: w.seed,
          players: w.players.size, npcs: w.npcs.size, storms: w.storms.length,
          tick: w.tick, tps: sim?.metrics.tps ?? 0,
          tickMs: Math.round((sim?.metrics.tickMs ?? 0) * 100) / 100,
          buildMs: w.buildMs,
        };
      }),
    };
  }, { permission: 'system.status' });

  // --- Cloudflare integration ---------------------------------------------
  router.get('/api/admin/integrations/cloudflare', async () => {
    if (!cloudflare.isConfigured()) {
      return { configured: false, note: 'Set CLOUDFLARE_* in .env to enable.' };
    }
    return { configured: true, ...await cloudflare.verify() };
  }, { permission: 'system.integrations' });

  router.get('/api/admin/integrations/cloudflare/dns', async () => ({
    records: await cloudflare.listDnsRecords(),
  }), { permission: 'system.integrations' });

  router.get('/api/admin/integrations/cloudflare/email', async () => (
    await cloudflare.emailRoutingStatus()
  ), { permission: 'system.integrations' });

  router.post('/api/admin/integrations/cloudflare/dns', async (ctx) => {
    const body = await ctx.body();
    return cloudflare.upsertDnsRecord({
      type: body.type, name: body.name, content: body.content,
      ttl: body.ttl, proxied: body.proxied, priority: body.priority,
    }, { allowMailRecords: body.allowMailRecords === true, actor: ctx.actor });
  }, { permission: 'system.integrations' });
}
