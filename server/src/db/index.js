/**
 * Database access layer.
 *
 * One tiny interface over two drivers:
 *   all(sql, params)      -> rows
 *   get(sql, params)      -> first row or null
 *   run(sql, params)      -> { changes, lastId }
 *   insert(table, values) -> inserted id
 *   tx(fn)                -> run fn(handle) inside a transaction
 *
 * Every method is async, including the synchronous SQLite ones, so call sites
 * read the same regardless of driver.  Placeholders are always `?`.
 *
 * Transactions hand the callback its own *handle*.  That matters for both
 * drivers: PostgreSQL must pin one pooled client, and SQLite - which is a
 * single synchronous connection - must not let an unrelated request's query
 * slip between BEGIN and COMMIT and get rolled back with it.  A mutex on the
 * connection makes that impossible.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import config from '../config.js';
import { toPositional, translateSchema, translateDml } from './sql.js';

const require = createRequire(import.meta.url);

/** SQLite bindings accept only null/number/bigint/string/Uint8Array. */
function normalise(params) {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.getTime();
    return value;
  });
}

function insertSql(table, keys, returning) {
  return `INSERT INTO ${table} (${keys.join(', ')}) ` +
    `VALUES (${keys.map(() => '?').join(', ')})${returning ? ' RETURNING id' : ''}`;
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

class SqliteConnection {
  constructor(path) {
    const { DatabaseSync } = require('node:sqlite');
    mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.statements = new Map();
  }

  prepare(sql) {
    // Keyed on the original text, so the dialect rewrite happens once per
    // distinct query rather than on every call.
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(translateDml(sql, 'sqlite'));
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  all(sql, params) { return this.prepare(sql).all(...normalise(params)); }
  get(sql, params) { return this.prepare(sql).get(...normalise(params)) ?? null; }
  run(sql, params) {
    const r = this.prepare(sql).run(...normalise(params));
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }
  exec(sql) { this.statements.clear(); this.raw.exec(translateDml(sql, 'sqlite')); }
  close() { this.statements.clear(); this.raw.close(); }
}

/** The handle handed to a transaction callback: no locking, already inside. */
class SqliteHandle {
  constructor(conn) { this.conn = conn; this.dialect = 'sqlite'; }
  async all(sql, params = []) { return this.conn.all(sql, params); }
  async get(sql, params = []) { return this.conn.get(sql, params); }
  async run(sql, params = []) { return this.conn.run(sql, params); }
  async insert(table, values) {
    const keys = Object.keys(values);
    return this.conn.run(insertSql(table, keys, false), keys.map((k) => values[k])).lastId;
  }
  async exec(sql) { this.conn.exec(sql); }
  async tx(fn) { return fn(this); }   // already in a transaction: join it
  schema(sql) { return translateSchema(sql, 'sqlite'); }
}

class SqliteDb {
  constructor(path) {
    this.conn = new SqliteConnection(path);
    this.dialect = 'sqlite';
    this.handle = new SqliteHandle(this.conn);
    this.lock = Promise.resolve();
  }

  /**
   * Serialise against any in-flight transaction.
   *
   * The mutex has to be *held*, not merely waited on: node:sqlite runs
   * synchronously on one connection, so a bare statement that starts after a
   * BEGIN IMMEDIATE becomes part of that transaction and is rolled back with
   * it. Waiting without holding left exactly that window open.
   */
  async _guard(fn) {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return fn();
    } finally {
      release();
    }
  }

  async all(sql, params = []) { return this._guard(() => this.conn.all(sql, params)); }
  async get(sql, params = []) { return this._guard(() => this.conn.get(sql, params)); }
  async run(sql, params = []) { return this._guard(() => this.conn.run(sql, params)); }
  async insert(table, values) { return this.handle.insert.call(this.handle, table, values); }
  async exec(sql) { return this._guard(() => this.conn.exec(sql)); }

  async tx(fn) {
    // Chain onto the mutex so transactions never interleave.
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => { release = resolve; });
    await previous;

    this.conn.exec('BEGIN IMMEDIATE');
    // A transaction that never finishes is almost always a call that reached
    // for the shared handle from inside the transaction and is now waiting on
    // the mutex it holds. Name that instead of hanging silently.
    const watchdog = setTimeout(() => {
      console.error('[db] transaction has been open for 15s - a nested call is ' +
        'probably using the shared database handle instead of the transaction handle');
    }, 15_000);
    try {
      const result = await fn(this.handle);
      this.conn.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.conn.exec('ROLLBACK'); } catch { /* nothing open */ }
      throw error;
    } finally {
      clearTimeout(watchdog);
      release();
    }
  }

  schema(sql) { return translateSchema(sql, 'sqlite'); }
  async close() { await this.lock; this.conn.close(); }
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

