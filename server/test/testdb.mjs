/**
 * Test database setup, shared by every suite.
 *
 * The suites run against SQLite by default, which needs no setup at all.  Set
 * TEST_DATABASE_URL to run exactly the same tests against PostgreSQL - that
 * is the only way the portable SQL layer is genuinely covered rather than
 * merely written.
 *
 *   TEST_DATABASE_URL=postgres://user:pw@127.0.0.1/schiffi_test npm test
 *
 * Either way the database starts empty: the SQLite file is deleted, the
 * PostgreSQL schema is dropped and recreated.  The named database is wiped,
 * so point it at a throwaway one.
 */
import { rmSync } from 'node:fs';
import { basename } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';

/**
 * Point the environment at a fresh, empty database and return its URL (empty
 * for SQLite).  Call before importing the server.
 */
export async function useTestDatabase(sqlitePath) {
  process.env.SQLITE_PATH = sqlitePath;
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  if (!TEST_DATABASE_URL) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${sqlitePath}${suffix}`, { force: true });
    return '';
  }

  // Suites run as separate processes at the same time, so each one gets its
  // own schema inside the test database rather than sharing `public` - two
  // processes creating the same tables at once trip over PostgreSQL's own
  // catalogue.  The name comes from the suite's database path, so it is stable
  // across runs and readable when something is left behind.
  const schema = basename(sqlitePath)
    .replace(/-\d+\.db$/, '')            // drop the pid: one schema per suite
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase()
    .slice(0, 48);

  const { Client } = require('pg');
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await client.end();
  }

  const url = new URL(TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  return process.env.DATABASE_URL;
}
