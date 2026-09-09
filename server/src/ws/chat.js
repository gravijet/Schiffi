/**
 * Chat.
 *
 * Six channels, all persisted and all moderatable:
 *   global  every player in the world
 *   local   players within earshot on the map
 *   port    players docked in the same port
 *   guild   members of the sender's trading company
 *   convoy  members of the sender's convoy
 *   private one named recipient
 *
 * Messages are stored before they are delivered, so moderation acts on the
 * same rows players saw, and a deletion actually removes it for everyone.
 */
import { getDatabase } from '../db/index.js';
import { MSG } from '@schiffi/shared/net/protocol.js';
import { dist2 } from '@schiffi/shared/util/math.js';
import { HttpError } from '../http/respond.js';

export const CHANNELS = ['global', 'local', 'port', 'guild', 'convoy', 'private'];
const MAX_LENGTH = 400;
const LOCAL_RANGE = 2400;
const LOCAL_RANGE_SQ = LOCAL_RANGE * LOCAL_RANGE;

/** Duplicate-message suppression, per character. */
const lastMessage = new Map();

export function joinChannels(gateway, conn) {
  conn.channels = new Set(['global', 'local', 'port']);
}

export function leaveChannels(gateway, conn) {
  conn.channels = null;
  lastMessage.delete(conn.player?.characterId);
}

export async function handleChat(gateway, conn, message) {
  const db = getDatabase();
  const player = conn.player;
  const channel = String(message.channel ?? 'global');
  if (!CHANNELS.includes(channel)) throw new HttpError(400, 'error.validation', 'unknown channel');

  const body = String(message.body ?? '').trim().slice(0, MAX_LENGTH);
  if (!body) return;

  // Mute check happens per message: a mute takes effect immediately.
  const mute = await db.get(
    'SELECT until, reason FROM chat_mutes WHERE user_id = ? AND until > ? ORDER BY until DESC',
    [player.userId, Date.now()]);
  if (mute) {
    return conn.send({ t: MSG.ERROR, code: 'chat.muted', until: Number(mute.until), reason: mute.reason });
  }

  // Cheap flood guard on top of the gateway's token bucket.
  const previous = lastMessage.get(player.characterId);
  if (previous && previous.body === body && Date.now() - previous.at < 8000) {
    return conn.send({ t: MSG.ERROR, code: 'chat.rateLimited' });
  }
  lastMessage.set(player.characterId, { body, at: Date.now() });

  const instance = conn.instance;
  const mentions = extractMentions(body);
  let scopeId = null;
  let recipients = [];

  switch (channel) {
    case 'global':
      recipients = gateway.connectionsForWorld(instance);
      break;
    case 'local':
      recipients = gateway.connectionsForWorld(instance).filter((c) =>
        c.player && dist2(c.player.x, c.player.y, player.x, player.y) <= LOCAL_RANGE_SQ);
      break;
    case 'port': {
      const portId = await currentPort(db, player.characterId);
      if (!portId) throw new HttpError(400, 'error.notInPort');
      scopeId = portId;
      recipients = [];
      for (const c of gateway.connectionsForWorld(instance)) {
        if (!c.player?.docked) continue;
        const other = await currentPort(db, c.player.characterId);
        if (other === portId) recipients.push(c);
      }
      break;
    }
    case 'guild': {
      const guild = await db.get(
        'SELECT guild_id FROM guild_members WHERE character_id = ?', [player.characterId]);
      if (!guild) throw new HttpError(400, 'error.validation', 'you are not in a company');
      scopeId = String(guild.guild_id);
      const members = await db.all(
        'SELECT character_id FROM guild_members WHERE guild_id = ?', [guild.guild_id]);
      const ids = new Set(members.map((m) => String(m.character_id)));
      recipients = gateway.connectionsForWorld(instance).filter((c) => ids.has(c.player?.characterId));
      break;
    }
    case 'convoy': {
      const convoy = await db.get(
        'SELECT convoy_id FROM convoy_members WHERE character_id = ?', [player.characterId]);
      if (!convoy) throw new HttpError(400, 'error.validation', 'you are not in a convoy');
      scopeId = String(convoy.convoy_id);
      const members = await db.all(
        'SELECT character_id FROM convoy_members WHERE convoy_id = ?', [convoy.convoy_id]);
      const ids = new Set(members.map((m) => String(m.character_id)));
      recipients = gateway.connectionsForWorld(instance).filter((c) => ids.has(c.player?.characterId));
      break;
    }
    case 'private': {
      const target = String(message.to ?? '');
      const targetConn = gateway.connectionsForWorld(instance)
        .find((c) => c.player?.displayName === target || c.player?.characterId === target);
      if (!targetConn) throw new HttpError(404, 'error.notFound', 'player not online');
      scopeId = targetConn.player.characterId;
      recipients = [conn, targetConn];
      break;
    }
    default:
      recipients = [];
  }

  const at = Date.now();
  const id = await db.insert('chat_messages', {
    world_id: instance.id,
    channel,
    scope_id: scopeId,
    user_id: player.userId,
    character_id: player.characterId,
    author_name: player.displayName,
    body,
    reply_to: message.replyTo ?? null,
    mentions: JSON.stringify(mentions),
    at,
  });

  const payload = {
    t: MSG.CHAT,
    id,
    channel,
    scopeId,
    from: player.displayName,
    characterId: player.characterId,
    body,
    replyTo: message.replyTo ?? null,
    mentions,
    at,
  };

  // Blocks are applied on delivery, so a block works without a reconnect.
  const blockedBy = await blockersOf(db, player.userId);
  for (const recipient of recipients) {
    if (!recipient.player) continue;
    if (blockedBy.has(String(recipient.player.userId))) continue;
    recipient.send(payload);
  }
}

async function currentPort(db, characterId) {
  const row = await db.get('SELECT current_port_id, docked FROM characters WHERE id = ?', [characterId]);
  return row && row.docked === 1 ? row.current_port_id : null;
}

async function blockersOf(db, userId) {
  const rows = await db.all('SELECT user_id FROM blocks WHERE blocked_id = ?', [userId]);
  return new Set(rows.map((r) => String(r.user_id)));
}

function extractMentions(body) {
  const out = [];
  for (const match of body.matchAll(/@([\p{L}\p{N}_-]{2,24})/gu)) out.push(match[1]);
  return [...new Set(out)].slice(0, 10);
}

/** Recent history for a channel, used when a client opens the chat panel. */
export async function chatHistory({ worldId, channel, scopeId, limit = 60, before = null }) {
  const db = getDatabase();
  const params = [worldId, channel];
  let sql = 'SELECT * FROM chat_messages WHERE world_id = ? AND channel = ? AND deleted_at IS NULL';
  if (scopeId) { sql += ' AND scope_id = ?'; params.push(scopeId); }
  if (before) { sql += ' AND at < ?'; params.push(before); }
  sql += ' ORDER BY at DESC LIMIT ?';
  params.push(Math.min(200, limit));

  const rows = await db.all(sql, params);
  return rows.reverse().map((r) => ({
    id: r.id,
    channel: r.channel,
    from: r.author_name,
    characterId: r.character_id,
    body: r.body,
    replyTo: r.reply_to,
    mentions: JSON.parse(r.mentions || '[]'),
    at: Number(r.at),
  }));
}
