/**
 * Advert images.
 *
 * Avatars have their own module because they hang off a user row; adverts and
 * interstitials just need a file on disk with a name the server chose. The
 * rules are the same ones that matter: the bytes are checked against the
 * format's magic number rather than a Content-Type the client made up, the
 * size is capped, and the stored name is derived from the content so replacing
 * an image can never be served from a stale cache.
 */
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import config from '../config.js';
import { HttpError } from '../http/respond.js';

export const MEDIA_DIR = join(config.uploads.dir, 'ads');
export const MAX_MEDIA_BYTES = 1024 * 1024; // 1 MiB

const SIGNATURES = [
  { ext: '.webp', type: 'image/webp', test: (b) => b.length > 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { ext: '.png', type: 'image/png', test: (b) => b.length > 8 && b.toString('hex', 0, 8) === '89504e470d0a1a0a' },
  { ext: '.jpg', type: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

/** The format these bytes actually are, or null when they are none of them. */
export function sniff(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  return SIGNATURES.find((s) => s.test(buffer)) ?? null;
}

export function mediaType(name) {
  const ext = extname(String(name ?? '')).toLowerCase();
  return SIGNATURES.find((s) => s.ext === ext)?.type ?? 'application/octet-stream';
}

export async function storeMedia(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HttpError(400, 'error.validation', 'no image was sent');
  }
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new HttpError(413, 'ads.imageTooLarge',
      `advert images are limited to ${Math.round(MAX_MEDIA_BYTES / 1024)} KiB`);
  }
  const format = sniff(buffer);
  if (!format) throw new HttpError(400, 'ads.imageFormat', 'the image must be WebP, PNG or JPEG');

  await mkdir(MEDIA_DIR, { recursive: true });
  const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 20);
  const name = `${digest}${format.ext}`;
  await writeFile(join(MEDIA_DIR, name), buffer);
  return { path: name, bytes: buffer.length, type: format.type };
}

/** Read one back for serving. Only ever by a stored name, never by raw input. */
export async function readMedia(name) {
  if (!/^[0-9a-f]{20}\.(webp|png|jpg)$/.test(String(name ?? ''))) return null;
  const filePath = join(MEDIA_DIR, name);
  if (!resolve(filePath).startsWith(resolve(MEDIA_DIR))) return null;
  const data = await readFile(filePath).catch(() => null);
  return data ? { data, type: mediaType(name) } : null;
}

/**
 * Delete a file no row references any more.
 *
 * Two adverts can legitimately carry the same image - the name is the content
 * hash - so the caller must have checked that this was the last reference.
 */
export async function removeMedia(name) {
  if (!/^[0-9a-f]{20}\.(webp|png|jpg)$/.test(String(name ?? ''))) return;
  await unlink(join(MEDIA_DIR, name)).catch(() => {});
}
