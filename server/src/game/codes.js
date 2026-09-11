/**
 * Secret codes.
 *
 * Validation is entirely server-side: the client only ever sends the string a
 * player typed. Redemption limits are enforced by the database, not by a
 * flag in the client - a `once_per_character` code is guarded by a lookup in
 * code_redemptions inside the same transaction that pays out.
 *
 * Codes themselves live in `secret_codes` (011_secret_codes.sql) rather than
 * as a hardcoded list, so an admin can create, edit, deactivate or delete one
 * without a deploy.
 */
import { getDatabase } from '../db/index.js';
import { HttpError } from '../http/respond.js';

/**
 * Codes are compared case-insensitively with collapsed whitespace, so
 * "many  coins  DAV26" still works, but nothing else does.
 */
export function normaliseCode(input) {
  return String(input ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Two codes used to be hardcoded here. Seeded once, on an empty table, so an
 * existing install keeps working after the admin UI takes over - an admin
 * can edit or delete either of them from there like any other code.
 */
export async function ensureLegacyCodes() {
  const db = getDatabase();
  const { n } = await db.get('SELECT COUNT(*) AS n FROM secret_codes');
  if (Number(n) > 0) return;
  const now = Date.now();
  for (const legacy of [
    { code: 'many coins dav26', reward_coins: 1_000_000_000_000, limit_type: 'unlimited' },
    { code: 'bumg 1718 lurt 1838 tooo 1444 dav26', reward_coins: 1_000, limit_type: 'once_per_character' },
  ]) {
    await db.insert('secret_codes', { ...legacy, active: 1, created_at: now, updated_at: now });
  }
}

/** Per-character throttle so a script cannot hammer the endpoint. */
const RECENT = new Map(); // characterId -> timestamps[]
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;

function throttle(characterId) {
  const key = String(characterId);
  const now = Date.now();
  const list = (RECENT.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_PER_WINDOW) {
    throw new HttpError(429, 'error.rateLimited', 'too many code attempts');
  }
  list.push(now);
  RECENT.set(key, list);
}

export async function redeemCode({ instance, characterId, userId, code }) {
  throttle(characterId);
  const normalised = normaliseCode(code);
  const db = getDatabase();
  const entry = await db.get(
    'SELECT * FROM secret_codes WHERE code = ? AND active = 1', [normalised]);
  if (!entry || (entry.expires_at && Number(entry.expires_at) < Date.now())) {
    throw new HttpError(400, 'code.invalid', 'unknown code');
  }

  return db.tx(async (tx) => {
    const character = await tx.get(
      'SELECT * FROM characters WHERE id = ? AND deleted_at IS NULL', [characterId]);
    if (!character) throw new HttpError(404, 'error.notFound');
    if (userId && String(character.user_id) !== String(userId)) {
      throw new HttpError(403, 'error.forbidden');
    }

    if (entry.limit_type === 'once_per_character') {
      const used = await tx.get(
        'SELECT id FROM code_redemptions WHERE code = ? AND character_id = ?',
        [entry.code, characterId]);
      if (used) throw new HttpError(409, 'code.alreadyUsed', 'already redeemed on this save');
    } else if (entry.limit_type === 'once_per_account') {
      const used = await tx.get(
        'SELECT id FROM code_redemptions WHERE code = ? AND user_id = ?', [entry.code, userId]);
      if (used) throw new HttpError(409, 'code.alreadyUsed', 'already redeemed on this account');
    }

    const coins = Number(entry.reward_coins ?? 0);
    if (coins > 0) {
      await tx.run('UPDATE characters SET coins = coins + ? WHERE id = ?', [coins, characterId]);
    }
    await tx.insert('code_redemptions', {
      code: entry.code, user_id: character.user_id, character_id: characterId,
      amount: coins, at: Date.now(),
    });

    return {
      code: entry.code,
      coins,
      repeatable: entry.limit_type === 'unlimited',
      balance: Number(character.coins) + coins,
    };
  });
}

/** For the player-facing admin stats view: which codes exist and how often each has been redeemed. */
export async function codeStats() {
  const db = getDatabase();
  const codes = await db.all('SELECT * FROM secret_codes ORDER BY created_at DESC');
  const uses = await db.all(
    'SELECT code, COUNT(*) AS uses, SUM(amount) AS total FROM code_redemptions GROUP BY code');
  const byCode = new Map(uses.map((r) => [r.code, r]));
  return codes.map((entry) => describeCode(entry, byCode.get(entry.code)));
}

function describeCode(entry, usage) {
  return {
    id: entry.id,
    code: entry.code,
    rewardCoins: Number(entry.reward_coins),
    limitType: entry.limit_type,
    active: Number(entry.active) === 1,
    expiresAt: entry.expires_at ? Number(entry.expires_at) : null,
    createdAt: Number(entry.created_at),
    uses: Number(usage?.uses ?? 0),
    totalCoins: Number(usage?.total ?? 0),
  };
}

const LIMIT_TYPES = new Set(['once_per_character', 'once_per_account', 'unlimited']);

/** Admin: list every code, active or not, with its redemption count. */
export async function listCodes() {
  return codeStats();
}

/** Admin: define a new code. */
export async function createCode({ code, rewardCoins, limitType, active, expiresAt, userId }) {
  const normalised = normaliseCode(code);
  if (!normalised) throw new HttpError(400, 'error.validation', 'code is required');
  if (!LIMIT_TYPES.has(limitType)) throw new HttpError(400, 'error.validation', 'invalid limit type');

  const db = getDatabase();
  const taken = await db.get('SELECT id FROM secret_codes WHERE code = ?', [normalised]);
  if (taken) throw new HttpError(409, 'error.conflict', 'code already exists');

  const now = Date.now();
  const id = await db.insert('secret_codes', {
    code: normalised,
    reward_coins: Math.max(0, Math.trunc(Number(rewardCoins) || 0)),
    limit_type: limitType,
    active: active === false ? 0 : 1,
    expires_at: expiresAt ? Number(expiresAt) : null,
    created_by: userId ?? null,
    created_at: now, updated_at: now,
  });
  return describeCode(await db.get('SELECT * FROM secret_codes WHERE id = ?', [id]));
}

/** Admin: change a code's reward, limit, expiry or active state. Its text never changes - delete and recreate instead. */
export async function updateCode(id, { rewardCoins, limitType, active, expiresAt }) {
  const db = getDatabase();
  const row = await db.get('SELECT * FROM secret_codes WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, 'error.notFound');
  if (limitType !== undefined && !LIMIT_TYPES.has(limitType)) {
    throw new HttpError(400, 'error.validation', 'invalid limit type');
  }

  const patch = { updated_at: Date.now() };
  if (rewardCoins !== undefined) patch.reward_coins = Math.max(0, Math.trunc(Number(rewardCoins) || 0));
  if (limitType !== undefined) patch.limit_type = limitType;
  if (active !== undefined) patch.active = active ? 1 : 0;
  if (expiresAt !== undefined) patch.expires_at = expiresAt ? Number(expiresAt) : null;

  const columns = Object.keys(patch);
  await db.run(`UPDATE secret_codes SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...columns.map((c) => patch[c]), id]);
  return describeCode(await db.get('SELECT * FROM secret_codes WHERE id = ?', [id]));
}

/** Admin: remove a code definition. Past redemptions in code_redemptions are kept as history. */
export async function deleteCode(id) {
  const db = getDatabase();
  await db.run('DELETE FROM secret_codes WHERE id = ?', [id]);
  return { ok: true };
}
