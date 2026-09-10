/**
 * Friends, convoys and trading companies.
 *
 * All three are real, persisted relationships rather than client-side lists:
 * a friend request exists as a row until it is accepted, a convoy shares a
 * chat channel and a position feed, and a company has a treasury whose every
 * movement is recorded in a ledger.
 */
import { getDatabase } from '../db/index.js';
import { HttpError } from '../http/respond.js';
import { audit } from '../services/audit.js';
import { FOUNDING_FEE } from '@schiffi/shared/data/costs.js';

const fail = (code, message = code) => new HttpError(400, code, message);

/** Rank permissions inside a company. Composed like the server-wide RBAC. */
export const GUILD_PERMISSIONS = ['invite', 'kick', 'deposit', 'withdraw', 'edit', 'ranks', 'disband'];

const DEFAULT_RANKS = [
  { key: 'founder', name: 'Founder', priority: 100, permissions: GUILD_PERMISSIONS },
  { key: 'officer', name: 'Officer', priority: 50, permissions: ['invite', 'kick', 'deposit', 'withdraw'] },
  { key: 'member', name: 'Member', priority: 10, permissions: ['deposit'] },
];

// ---------------------------------------------------------------------------
// friends
// ---------------------------------------------------------------------------

export async function addFriend({ userId, payload }) {
  const db = getDatabase();
  const name = String(payload.username ?? '').trim();
  if (!name) throw fail('error.validation');

  const target = await db.get(
    'SELECT id, username FROM users WHERE username_norm = ? AND deleted_at IS NULL',
    [name.toLowerCase()]);
  if (!target) throw new HttpError(404, 'error.notFound');
  if (String(target.id) === String(userId)) throw fail('error.validation');

  const blocked = await db.get('SELECT 1 AS x FROM blocks WHERE user_id = ? AND blocked_id = ?',
    [target.id, userId]);
  // Silently succeed rather than reveal that the other party blocked you.
  if (blocked) return { requested: true, username: target.username };

  const existing = await db.get(
    'SELECT status FROM friendships WHERE user_id = ? AND friend_id = ?', [userId, target.id]);
  if (existing) return { requested: true, username: target.username, status: existing.status };

  // A request the other side already sent is accepted immediately.
  const incoming = await db.get(
    "SELECT status FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'pending'",
    [target.id, userId]);

  await db.tx(async (tx) => {
    await tx.insert('friendships', {
      user_id: userId, friend_id: target.id,
      status: incoming ? 'accepted' : 'pending', created_at: Date.now(),
    });
    if (incoming) {
      await tx.run("UPDATE friendships SET status = 'accepted' WHERE user_id = ? AND friend_id = ?",
        [target.id, userId]);
    }
  });

  return { requested: true, username: target.username, status: incoming ? 'accepted' : 'pending' };
}

export async function acceptFriend({ userId, payload }) {
  const db = getDatabase();
  const requesterId = payload.userId;
  const request = await db.get(
    "SELECT * FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'pending'",
    [requesterId, userId]);
  if (!request) throw new HttpError(404, 'error.notFound');

  await db.tx(async (tx) => {
    await tx.run("UPDATE friendships SET status = 'accepted' WHERE user_id = ? AND friend_id = ?",
      [requesterId, userId]);
    const mirror = await tx.get('SELECT 1 AS x FROM friendships WHERE user_id = ? AND friend_id = ?',
      [userId, requesterId]);
    if (mirror) {
      await tx.run("UPDATE friendships SET status = 'accepted' WHERE user_id = ? AND friend_id = ?",
        [userId, requesterId]);
    } else {
      await tx.insert('friendships', {
        user_id: userId, friend_id: requesterId, status: 'accepted', created_at: Date.now(),
      });
    }
  });
  return { accepted: true };
}

export async function removeFriend({ userId, payload }) {
  const db = getDatabase();
  await db.run('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
    [userId, payload.userId, payload.userId, userId]);
  return { removed: true };
}

export async function listFriends(userId, gateway = null) {
  const db = getDatabase();
  const rows = await db.all(`
    SELECT f.friend_id AS id, f.status, u.username
    FROM friendships f JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ? AND u.deleted_at IS NULL`, [userId]);
  const incoming = await db.all(`
    SELECT f.user_id AS id, u.username
    FROM friendships f JOIN users u ON u.id = f.user_id
    WHERE f.friend_id = ? AND f.status = 'pending' AND u.deleted_at IS NULL`, [userId]);

  const online = new Set();
  if (gateway) {
    for (const conn of gateway.connections) {
      if (conn.player?.userId) online.add(String(conn.player.userId));
    }
  }

  return {
    friends: rows.filter((row) => row.status === 'accepted')
      .map((row) => ({ id: row.id, username: row.username, online: online.has(String(row.id)) })),
    outgoing: rows.filter((row) => row.status === 'pending')
      .map((row) => ({ id: row.id, username: row.username })),
    incoming: incoming.map((row) => ({ id: row.id, username: row.username })),
  };
}

