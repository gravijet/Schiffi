/**
 * Add translation keys to all six source locales at once.
 *
 * Locale files are hand-written JavaScript with comments and grouped one-liners,
 * so re-serialising them from the parsed object would throw all of that away.
 * Instead this walks the source text with a brace matcher that knows about
 * strings and comments, finds the section it needs, and splices the new lines in
 * before the closing brace. A section that does not exist yet is appended at the
 * end of the catalogue.
 *
 * Usage:  node tools/i18n-insert.mjs <spec.mjs>
 *
 * The spec module default-exports { section: { key: { de, en, it, fr, zh, ru } } }.
 * A value may be a string or a plural object { one, other } keyed the same way.
 * Keys that already exist are skipped, so re-running is harmless.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const LANGS = ['de', 'en', 'it', 'fr', 'zh', 'ru'];
const LOCALE_DIR = new URL('../shared/src/i18n/locales/', import.meta.url);

/**
 * Index the top-level sections of a catalogue by scanning for `  name: {` at
 * indent 2 and matching braces from there. Strings, template literals and
 * comments are skipped so a `{` inside a translation cannot confuse the count.
 */
export function scanSections(src) {
  const sections = new Map();
  let i = 0;
  let depth = 0;
  let lineStart = 0;
  let pendingName = null;
  let pendingStart = 0;

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { lineStart = i + 1; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? src.length : i + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '{') {
      if (depth === 1) {
        // The identifier just before this brace opens a top-level section.
        const head = src.slice(lineStart, i);
        const m = /^\s{2}([A-Za-z_$][\w$]*)\s*:\s*$/.exec(head);
        pendingName = m ? m[1] : null;
        pendingStart = i;
      }
      depth++;
      i++;
      continue;
    }
    if (c === '}') {
      depth--;
      if (depth === 1 && pendingName) {
        sections.set(pendingName, { name: pendingName, open: pendingStart, close: i });
        pendingName = null;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

/** Does `section` already define `key` at its own level? */
function hasKey(src, section, key) {
  const body = src.slice(section.open + 1, section.close);
  return new RegExp(`(^|[{,\\s])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(body);
}

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

/** Render one key/value pair as source lines at the given indent. */
function renderEntry(key, value, indent) {
  const pad = ' '.repeat(indent);
  if (value && typeof value === 'object') {
    const inner = Object.entries(value)
      .map(([k, v]) => `${pad}  ${k}: ${quote(v)},`)
      .join('\n');
    return `${pad}${key}: {\n${inner}\n${pad}},`;
  }
  return `${pad}${key}: ${quote(value)},`;
}

/**
 * Insert `lines` directly in front of the closing brace at `braceAt`.
 *
 * The anchor has to be the brace itself, not the start of its line: the
 * compact catalogues close a nested object and its section on one line
 * ("smuggle: 'X' } },"), and anchoring on the line start would drop the new
 * keys inside the nested object instead of beside it. Trailing whitespace
 * before the brace is replaced by a newline plus `closeIndent`, and a comma is
 * added when the preceding entry did not already end with one.
 */
function spliceBefore(src, braceAt, lines, closeIndent) {
  const head = src.slice(0, braceAt).replace(/\s+$/, '');
  const separator = head.endsWith(',') || head.endsWith('{') ? '' : ',';
  return `${head}${separator}\n${lines}\n${closeIndent}${src.slice(braceAt)}`;
}

export function applySpec(spec, { dir = LOCALE_DIR, langs = LANGS } = {}) {
  const report = [];
  for (const lang of langs) {
    const file = new URL(`${lang}.js`, dir);
    let src = readFileSync(file, 'utf8');
    let added = 0;
    let skipped = 0;

    for (const [sectionName, entries] of Object.entries(spec)) {
      // Re-scan every time: an earlier splice shifted all later offsets.
      const sections = scanSections(src);
      const pairs = [];
      for (const [key, byLang] of Object.entries(entries)) {
        const value = byLang[lang] ?? byLang.en ?? byLang.de;
        if (value === undefined) throw new Error(`${sectionName}.${key}: no value for ${lang} and no fallback`);
        pairs.push([key, value]);
      }

      const section = sections.get(sectionName);
      if (section) {
        const fresh = pairs.filter(([key]) => {
          if (hasKey(src, section, key)) { skipped++; return false; }
          return true;
        });
        if (!fresh.length) continue;
        const lines = fresh.map(([key, value]) => renderEntry(key, value, 4)).join('\n');
        src = spliceBefore(src, section.close, lines, '  ');
        added += fresh.length;
      } else {
        const lines = pairs.map(([key, value]) => renderEntry(key, value, 4)).join('\n');
        const end = src.lastIndexOf('};');
        if (end < 0) throw new Error(`${lang}.js: no closing "};" found`);
        src = spliceBefore(src, end, `  ${sectionName}: {\n${lines}\n  },`, '');
        added += pairs.length;
      }
    }

    writeFileSync(file, src);
    report.push({ lang, added, skipped });
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error('usage: node tools/i18n-insert.mjs <spec.mjs>');
    process.exit(2);
  }
  const spec = (await import(pathToFileURL(resolve(specPath)).href)).default;
  for (const row of applySpec(spec)) {
    console.log(`${row.lang}: +${row.added} added, ${row.skipped} already present`);
  }
}
