/**
 * Configuration, read once from the environment.
 *
 * `.env` is parsed by hand: it keeps the dependency list short and the format
 * we need (KEY=value, # comments, optional quotes) is small enough to be
 * unambiguous.  Secrets only ever live in the environment, never in code.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../..');

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch (error) {
    // In production the environment comes from the service manager and the
    // developer's .env is deliberately unreadable to the service account.
    // That is not an error worth refusing to boot over.
    console.warn(`[config] ${file} exists but could not be read (${error.code}) - ignoring it`);
    return;
  }
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue; // real env wins
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(resolve(ROOT, '.env'));

const bool = (v, fallback = false) =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));

export const config = {
  env: process.env.NODE_ENV || 'development',
  get isProduction() { return this.env === 'production'; },
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, ''),
  root: ROOT,

  db: {
    url: process.env.DATABASE_URL || '',
    sqlitePath: resolve(ROOT, process.env.SQLITE_PATH || './data/schiffi.db'),
  },

  security: {
    sessionSecret: process.env.SESSION_SECRET || '',
    argon2: {
      memoryCost: num(process.env.ARGON2_MEMORY, 19456),
      timeCost: num(process.env.ARGON2_TIME, 2),
      parallelism: num(process.env.ARGON2_PARALLELISM, 1),
    },
    sessionTtlDays: num(process.env.SESSION_TTL_DAYS, 30),
    // Login throttling
    maxLoginAttempts: num(process.env.MAX_LOGIN_ATTEMPTS, 8),
    loginWindowMinutes: num(process.env.LOGIN_WINDOW_MINUTES, 15),
  },

  mail: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Schiffi <no-reply@localhost>',
    spoolDir: resolve(ROOT, process.env.MAIL_SPOOL_DIR || 'data/mail'),
  },

  /**
   * The one superadmin.
   *
   * Not a role, not a database row, not something an administrator can grant
   * or discover: a single address compared against users.email_norm. Changing
   * it means changing the environment and restarting, which is the point -
   * nothing reachable over HTTP can promote anybody.
   */
  superadmin: {
    email: (process.env.SUPERADMIN_EMAIL || 'hi@benjaminberger.at').trim().toLowerCase(),
  },

  cloudflare: {
    authEmail: process.env.CLOUDFLARE_AUTH_EMAIL || '',
    globalKey: process.env.CLOUDFLARE_GLOBAL_API_KEY || '',
    apiToken: process.env.CLOUDFLARE_API_TOKEN || '',
    zoneId: process.env.CLOUDFLARE_ZONE_ID || '',
    zoneName: process.env.CLOUDFLARE_ZONE_NAME || '',
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    get configured() { return Boolean((this.apiToken || this.globalKey) && this.zoneId); },
  },

  game: {
    tickHz: num(process.env.WORLD_TICK_HZ, 20),
    snapshotHz: num(process.env.NET_SNAPSHOT_HZ, 10),
    defaultSeed: process.env.DEFAULT_WORLD_SEED || '',
    maxPlayersPerWorld: num(process.env.MAX_PLAYERS_PER_WORLD, 400),
    startingCoins: num(process.env.STARTING_COINS, 5),
    newbieProtectionMinutes: num(process.env.NEWBIE_PROTECTION_MINUTES, 90),
  },

  uploads: {
    // Absolute paths win over ROOT, so a test or a packaged install can put
    // the writable directories somewhere else entirely.
    dir: resolve(ROOT, process.env.UPLOADS_DIR || 'data/uploads'),
    maxAvatarBytes: num(process.env.MAX_AVATAR_BYTES, 512 * 1024),
  },
};

/** Fail fast on missing production secrets; auto-generate in development. */
export function validateConfig() {
  const problems = [];
  if (!config.security.sessionSecret) {
    if (config.isProduction) {
      problems.push('SESSION_SECRET is required in production');
    } else {
      config.security.sessionSecret = randomBytes(32).toString('hex');
      console.warn('[config] SESSION_SECRET missing - generated an ephemeral one. ' +
        'Sessions will not survive a restart. Set it in .env.');
    }
  } else if (config.security.sessionSecret.length < 32) {
    problems.push('SESSION_SECRET must be at least 32 characters');
  }
  if (config.isProduction && !config.db.url) {
    problems.push('DATABASE_URL (PostgreSQL) is required in production');
  }
  if (problems.length) {
    throw new Error(`Configuration errors:\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}

export default config;
