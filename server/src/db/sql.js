/**
 * Portable SQL helpers.
 *
 * Schiffi targets PostgreSQL and falls back to the SQLite build bundled with
 * Node so the game runs with zero setup.  Rather than maintaining two schemas,
 * migrations are written in a neutral subset and translated here.
 *
 * Conventions that keep the two dialects identical in behaviour:
 *   - timestamps are epoch milliseconds in BIGINT, never native date types
 *   - booleans are INTEGER 0/1
 *   - JSON is TEXT, parsed in JavaScript
 * That leaves only identifier types, placeholders and RETURNING to translate.
 */

const TYPE_MAP = {
  postgres: {
    ID_PK: 'BIGSERIAL PRIMARY KEY',
    ID_REF: 'BIGINT',
    TEXT: 'TEXT',
    INT: 'INTEGER',
    BIGINT: 'BIGINT',
    REAL: 'DOUBLE PRECISION',
    BOOL: 'SMALLINT',
    TS: 'BIGINT',
    JSON: 'TEXT',
    BLOB: 'BYTEA',
  },
  sqlite: {
    ID_PK: 'INTEGER PRIMARY KEY AUTOINCREMENT',
    ID_REF: 'INTEGER',
    TEXT: 'TEXT',
    INT: 'INTEGER',
    BIGINT: 'INTEGER',
    REAL: 'REAL',
    BOOL: 'INTEGER',
    TS: 'INTEGER',
    JSON: 'TEXT',
    BLOB: 'BLOB',
  },
};

/** Replace {{TYPE}} tokens for the target dialect. */
export function translateSchema(sql, dialect) {
  const map = TYPE_MAP[dialect];
  if (!map) throw new Error(`unknown dialect: ${dialect}`);
  return sql.replace(/\{\{(\w+)\}\}/g, (match, token) => {
    if (!(token in map)) throw new Error(`unknown SQL type token: ${token}`);
    return map[token];
  });
}

/**
 * Translate the handful of scalar functions the two dialects spell differently.
 *
 * Queries are written in standard SQL - LEAST and GREATEST - because that is
 * what PostgreSQL understands.  SQLite calls them MIN and MAX (with two or
 * more arguments); its aggregates of the same name take exactly one, so the
 * rewrite is unambiguous.  String literals are consumed by the first branch of
 * the alternation, so a word inside quoted text is never rewritten.
 */
export function translateDml(sql, dialect) {
  if (dialect !== 'sqlite') return sql;
  return sql.replace(/'(?:[^']|'')*'|\bLEAST\s*\(|\bGREATEST\s*\(/gi, (match) =>
    match.startsWith("'") ? match : (match[0].toLowerCase() === 'l' ? 'MIN(' : 'MAX('));
}

/**
 * Convert `?` placeholders to `$1, $2, …` for PostgreSQL.
 * Question marks inside string literals are left alone.
 */
export function toPositional(sql) {
  let out = '';
  let index = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      // '' is an escaped quote inside a literal.
      if (inString && sql[i + 1] === "'") { out += "''"; i++; continue; }
      inString = !inString;
      out += ch;
      continue;
    }
    if (ch === '?' && !inString) { out += `$${++index}`; continue; }
    out += ch;
  }
  return out;
}

/** now() as epoch milliseconds - the single time source for the whole app. */
export function now() {
  return Date.now();
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
