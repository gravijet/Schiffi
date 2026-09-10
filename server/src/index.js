/**
 * Server entry point.
 *
 * Boot order matters: configuration, then database and migrations, then the
 * permission catalogue, then worlds and their simulations, and only then the
 * HTTP listener - so the server never accepts a request it cannot serve.
 */
import { resolve } from 'node:path';
import config, { validateConfig } from './config.js';
import { openDatabase, closeDatabase, getDatabase } from './db/index.js';
import { migrate } from './db/migrate.mjs';
import { syncPermissions } from './services/rbac.js';
import { pruneExpired } from './services/auth.js';
import { HttpServer } from './http/server.js';
import { Gateway } from './ws/gateway.js';
import { Simulation } from './game/simulation.js';
import { ensureDefaultWorld, loadedWorlds, loadWorld } from './game/worldManager.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerGameRoutes } from './routes/game.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerGameplayRoutes, reloadEvents } from './routes/gameplay.js';
import { registerContentRoutes } from './routes/content.js';
import { MSG } from '@schiffi/shared/net/protocol.js';

const simulations = new Map();   // worldId -> Simulation

export async function bootstrap({ listen = true } = {}) {
  validateConfig();

  const db = await openDatabase();
  console.log(`[boot] database: ${db.dialect}`);
  await migrate({ verbose: true });
  await syncPermissions();
  await pruneExpired();

  const staticRoot = resolve(config.root, 'client/dist');
  const http = new HttpServer({ staticRoot });
  const gateway = new Gateway({ simulations });

  registerAuthRoutes(http.router);
  registerAdminRoutes(http.router);
  registerGameRoutes(http.router, { simulations });
  registerSystemRoutes(http.router, { gateway, simulations });
  registerGameplayRoutes(http.router, { gateway });
  registerContentRoutes(http.router);
  gateway.attach(http);

  // Bring up every world that already has characters, plus a default one.
  const first = await ensureDefaultWorld();
  await reloadEvents(first);
  await startSimulation(first, gateway);

  const existing = await db.all(
    'SELECT DISTINCT world_id FROM characters WHERE deleted_at IS NULL');
  for (const row of existing) {
    if (simulations.has(String(row.world_id))) continue;
    const instance = await loadWorld(row.world_id);
    await reloadEvents(instance);
    await startSimulation(instance, gateway);
  }

  // Housekeeping every ten minutes. unref() so this timer alone never keeps
  // the process alive - otherwise an embedded server (tests, tooling) hangs
  // after everything else has been shut down.
  const housekeeping = setInterval(() => {
    pruneExpired().catch((e) => console.error('[boot] prune failed', e.message));
  }, 600_000);
  housekeeping.unref();

  if (listen) {
    await http.listen(config.port, config.host);
    console.log(`[boot] Schiffi listening on http://${config.host}:${config.port}`);
    console.log(`[boot] public URL: ${config.publicUrl}`);
    if (!config.mail.host) {
      console.log('[boot] SMTP is not configured - mail is spooled to data/mail/*.eml');
    }
  }

  /** Ordered teardown, shared by the signal handlers and by tests. */
  const shutdown = async () => {
    clearInterval(housekeeping);
    for (const sim of simulations.values()) {
      sim.stop();
      await sim.persistPlayers().catch(() => {});
    }
    simulations.clear();
    gateway.close();
    await http.close();
    await closeDatabase();
  };

  const onSignal = async (signal) => {
    console.log(`\n[boot] ${signal} received, shutting down`);
    await shutdown();
    process.exit(0);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  return { http, gateway, simulations, db, shutdown };
}

export async function startSimulation(instance, gateway) {
  const key = String(instance.id);
  if (simulations.has(key)) return simulations.get(key);
  const simulation = new Simulation(instance, {
    broadcast: (message) => gateway.broadcastToWorld(instance, { t: MSG.EVENT, ...message }),
  });
  simulation.start();
  simulations.set(key, simulation);
  return simulation;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap().catch((error) => {
    console.error('[boot] failed:', error);
    process.exit(1);
  });
}