/**
 * Which tables have an `id` column.
 *
 * `insert()` returns the new row's id, which on PostgreSQL means appending
 * RETURNING id - but join tables and the migration ledger have no id, and
 * asking for one there is an error rather than a null.  The catalogue is
 * asked once per table and cached; inside a transaction the question goes to
 * that transaction's own client, so a table created moments earlier in the
 * same migration is already visible.
 */
const ID_COLUMN_SQL =
  `SELECT 1 FROM information_schema.columns
    WHERE table_schema = ANY (current_schemas(false))
      AND table_name = $1 AND column_name = 'id'`;

async function hasIdColumn(query, cache, table) {
  const cached = cache.get(table);
  if (cached !== undefined) return cached;
  const { rows } = await query(ID_COLUMN_SQL, [table]);
  const has = rows.length > 0;
  cache.set(table, has);
  return has;
}

class PostgresHandle {
  constructor(client, idColumns) {
    this.client = client;
    this.dialect = 'postgres';
    this.idColumns = idColumns;
  }
  async all(sql, params = []) {
    return (await this.client.query(toPositional(sql), normalise(params))).rows;
  }
  async get(sql, params = []) {
    const { rows } = await this.client.query(toPositional(sql), normalise(params));
    return rows[0] ?? null;
  }
  async run(sql, params = []) {
    const r = await this.client.query(toPositional(sql), normalise(params));
    return { changes: r.rowCount ?? 0, lastId: null };
  }
  async insert(table, values) {
    const keys = Object.keys(values);
    const returning = await hasIdColumn((sql, params) => this.client.query(sql, params),
      this.idColumns, table);
    const { rows } = await this.client.query(
      toPositional(insertSql(table, keys, returning)), normalise(keys.map((k) => values[k])));
    return returning ? (rows[0]?.id ?? null) : null;
  }
  async exec(sql) { await this.client.query(sql); }
  async tx(fn) { return fn(this); }
  schema(sql) { return translateSchema(sql, 'postgres'); }
}

class PostgresDb {
  constructor(pool) {
    this.pool = pool;
    this.dialect = 'postgres';
    this.idColumns = new Map();
  }

  async all(sql, params = []) {
    return (await this.pool.query(toPositional(sql), normalise(params))).rows;
  }
  async get(sql, params = []) {
    const { rows } = await this.pool.query(toPositional(sql), normalise(params));
    return rows[0] ?? null;
  }
  async run(sql, params = []) {
    const r = await this.pool.query(toPositional(sql), normalise(params));
    return { changes: r.rowCount ?? 0, lastId: null };
  }
  async insert(table, values) {
    const keys = Object.keys(values);
    const returning = await hasIdColumn((sql, params) => this.pool.query(sql, params),
      this.idColumns, table);
    const { rows } = await this.pool.query(
      toPositional(insertSql(table, keys, returning)), normalise(keys.map((k) => values[k])));
    return returning ? (rows[0]?.id ?? null) : null;
  }
  async exec(sql) { await this.pool.query(sql); }

  async tx(fn) {
    const client = await this.pool.connect();
    const handle = new PostgresHandle(client, this.idColumns);
    try {
      await client.query('BEGIN');
      const result = await fn(handle);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
      throw error;
    } finally {
      client.release();
    }
  }

  schema(sql) { return translateSchema(sql, 'postgres'); }
  async close() { await this.pool.end(); }
}

// ---------------------------------------------------------------------------

let _db = null;

/**
 * Open (or return) the process-wide database handle.
 * PostgreSQL when DATABASE_URL is set, otherwise the bundled SQLite file.
 */
export async function openDatabase() {
  if (_db) return _db;

  if (config.db.url) {
    let pg;
    try {
      pg = await import('pg');
    } catch {
      throw new Error('DATABASE_URL is set but the "pg" package is not installed. ' +
        'Run: npm install pg --workspace=server');
    }
    // BIGINT arrives as a string by default, because it can exceed the range
    // JavaScript numbers represent exactly.  Ours cannot: ids come from a
    // sequence and every timestamp is epoch milliseconds, both far below
    // 2^53.  Parsing them as numbers keeps the two dialects interchangeable -
    // otherwise every `id === id` comparison in the game would be a string
    // against a number, and every timestamp subtraction would be NaN.
    const types = pg.default?.types ?? pg.types;
    types.setTypeParser(20, (value) => {
      const n = Number(value);
      if (!Number.isSafeInteger(n)) throw new Error(`BIGINT ${value} exceeds safe integer range`);
      return n;
    });

    const Pool = pg.default?.Pool ?? pg.Pool;
    const pool = new Pool({ connectionString: config.db.url, max: 10, idleTimeoutMillis: 30_000 });
    await pool.query('SELECT 1'); // fail fast on a bad connection string
    _db = new PostgresDb(pool);
  } else {
    _db = new SqliteDb(config.db.sqlitePath);
  }
  return _db;
}

export function getDatabase() {
  if (!_db) throw new Error('database not opened - call openDatabase() first');
  return _db;
}

export async function closeDatabase() {
  if (!_db) return;
  await _db.close();
  _db = null;
}
