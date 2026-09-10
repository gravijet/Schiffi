/**
 * The advert shown before the site itself.
 *
 * One row is active at a time, and the client asks for it before it paints
 * anything else, so this read happens on literally every first page view. It
 * is therefore cached in memory for a few seconds: the alternative is a
 * database round trip per visitor for a row that changes once a month.
 *
 * Only the superadmin can write here (routes/superadmin.js). Nothing an
 * administrator can reach touches this table.
 */
import { getDatabase } from '../db/index.js';
import { removeMedia, mediaKind } from './media.js';

const CACHE_TTL_MS = 10_000;
let cached = { at: 0, value: null };

export function invalidate() {
  cached = { at: 0, value: null };
}

const shape = (row) => {
  if (!row) return null;
  const kind = mediaKind(row.image_path);
  return {
  id: row.id,
  headline: row.headline,
  body: row.body ?? '',
  image: kind === 'image' ? `/media/ads/${row.image_path}` : null,
  video: kind === 'video' ? `/media/ads/${row.image_path}` : null,
  mediaKind: kind,
  targetUrl: row.target_url || null,
  seconds: Number(row.seconds) || 0,
  active: row.active === 1,
  impressions: Number(row.impressions ?? 0),
  clicks: Number(row.clicks ?? 0),
  updatedAt: Number(row.updated_at ?? 0),
  };
};

export async function activeInterstitial() {
  if (Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const db = getDatabase();
  const row = await db.get(
    'SELECT * FROM interstitials WHERE active = 1 ORDER BY updated_at DESC LIMIT 1');
  cached = { at: Date.now(), value: shape(row) };
  return cached.value;
}

export async function listInterstitials() {
  const db = getDatabase();
  const rows = await db.all('SELECT * FROM interstitials ORDER BY updated_at DESC LIMIT 100');
  return rows.map(shape);
}

export async function createInterstitial(fields, userId) {
  const db = getDatabase();
  const now = Date.now();
  const id = await db.insert('interstitials', {
    headline: fields.headline,
    body: fields.body ?? '',
    image_path: fields.imagePath ?? null,
    target_url: fields.targetUrl ?? null,
    seconds: fields.seconds,
    active: 0,
    created_by: userId ?? null,
    created_at: now,
    updated_at: now,
  });
  invalidate();
  return id;
}

export async function updateInterstitial(id, fields) {
  const db = getDatabase();
  const columns = {};
  if (fields.headline !== undefined) columns.headline = fields.headline;
  if (fields.body !== undefined) columns.body = fields.body;
  if (fields.targetUrl !== undefined) columns.target_url = fields.targetUrl || null;
  if (fields.seconds !== undefined) columns.seconds = fields.seconds;
  if (fields.imagePath !== undefined) columns.image_path = fields.imagePath;
  if (!Object.keys(columns).length) return;
  columns.updated_at = Date.now();
  await db.run(
    `UPDATE interstitials SET ${Object.keys(columns).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...Object.values(columns), id]);
  invalidate();
}

/**
 * Activate one advert, or none.
 *
 * Deactivating everything else in the same transaction is what makes "one
 * active row" true rather than merely intended - two rows both claiming to be
 * the first thing a visitor sees is a contradiction, not a configuration.
 */
export async function setActive(id) {
  const db = getDatabase();
  await db.tx(async (tx) => {
    await tx.run('UPDATE interstitials SET active = 0, updated_at = ? WHERE active = 1', [Date.now()]);
    if (id !== null) {
      await tx.run('UPDATE interstitials SET active = 1, updated_at = ? WHERE id = ?', [Date.now(), id]);
    }
  });
  invalidate();
}

export async function deleteInterstitial(id) {
  const db = getDatabase();
  const row = await db.get('SELECT image_path FROM interstitials WHERE id = ?', [id]);
  await db.run('DELETE FROM interstitials WHERE id = ?', [id]);
  invalidate();

  // The image is named after its content, so another row may legitimately be
  // using the very same file.
  if (row?.image_path) {
    const stillUsed = await db.get(
      'SELECT 1 AS x FROM interstitials WHERE image_path = ? LIMIT 1', [row.image_path]);
    const usedByAd = await db.get(
      'SELECT 1 AS x FROM ads WHERE image_path = ? LIMIT 1', [row.image_path]);
    if (!stillUsed && !usedByAd) await removeMedia(row.image_path);
  }
}

export async function countImpression(id) {
  const db = getDatabase();
  await db.run('UPDATE interstitials SET impressions = impressions + 1 WHERE id = ?', [id]);
}

export async function countClick(id) {
  const db = getDatabase();
  const row = await db.get('SELECT id FROM interstitials WHERE id = ? AND active = 1', [id]);
  if (!row) return false;
  await db.run('UPDATE interstitials SET clicks = clicks + 1 WHERE id = ?', [id]);
  return true;
}