export async function blockUser({ userId, payload }) {
  const db = getDatabase();
  const target = await db.get('SELECT id FROM users WHERE username_norm = ?',
    [String(payload.username ?? '').trim().toLowerCase()]);
  if (!target) throw new HttpError(404, 'error.notFound');
  const existing = await db.get('SELECT 1 AS x FROM blocks WHERE user_id = ? AND blocked_id = ?',
    [userId, target.id]);
  if (!existing) {
    await db.insert('blocks', { user_id: userId, blocked_id: target.id, at: Date.now() });
  }
  await db.run('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
    [userId, target.id, target.id, userId]);
  return { blocked: true };
}

export async function unblockUser({ userId, payload }) {
  const db = getDatabase();
  await db.run('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?', [userId, payload.userId]);
  return { unblocked: true };
}

// ---------------------------------------------------------------------------
// convoys
// ---------------------------------------------------------------------------

export async function createConvoy({ instance, characterId, userId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const existing = await tx.get('SELECT convoy_id FROM convoy_members WHERE character_id = ?', [characterId]);
    if (existing) throw new HttpError(409, 'error.conflict', 'you are already in a convoy');

    const id = await tx.insert('convoys', {
      world_id: instance.id, leader_id: characterId,
      name: String(payload.name ?? '').slice(0, 40), created_at: Date.now(),
    });
    await tx.insert('convoy_members', {
      convoy_id: id, character_id: characterId, joined_at: Date.now(),
    });
    return { convoyId: id };
  });
}

export async function joinConvoy({ instance, characterId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const existing = await tx.get('SELECT convoy_id FROM convoy_members WHERE character_id = ?', [characterId]);
    if (existing) throw new HttpError(409, 'error.conflict', 'leave your convoy first');

    const convoy = await tx.get('SELECT * FROM convoys WHERE id = ? AND world_id = ?',
      [payload.convoyId, instance.id]);
    if (!convoy) throw new HttpError(404, 'error.notFound');

    const members = await tx.get('SELECT COUNT(*) AS n FROM convoy_members WHERE convoy_id = ?', [convoy.id]);
    if (Number(members?.n ?? 0) >= 12) throw fail('error.validation', 'that convoy is full');

    await tx.insert('convoy_members', {
      convoy_id: convoy.id, character_id: characterId, joined_at: Date.now(),
    });
    return { convoyId: convoy.id, name: convoy.name };
  });
}

export async function leaveConvoy({ characterId }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const membership = await tx.get('SELECT convoy_id FROM convoy_members WHERE character_id = ?', [characterId]);
    if (!membership) return { left: false };

    await tx.run('DELETE FROM convoy_members WHERE character_id = ?', [characterId]);
    const remaining = await tx.get('SELECT COUNT(*) AS n FROM convoy_members WHERE convoy_id = ?',
      [membership.convoy_id]);
    // An empty convoy disbands rather than lingering as a ghost row.
    if (Number(remaining?.n ?? 0) === 0) {
      await tx.run('DELETE FROM convoys WHERE id = ?', [membership.convoy_id]);
    } else {
      const convoy = await tx.get('SELECT leader_id FROM convoys WHERE id = ?', [membership.convoy_id]);
      if (String(convoy?.leader_id) === String(characterId)) {
        const next = await tx.get(
          'SELECT character_id FROM convoy_members WHERE convoy_id = ? ORDER BY joined_at LIMIT 1',
          [membership.convoy_id]);
        await tx.run('UPDATE convoys SET leader_id = ? WHERE id = ?',
          [next.character_id, membership.convoy_id]);
      }
    }
    return { left: true };
  });
}

