/** Runtime settings editable only from the superadmin console. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getDatabase } from '../db/index.js';
import config from '../config.js';
import { badRequest } from '../http/respond.js';

const SECRET_KEYS = new Set(['mail.pass']);
const MAX_MEDIA_BYTES = 1024 * 1024 * 1024;

function key() {
  return createHash('sha256').update(`schiffi-settings:${config.security.sessionSecret}`).digest();
}

function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function open(value) {
  try {
    const [version, iv, tag, ciphertext] = String(value).split('.');
    if (version !== 'v1') return null;
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final(),
    ]).toString('utf8');
  } catch { return null; }
}

function apply(settingKey, value) {
  switch (settingKey) {
    case 'publicUrl': config.publicUrl = String(value).replace(/\/$/, ''); break;
    case 'mail.host': config.mail.host = String(value); break;
    case 'mail.port': config.mail.port = Number(value); break;
    case 'mail.secure': config.mail.secure = value === true || value === 'true'; break;
    case 'mail.user': config.mail.user = String(value); break;
    case 'mail.pass': config.mail.pass = String(value); break;
    case 'mail.from': config.mail.from = String(value); break;
    case 'game.startingCoins': config.game.startingCoins = Number(value); break;
    case 'game.maxPlayersPerWorld': config.game.maxPlayersPerWorld = Number(value); break;
    case 'game.newbieProtectionMinutes': config.game.newbieProtectionMinutes = Number(value); break;
    case 'game.adRewardCoins': config.game.adRewardCoins = Number(value); break;
    case 'game.adRewardCooldownSeconds': config.game.adRewardCooldownSeconds = Number(value); break;
    case 'uploads.maxMediaBytes': config.uploads.maxMediaBytes = Number(value); break;
    default: break;
  }
}

export async function loadSystemSettings() {
  const rows = await getDatabase().all('SELECT key, value, secret FROM system_settings');
  for (const row of rows) {
    const raw = row.secret ? open(row.value) : row.value;
    if (raw === null) continue;
    let value = raw;
    try { value = JSON.parse(raw); } catch { /* strings written by an older build */ }
    apply(row.key, value);
  }
}

export function currentSystemSettings() {
  return {
    publicUrl: config.publicUrl,
    mail: {
      host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
      user: config.mail.user, passwordConfigured: Boolean(config.mail.pass), from: config.mail.from,
    },
    game: {
      startingCoins: config.game.startingCoins,
      maxPlayersPerWorld: config.game.maxPlayersPerWorld,
      newbieProtectionMinutes: config.game.newbieProtectionMinutes,
      adRewardCoins: config.game.adRewardCoins,
      adRewardCooldownSeconds: config.game.adRewardCooldownSeconds,
    },
    uploads: {
      maxMediaBytes: config.uploads.maxMediaBytes,
      maxMediaMiB: Math.round(config.uploads.maxMediaBytes / 1048576),
    },
  };
}

export async function updateSystemSettings(input, actorUserId) {
  const flat = validate(input);
  const db = getDatabase();
  await db.tx(async (tx) => {
    for (const [settingKey, value] of Object.entries(flat)) {
      const secret = SECRET_KEYS.has(settingKey);
      const encoded = JSON.stringify(value);
      const stored = secret ? seal(encoded) : encoded;
      const existing = await tx.get('SELECT key FROM system_settings WHERE key = ?', [settingKey]);
      if (existing) {
        await tx.run('UPDATE system_settings SET value = ?, secret = ?, updated_at = ?, updated_by = ? WHERE key = ?',
          [stored, secret ? 1 : 0, Date.now(), actorUserId, settingKey]);
      } else {
        await tx.insert('system_settings', {
          key: settingKey, value: stored, secret: secret ? 1 : 0,
          updated_at: Date.now(), updated_by: actorUserId,
        });
      }
      apply(settingKey, value);
    }
  });
  return currentSystemSettings();
}

function validate(input) {
  const out = {};
  if (input.publicUrl !== undefined) {
    let url;
    try { url = new URL(String(input.publicUrl)); } catch { throw badRequest(); }
    if (!['http:', 'https:'].includes(url.protocol)) throw badRequest();
    out.publicUrl = url.toString().replace(/\/$/, '');
  }
  if (input.mail) {
    const mail = input.mail;
    if (mail.host !== undefined) out['mail.host'] = String(mail.host).trim().slice(0, 253);
    if (mail.port !== undefined) {
      const port = Math.trunc(Number(mail.port));
      if (port < 1 || port > 65535) throw badRequest();
      out['mail.port'] = port;
    }
    if (mail.secure !== undefined) out['mail.secure'] = Boolean(mail.secure);
    if (mail.user !== undefined) out['mail.user'] = String(mail.user).trim().slice(0, 320);
    if (mail.pass !== undefined && mail.pass !== '') out['mail.pass'] = String(mail.pass).slice(0, 1000);
    if (mail.from !== undefined) {
      const from = String(mail.from).trim().slice(0, 320);
      if (!from.includes('@')) throw badRequest();
      out['mail.from'] = from;
    }
  }
  if (input.game) {
    const fields = {
      startingCoins: [0, 1_000_000_000],
      maxPlayersPerWorld: [2, 5000],
      newbieProtectionMinutes: [0, 10080],
      adRewardCoins: [0, 1_000_000],
      adRewardCooldownSeconds: [0, 86400],
    };
    for (const [name, [min, max]] of Object.entries(fields)) {
      if (input.game[name] === undefined) continue;
      const value = Math.trunc(Number(input.game[name]));
      if (!Number.isFinite(value) || value < min || value > max) throw badRequest();
      out[`game.${name}`] = value;
    }
  }
  if (input.uploads?.maxMediaMiB !== undefined) {
    const mib = Math.trunc(Number(input.uploads.maxMediaMiB));
    if (!Number.isFinite(mib) || mib < 1 || mib > 1024) throw badRequest();
    out['uploads.maxMediaBytes'] = Math.min(MAX_MEDIA_BYTES, mib * 1048576);
  }
  if (!Object.keys(out).length) throw badRequest();
  return out;
}
