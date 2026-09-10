/**
 * Levels, professions and achievements.
 *
 * Experience is awarded by the systems that produce it (trade, exploration,
 * combat) and never by the client. Achievements are evaluated from the same
 * player_stats rows the profile shows, so a badge always corresponds to
 * something the database can prove.
 */
import { getDatabase } from '../db/index.js';

/** Cumulative experience needed to reach a level. */
export function xpForLevel(level) {
  if (level <= 1) return 0;
  return Math.round(240 * (level - 1) ** 1.72);
}

export const MAX_LEVEL = 60;

export function levelForXp(xp) {
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level++;
  return level;
}

/**
 * Award experience inside an existing transaction and level up if earned.
 * Returns the new level when it changed, otherwise null.
 */
export async function awardXp(tx, characterId, amount) {
  if (!amount || amount <= 0) return null;
  const row = await tx.get('SELECT xp, level FROM characters WHERE id = ?', [characterId]);
  if (!row) return null;

  const xp = Number(row.xp) + Math.round(amount);
  const level = levelForXp(xp);
  await tx.run('UPDATE characters SET xp = ?, level = ? WHERE id = ?', [xp, level, characterId]);
  return level > Number(row.level) ? level : null;
}

/**
 * Professions.
 *
 * A profession is earned, not chosen: it follows from what a captain actually
 * does, which is why the requirement is expressed against player_stats.
 */
export const PROFESSIONS = [
  { key: 'trader', stat: 'goods_sold', threshold: 0 },
  { key: 'explorer', stat: 'islands_found', threshold: 3 },
  { key: 'cartographer', stat: 'distance', threshold: 400_000 },
  { key: 'fisher', stat: 'goods_sold', threshold: 2000 },
  { key: 'pirate_hunter', stat: 'battles_won', threshold: 15 },
  { key: 'smuggler', stat: 'goods_sold', threshold: 1200 },
];

/**
 * Achievements.
 *
 * `metric` names a column of player_stats (or a derived value); `goal` is the
 * value that unlocks it. Progress is therefore always recomputable and can
 * never drift from the game state.
 */
export const ACHIEVEMENTS = [
  { key: 'first_sale', metric: 'goods_sold', goal: 1, points: 5 },
  { key: 'merchant_100', metric: 'goods_sold', goal: 100, points: 10 },
  { key: 'merchant_1k', metric: 'goods_sold', goal: 1000, points: 25 },
  { key: 'merchant_10k', metric: 'goods_sold', goal: 10_000, points: 50 },
  { key: 'buyer_1k', metric: 'goods_bought', goal: 1000, points: 20 },
  { key: 'first_coin', metric: 'coins_earned', goal: 100, points: 5 },
  { key: 'rich_10k', metric: 'coins_earned', goal: 10_000, points: 15 },
  { key: 'rich_1m', metric: 'coins_earned', goal: 1_000_000, points: 40 },
  { key: 'rich_1b', metric: 'coins_earned', goal: 1_000_000_000, points: 80 },
  { key: 'ports_10', metric: 'ports_visited', goal: 10, points: 10 },
  { key: 'ports_50', metric: 'ports_visited', goal: 50, points: 25 },
  { key: 'ports_200', metric: 'ports_visited', goal: 200, points: 50 },
  { key: 'first_island', metric: 'islands_found', goal: 1, points: 20 },
  { key: 'islands_5', metric: 'islands_found', goal: 5, points: 45 },
  { key: 'islands_15', metric: 'islands_found', goal: 15, points: 90 },
  { key: 'distance_100k', metric: 'distance', goal: 100_000, points: 10 },
  { key: 'distance_1m', metric: 'distance', goal: 1_000_000, points: 35 },
  { key: 'storm_survivor', metric: 'storms_survived', goal: 5, points: 15 },
  { key: 'storm_veteran', metric: 'storms_survived', goal: 50, points: 40 },
  { key: 'first_battle', metric: 'battles_won', goal: 1, points: 15 },
  { key: 'battles_10', metric: 'battles_won', goal: 10, points: 30 },
  { key: 'battles_50', metric: 'battles_won', goal: 50, points: 70 },
  { key: 'unlucky', metric: 'cargo_lost', goal: 100, points: 10 },
  { key: 'album_10', metric: 'album_entries', goal: 10, points: 20 },
  { key: 'album_25', metric: 'album_entries', goal: 25, points: 45 },
  { key: 'album_all', metric: 'album_entries', goal: 40, points: 100 },
];

export const ACHIEVEMENT_BY_KEY = new Map(ACHIEVEMENTS.map((a) => [a.key, a]));

/**
 * Recompute achievement progress for a character and unlock what is earned.
 * Cheap enough to run when a player docks or logs out.
 */
export async function evaluateAchievements(characterId) {
  const db = getDatabase();
  const character = await db.get('SELECT user_id FROM characters WHERE id = ?', [characterId]);
  if (!character) return [];

  const stats = await db.get('SELECT * FROM player_stats WHERE character_id = ?', [characterId]);
  if (!stats) return [];

  const albumCount = await db.get(
    "SELECT COUNT(*) AS n FROM discovery_album WHERE character_id = ? AND kind <> 'activity'",
    [characterId]);

  const metrics = {
    ...Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value) || 0])),
    album_entries: Number(albumCount?.n ?? 0),
  };

  const existing = new Map((await db.all(
    'SELECT key, progress, unlocked_at FROM user_achievements WHERE user_id = ?', [character.user_id]))
    .map((row) => [row.key, row]));

  const unlocked = [];
  for (const achievement of ACHIEVEMENTS) {
    const value = metrics[achievement.metric] ?? 0;
    const previous = existing.get(achievement.key);
    if (previous?.unlocked_at) continue;

    const done = value >= achievement.goal;
    if (previous) {
      await db.run(
        'UPDATE user_achievements SET progress = ?, unlocked_at = ? WHERE user_id = ? AND key = ?',
        [value, done ? Date.now() : null, character.user_id, achievement.key]);
    } else {
      await db.insert('user_achievements', {
        user_id: character.user_id, key: achievement.key,
        progress: value, unlocked_at: done ? Date.now() : null,
      });
    }
    if (done) unlocked.push({ key: achievement.key, points: achievement.points });
  }
  return unlocked;
}

/** Achievements with progress, for the profile screen. */
export async function achievementsFor(userId) {
  const db = getDatabase();
  const rows = await db.all(
    'SELECT key, progress, unlocked_at FROM user_achievements WHERE user_id = ?', [userId]);
  const byKey = new Map(rows.map((row) => [row.key, row]));

  return ACHIEVEMENTS.map((achievement) => {
    const row = byKey.get(achievement.key);
    return {
      key: achievement.key,
      metric: achievement.metric,
      goal: achievement.goal,
      points: achievement.points,
      progress: Number(row?.progress ?? 0),
      unlockedAt: row?.unlocked_at ? Number(row.unlocked_at) : null,
    };
  });
}

/** Update the character's profession if their record now supports a better one. */
export async function updateProfession(characterId) {
  const db = getDatabase();
  const stats = await db.get('SELECT * FROM player_stats WHERE character_id = ?', [characterId]);
  if (!stats) return null;

  let best = 'trader';
  let bestScore = 0;
  for (const profession of PROFESSIONS) {
    const value = Number(stats[profession.stat] ?? 0);
    if (value < profession.threshold) continue;
    const score = profession.threshold === 0 ? 0.1 : value / profession.threshold;
    if (score > bestScore) { bestScore = score; best = profession.key; }
  }
  await db.run('UPDATE characters SET profession = ? WHERE id = ?', [best, characterId]);
  return best;
}