export async function convoyFor(characterId, instance = null) {
  const db = getDatabase();
  const membership = await db.get('SELECT convoy_id FROM convoy_members WHERE character_id = ?', [characterId]);
  if (!membership) return null;

  const convoy = await db.get('SELECT * FROM convoys WHERE id = ?', [membership.convoy_id]);
  const members = await db.all(`
    SELECT m.character_id, c.name, c.x, c.y, c.docked
    FROM convoy_members m JOIN characters c ON c.id = m.character_id
    WHERE m.convoy_id = ?`, [membership.convoy_id]);

  return {
    id: convoy.id,
    name: convoy.name,
    leaderId: convoy.leader_id,
    members: members.map((member) => {
      // Prefer the live position when the member is connected.
      const live = instance?.players.get(`p${member.character_id}`);
      return {
        characterId: member.character_id,
        name: member.name,
        x: Math.round(live?.x ?? Number(member.x)),
        y: Math.round(live?.y ?? Number(member.y)),
        online: Boolean(live),
        docked: live ? live.docked : member.docked === 1,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// trading companies
// ---------------------------------------------------------------------------



export async function createGuild({ instance, characterId, userId, payload }) {
  const name = String(payload.name ?? '').trim();
  const tag = String(payload.tag ?? '').trim().toUpperCase();
  if (name.length < 3 || name.length > 40) throw fail('error.validation');
  if (!/^[A-Z0-9]{2,5}$/.test(tag)) throw fail('error.validation', 'tag must be 2-5 letters or digits');

  const db = getDatabase();
  return db.tx(async (tx) => {
    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (Number(character.coins) < FOUNDING_FEE) throw fail('trade.notEnoughCoins');

    const member = await tx.get('SELECT guild_id FROM guild_members WHERE character_id = ?', [characterId]);
    if (member) throw new HttpError(409, 'error.conflict', 'you already belong to a company');

    const taken = await tx.get('SELECT id FROM guilds WHERE world_id = ? AND tag = ?', [instance.id, tag]);
    if (taken) throw new HttpError(409, 'error.conflict', 'that tag is taken');

    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [FOUNDING_FEE, characterId]);
    const guildId = await tx.insert('guilds', {
      world_id: instance.id, name, tag,
      description: String(payload.description ?? '').slice(0, 500),
      founder_id: characterId, treasury: 0, created_at: Date.now(),
    });
    for (const rank of DEFAULT_RANKS) {
      await tx.insert('guild_ranks', {
        guild_id: guildId, key: rank.key, name: rank.name,
        priority: rank.priority, permissions: JSON.stringify(rank.permissions),
      });
    }
    await tx.insert('guild_members', {
      guild_id: guildId, character_id: characterId, rank_key: 'founder', joined_at: Date.now(),
    });
    await audit({ userId }, 'guild.create', 'guild', String(guildId), { name, tag }, { db: tx });

    return { guildId, name, tag, fee: FOUNDING_FEE, coins: Number(character.coins) - FOUNDING_FEE };
  });
}

export async function joinGuild({ instance, characterId, payload }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const member = await tx.get('SELECT guild_id FROM guild_members WHERE character_id = ?', [characterId]);
    if (member) throw new HttpError(409, 'error.conflict', 'leave your company first');

    const guild = await tx.get('SELECT * FROM guilds WHERE id = ? AND world_id = ?',
      [payload.guildId, instance.id]);
    if (!guild) throw new HttpError(404, 'error.notFound');

    await tx.insert('guild_members', {
      guild_id: guild.id, character_id: characterId, rank_key: 'member', joined_at: Date.now(),
    });
    return { guildId: guild.id, name: guild.name, tag: guild.tag };
  });
}

export async function leaveGuild({ characterId }) {
  const db = getDatabase();
  return db.tx(async (tx) => {
    const member = await tx.get('SELECT * FROM guild_members WHERE character_id = ?', [characterId]);
    if (!member) return { left: false };

    const guild = await tx.get('SELECT * FROM guilds WHERE id = ?', [member.guild_id]);
    // The founder cannot simply walk out and leave the treasury ownerless.
    if (String(guild.founder_id) === String(characterId)) {
      const others = await tx.get(
        'SELECT COUNT(*) AS n FROM guild_members WHERE guild_id = ? AND character_id <> ?',
        [guild.id, characterId]);
      if (Number(others?.n ?? 0) > 0) {
        throw fail('error.validation', 'hand the company over before leaving');
      }
      // Last one out: the treasury goes with them and the company dissolves.
      await tx.run('UPDATE characters SET coins = coins + ? WHERE id = ?',
        [Number(guild.treasury), characterId]);
      await tx.run('DELETE FROM guilds WHERE id = ?', [guild.id]);
      return { left: true, disbanded: true, refunded: Number(guild.treasury) };
    }

    await tx.run('DELETE FROM guild_members WHERE character_id = ?', [characterId]);
    return { left: true };
  });
}

async function rankPermissions(tx, guildId, rankKey) {
  const rank = await tx.get('SELECT permissions FROM guild_ranks WHERE guild_id = ? AND key = ?',
    [guildId, rankKey]);
  return new Set(JSON.parse(rank?.permissions || '[]'));
}

export async function depositGuild({ characterId, userId, payload }) {
  const amount = Math.floor(Number(payload.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw fail('error.validation');

  const db = getDatabase();
  return db.tx(async (tx) => {
    const member = await tx.get('SELECT * FROM guild_members WHERE character_id = ?', [characterId]);
    if (!member) throw fail('error.validation', 'you are not in a company');

    const permissions = await rankPermissions(tx, member.guild_id, member.rank_key);
    if (!permissions.has('deposit')) throw new HttpError(403, 'error.forbidden');

    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (Number(character.coins) < amount) throw fail('trade.notEnoughCoins');

    await tx.run('UPDATE characters SET coins = coins - ? WHERE id = ?', [amount, characterId]);
    await tx.run('UPDATE guilds SET treasury = treasury + ? WHERE id = ?', [amount, member.guild_id]);
    const guild = await tx.get('SELECT treasury FROM guilds WHERE id = ?', [member.guild_id]);

    await tx.insert('guild_ledger', {
      guild_id: member.guild_id, character_id: characterId, actor_name: character.name,
      delta: amount, balance: Number(guild.treasury),
      reason: String(payload.reason ?? '').slice(0, 120), at: Date.now(),
    });
    return { treasury: Number(guild.treasury), coins: Number(character.coins) - amount };
  });
}

export async function withdrawGuild({ characterId, userId, payload }) {
  const amount = Math.floor(Number(payload.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw fail('error.validation');

  const db = getDatabase();
  return db.tx(async (tx) => {
    const member = await tx.get('SELECT * FROM guild_members WHERE character_id = ?', [characterId]);
    if (!member) throw fail('error.validation', 'you are not in a company');

    const permissions = await rankPermissions(tx, member.guild_id, member.rank_key);
    if (!permissions.has('withdraw')) throw new HttpError(403, 'error.forbidden');

    const guild = await tx.get('SELECT * FROM guilds WHERE id = ?', [member.guild_id]);
    if (Number(guild.treasury) < amount) throw fail('trade.notEnoughCoins', 'the treasury is short');

    const character = await tx.get('SELECT * FROM characters WHERE id = ?', [characterId]);
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');

    await tx.run('UPDATE guilds SET treasury = treasury - ? WHERE id = ?', [amount, member.guild_id]);
    await tx.run('UPDATE characters SET coins = coins + ? WHERE id = ?', [amount, characterId]);

    await tx.insert('guild_ledger', {
      guild_id: member.guild_id, character_id: characterId, actor_name: character.name,
      delta: -amount, balance: Number(guild.treasury) - amount,
      reason: String(payload.reason ?? '').slice(0, 120), at: Date.now(),
    });
    await audit({ userId }, 'guild.withdraw', 'guild', String(member.guild_id), { amount }, { db: tx });

    return { treasury: Number(guild.treasury) - amount, coins: Number(character.coins) + amount };
  });
}

export async function guildFor(characterId) {
  const db = getDatabase();
  const member = await db.get('SELECT * FROM guild_members WHERE character_id = ?', [characterId]);
  if (!member) return null;

  const guild = await db.get('SELECT * FROM guilds WHERE id = ?', [member.guild_id]);
  const members = await db.all(`
    SELECT m.character_id, m.rank_key, m.joined_at, c.name, c.level
    FROM guild_members m JOIN characters c ON c.id = m.character_id
    WHERE m.guild_id = ? ORDER BY m.joined_at`, [member.guild_id]);
  const ranks = await db.all('SELECT * FROM guild_ranks WHERE guild_id = ? ORDER BY priority DESC',
    [member.guild_id]);
  const ledger = await db.all(
    'SELECT * FROM guild_ledger WHERE guild_id = ? ORDER BY at DESC LIMIT 50', [member.guild_id]);

  return {
    id: guild.id,
    name: guild.name,
    tag: guild.tag,
    description: guild.description,
    treasury: Number(guild.treasury),
    createdAt: Number(guild.created_at),
    yourRank: member.rank_key,
    ranks: ranks.map((rank) => ({
      key: rank.key, name: rank.name, priority: rank.priority,
      permissions: JSON.parse(rank.permissions || '[]'),
    })),
    members: members.map((row) => ({
      characterId: row.character_id, name: row.name,
      rank: row.rank_key, level: Number(row.level), joinedAt: Number(row.joined_at),
    })),
    ledger: ledger.map((row) => ({
      at: Number(row.at), actor: row.actor_name,
      delta: Number(row.delta), balance: Number(row.balance), reason: row.reason,
    })),
  };
}

export async function listGuilds(worldId) {
  const db = getDatabase();
  const rows = await db.all(`
    SELECT g.*, COUNT(m.character_id) AS members
    FROM guilds g LEFT JOIN guild_members m ON m.guild_id = g.id
    WHERE g.world_id = ? GROUP BY g.id ORDER BY members DESC, g.created_at`, [worldId]);
  return rows.map((row) => ({
    id: row.id, name: row.name, tag: row.tag, description: row.description,
    treasury: Number(row.treasury), members: Number(row.members), createdAt: Number(row.created_at),
  }));
}
