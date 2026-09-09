/**
 * Secret codes.
 *
 * Validation is entirely server-side: the client only ever sends the string a
 * player typed.  Redemption limits are enforced by the database, not by a
 * flag in the client - a `once_per_character` code is guarded by a lookup in
 * code_redemptions inside the same transaction that pays out.
 */
import { getDatabase } from '../db/index.js';
import { HttpError } from '../http/respond.js';
import { audit } from '../services/audit.js';

/**
 * Codes are compared case-insensitively with collapsed whitespace, so
 * "many  coins  DAV26" still works, but nothing else does.
 */
export const CODES = [
  {
    code: 'many coins dav26',
    reward: { coins: 1_000_000_000_000 },
    limit: 'unlimited',
  },
  {
    code: 'bumg 1718 lurt 1838 tooo 1444 dav26',
    reward: { coins: 1_000 },
    limit: 'once_per_character',
  },
];

const BY_NORMALISED = new Map(CODES.map((entry) => [entry.code, entry]));

export function normaliseCode(input) {
  return String(input ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
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
  const entry = BY_NORMALISED.get(normalised);
  if (!entry) throw new HttpError(400, 'code.invalid', 'unknown code');

  const db = getDatabase();
  return db.tx(async (tx) => {
    const character = await tx.get(
      'SELECT * FROM characters WHERE id = ? AND deleted_at IS NULL', [characterId]);
    if (!character) throw new HttpError(404, 'error.notFound');
    if (userId && String(character.user_id) !== String(userId)) {
      throw new HttpError(403, 'error.forbidden');
    }

    if (entry.limit === 'once_per_character') {
      const used = await tx.get(
        'SELECT id FROM code_redemptions WHERE code = ? AND character_id = ?',
        [entry.code, characterId]);
      if (used) throw new HttpError(409, 'code.alreadyUsed', 'already redeemed on this save');
    } else if (entry.limit === 'once_per_account') {
      const used = await tx.get(
        'SELECT id FROM code_redemptions WHERE code = ? AND user_id = ?', [entry.code, userId]);
      if (used) throw new HttpError(409, 'code.alreadyUsed', 'already redeemed on this account');
    }

    const coins = Number(entry.reward.coins ?? 0);
    if (coins > 0) {
      await tx.run('UPDATE characters SET coins = coins + ? WHERE id = ?', [coins, characterId]);
    }
    await tx.insert('code_redemptions', {
      code: entry.code, user_id: character.user_id, character_id: characterId,
      amount: coins, at: Date.now(),
    });

    await audit({ userId: character.user_id }, 'code.redeem', 'character', String(characterId),
      { code: entry.code, coins }, { db: tx });

    return {
      code: entry.code,
      coins,
      repeatable: entry.limit === 'unlimited',
      balance: Number(character.coins) + coins,
    };
  });
}

/** For the admin UI: which codes exist and how often each has been redeemed. */
export async function codeStats() {
  const db = getDatabase();
  const rows = await db.all(
    'SELECT code, COUNT(*) AS uses, SUM(amount) AS total FROM code_redemptions GROUP BY code');
  const byCode = new Map(rows.map((r) => [r.code, r]));
  return CODES.map((entry) => ({
    code: entry.code,
    limit: entry.limit,
    reward: entry.reward,
    uses: Number(byCode.get(entry.code)?.uses ?? 0),
    totalCoins: Number(byCode.get(entry.code)?.total ?? 0),
  }));
}
