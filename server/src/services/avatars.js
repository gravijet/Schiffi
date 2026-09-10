/**
 * Avatar storage.
 *
 * The image arrives already encoded as WebP, at the size it will be shown:
 * the browser has a perfectly good WebP encoder and a canvas to resize with,
 * so doing it there costs the server nothing and hands it a small file. What
 * the server does is refuse to trust that claim - it checks the bytes are
 * really a WebP RIFF and that the file is small enough, and it stores it under
 * a name it chose itself rather than one the client supplied.
 */
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import config from '../config.js';
import { getDatabase } from '../db/index.js';
import { HttpError } from '../http/respond.js';

const AVATAR_DIR = join(config.uploads.dir, 'avatars');

/**
 * Is this really a WebP file?
 *
 * "RIFF" + 4 size bytes + "WEBP". Checking the magic rather than trusting the
 * Content-Type means a renamed executable is refused, not stored and served
 * back to other players.
 */
export function isWebp(buffer) {
  return buffer.length > 16
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP';
}

export async function storeAvatar(userId, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HttpError(400, 'error.validation', 'no image was sent');
  }
  if (buffer.length > config.uploads.maxAvatarBytes) {
    throw new HttpError(413, 'profile.avatarTooLarge',
      `avatars are limited to ${Math.round(config.uploads.maxAvatarBytes / 1024)} KiB`);
  }
  if (!isWebp(buffer)) {
    throw new HttpError(400, 'profile.avatarFormat', 'the image must be WebP');
  }

  await mkdir(AVATAR_DIR, { recursive: true });
  // The name is derived from the content, so replacing an avatar produces a
  // new URL and no cache anywhere serves the old picture.
  const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const name = `${userId}-${digest}.webp`;
  await writeFile(join(AVATAR_DIR, name), buffer);

  const db = getDatabase();
  const previous = await db.get('SELECT avatar_path FROM users WHERE id = ?', [userId]);
  await db.run('UPDATE users SET avatar_path = ?, updated_at = ? WHERE id = ?',
    [name, Date.now(), userId]);

  // Drop the old file: an avatar nobody references is just disk.
  if (previous?.avatar_path && previous.avatar_path !== name) {
    await unlink(join(AVATAR_DIR, previous.avatar_path)).catch(() => {});
  }
  return { path: name, bytes: buffer.length };
}

/** Read one back for serving. Only ever by the stored name, never by input. */
export async function readAvatar(userId) {
  const db = getDatabase();
  const row = await db.get('SELECT avatar_path FROM users WHERE id = ? AND deleted_at IS NULL',
    [userId]);
  if (!row?.avatar_path) return null;

  // The name came from storeAvatar, but check anyway: a path that escapes the
  // directory must never be readable, whatever put it in the column.
  const filePath = join(AVATAR_DIR, row.avatar_path);
  if (!resolve(filePath).startsWith(resolve(AVATAR_DIR))) return null;

  const data = await readFile(filePath).catch(() => null);
  return data ? { data, name: row.avatar_path } : null;
}

export async function removeAvatar(userId) {
  const db = getDatabase();
  const row = await db.get('SELECT avatar_path FROM users WHERE id = ?', [userId]);
  if (row?.avatar_path) {
    await unlink(join(AVATAR_DIR, row.avatar_path)).catch(() => {});
  }
  await db.run('UPDATE users SET avatar_path = NULL, updated_at = ? WHERE id = ?',
    [Date.now(), userId]);
}
