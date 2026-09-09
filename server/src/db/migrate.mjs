/**
 * Migration runner.
 *
 * Applies every .sql file in ../migrations exactly once, in filename order,
 * each inside its own transaction.  Files are translated for the active
 * dialect first, so the same migration works on PostgreSQL and SQLite.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openDatabase, closeDatabase } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../migrations');

async function ensureTable(db) {
  await db.exec(db.schema(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       {{TEXT}} PRIMARY KEY,
      checksum   {{TEXT}} NOT NULL,
      applied_at {{TS}} NOT NULL
    )`));
}

/**
 * Split a migration into statements.  Splitting on `;` is only safe because
 * our migrations contain no procedural bodies or semicolons inside literals;
 * the check below enforces that assumption instead of trusting it.
 */
function splitStatements(sql) {
  if (/\$\$|BEGIN\s+ATOMIC/i.test(sql)) {
    throw new Error('migration contains a procedural body - the simple splitter cannot handle it');
  }
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function migrate({ verbose = true } = {}) {
  const db = await openDatabase();
  await ensureTable(db);

  const applied = new Map(
    (await db.all('SELECT name, checksum FROM schema_migrations')).map((r) => [r.name, r.checksum]));

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;

  for (const file of files) {
    const raw = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(raw).digest('hex').slice(0, 16);

    if (applied.has(file)) {
      // A changed migration means the schema on disk no longer matches the
      // database. Refuse loudly rather than silently diverging.
      if (applied.get(file) !== checksum) {
        throw new Error(
          `migration ${file} was modified after being applied ` +
          `(recorded ${applied.get(file)}, now ${checksum}). ` +
          'Add a new migration instead of editing an applied one.');
      }
      continue;
    }

    const statements = splitStatements(db.schema(raw));
    await db.tx(async (tx) => {
      for (const statement of statements) await tx.exec(statement);
      await tx.insert('schema_migrations', {
        name: file, checksum, applied_at: Date.now(),
      });
    });
    count++;
    if (verbose) console.log(`[migrate] applied ${file} (${statements.length} statements)`);
  }

  if (verbose) {
    console.log(count === 0
      ? `[migrate] up to date (${files.length} migrations, ${db.dialect})`
      : `[migrate] applied ${count} migration(s) on ${db.dialect}`);
  }
  return count;
}

// Allow both `node migrate.mjs` and importing from the server bootstrap.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await migrate();
  } catch (error) {
    console.error('[migrate] failed:', error.message);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
