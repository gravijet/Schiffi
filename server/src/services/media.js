/** Streamed advert media storage (images and video). */
import { mkdir, writeFile, readFile, appendFile, unlink, open, rename, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import config from '../config.js';
import { HttpError } from '../http/respond.js';

export const MEDIA_DIR = join(config.uploads.dir, 'ads');
export const MAX_MEDIA_BYTES = 1024 * 1024 * 1024; // public contract: 1 GiB
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const pendingUploads = new Map();

const SIGNATURES = [
  { ext: '.webp', type: 'image/webp', kind: 'image', test: (b) => b.length > 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { ext: '.png', type: 'image/png', kind: 'image', test: (b) => b.length > 8 && b.toString('hex', 0, 8) === '89504e470d0a1a0a' },
  { ext: '.jpg', type: 'image/jpeg', kind: 'image', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.webm', type: 'video/webm', kind: 'video', test: (b) => b.length > 4 && b.toString('hex', 0, 4) === '1a45dfa3' },
  { ext: '.mp4', type: 'video/mp4', kind: 'video', test: (b) => b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp' && b.toString('ascii', 8, 12) !== 'qt  ' },
  { ext: '.mov', type: 'video/quicktime', kind: 'video', test: (b) => b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp' && b.toString('ascii', 8, 12) === 'qt  ' },
];

export function sniff(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  return SIGNATURES.find((entry) => entry.test(buffer)) ?? null;
}

export function mediaInfo(name) {
  const ext = extname(String(name ?? '')).toLowerCase();
  return SIGNATURES.find((entry) => entry.ext === ext) ?? null;
}

export function mediaType(name) { return mediaInfo(name)?.type ?? 'application/octet-stream'; }
export function mediaKind(name) { return mediaInfo(name)?.kind ?? null; }

function assertSize(size) {
  const configured = Number(config.uploads.maxMediaBytes) || MAX_MEDIA_BYTES;
  const limit = Math.min(MAX_MEDIA_BYTES, configured);
  if (size > limit) {
    throw new HttpError(413, 'ads.imageTooLarge', 'advert media is limited to 1 GiB');
  }
}

/** Kept for small programmatic uploads and unit tests. */
export async function storeMedia(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HttpError(400, 'error.validation', 'no media was sent');
  }
  assertSize(buffer.length);
  const format = sniff(buffer);
  if (!format) throw new HttpError(400, 'ads.imageFormat', 'use WebP, PNG, JPEG, MP4, WebM or MOV');

  await mkdir(MEDIA_DIR, { recursive: true });
  const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 20);
  const name = `${digest}${format.ext}`;
  await writeFile(join(MEDIA_DIR, name), buffer);
  return { path: name, bytes: buffer.length, type: format.type, kind: format.kind };
}

/**
 * Stream a potentially large upload to disk while hashing and enforcing the
 * limit. Only the first 32 bytes are read back for format validation, so a
 * 1 GiB video never becomes a 1 GiB Buffer in the Node process.
 */
export async function storeMediaStream(readable, contentLength) {
  if (contentLength !== undefined) assertSize(Number(contentLength) || 0);
  await mkdir(MEDIA_DIR, { recursive: true });
  const temporary = join(MEDIA_DIR, `.upload-${randomBytes(12).toString('hex')}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      try { assertSize(bytes); } catch (error) { callback(error); return; }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(readable, meter, createWriteStream(temporary, { flags: 'wx' }));
    if (bytes === 0) throw new HttpError(400, 'error.validation', 'no media was sent');

    const handle = await open(temporary, 'r');
    const head = Buffer.alloc(32);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    await handle.close();
    const format = sniff(head.subarray(0, bytesRead));
    if (!format) throw new HttpError(400, 'ads.imageFormat', 'use WebP, PNG, JPEG, MP4, WebM or MOV');

    const name = `${hash.digest('hex').slice(0, 20)}${format.ext}`;
    const destination = join(MEDIA_DIR, name);
    await rename(temporary, destination).catch(async (error) => {
      if (await stat(destination).catch(() => null)) await unlink(temporary).catch(() => {});
      else throw error;
    });
    return { path: name, bytes, type: format.type, kind: format.kind };
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Receive either one ordinary request or one resumable upload chunk.
 *
 * Production sits behind proxies with much smaller per-request limits than
 * the 1 GiB media limit. The browser therefore sends large files as chunks;
 * only after every byte arrived do we validate, hash and publish the file.
 */
export async function storeMediaUpload(readable, {
  contentLength, contentRange, uploadId, scope,
} = {}) {
  if (!contentRange) return { ...(await storeMediaStream(readable, contentLength)), complete: true };

  prunePendingUploads();
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(contentRange));
  if (!match) throw new HttpError(400, 'error.validation', 'invalid Content-Range');
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  const expected = end - start + 1;
  if (![start, end, total, expected].every(Number.isSafeInteger)
      || start < 0 || end < start || end >= total || total < 1) {
    throw new HttpError(400, 'error.validation', 'invalid Content-Range');
  }
  assertSize(total);
  if (expected > MAX_CHUNK_BYTES || Number(contentLength) !== expected) {
    throw new HttpError(413, 'error.validation', 'invalid media chunk size');
  }

  let state;
  if (uploadId) {
    state = pendingUploads.get(String(uploadId));
    if (!state || state.scope !== scope || state.total !== total) {
      throw new HttpError(404, 'error.notFound', 'upload not found');
    }
  } else {
    if (start !== 0) throw new HttpError(409, 'error.conflict', 'the first chunk must start at zero');
    const id = randomBytes(18).toString('base64url');
    state = { id, scope, total, received: 0, parts: new Map(), touchedAt: Date.now(), finalizing: false };
    pendingUploads.set(id, state);
  }

  if (state.parts.has(start)) {
    return { complete: false, uploadId: state.id, received: state.received, total };
  }

  const partPath = join(MEDIA_DIR, `.upload-${state.id}-${start}.part`);
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > expected) callback(new HttpError(413, 'error.validation', 'media chunk is too large'));
      else callback(null, chunk);
    },
  });
  await mkdir(MEDIA_DIR, { recursive: true });
  try {
    await pipeline(readable, meter, createWriteStream(partPath, { flags: 'wx' }));
    if (bytes !== expected) throw new HttpError(400, 'error.validation', 'media chunk is incomplete');
  } catch (error) {
    await unlink(partPath).catch(() => {});
    throw error;
  }

  state.parts.set(start, { path: partPath, start, end, bytes });
  state.received += bytes;
  state.touchedAt = Date.now();
  if (state.received < total) {
    return { complete: false, uploadId: state.id, received: state.received, total };
  }
  if (state.finalizing) throw new HttpError(409, 'error.conflict', 'upload is already finishing');
  state.finalizing = true;

  let combined = null;
  try {
    const parts = [...state.parts.values()].sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const part of parts) {
      if (part.start !== cursor) throw new HttpError(409, 'error.conflict', 'media upload has a gap');
      cursor = part.end + 1;
    }
    if (cursor !== total) throw new HttpError(409, 'error.conflict', 'media upload is incomplete');

    combined = join(MEDIA_DIR, `.upload-${state.id}.complete`);
    const hash = createHash('sha256');
    for (const part of parts) {
      const data = await readFile(part.path);
      hash.update(data);
      await appendFile(combined, data);
      // Keep peak disk use near the file size instead of retaining a second
      // full copy of a 1 GiB upload while it is assembled.
      await unlink(part.path).catch(() => {});
    }
    const stored = await publishTemporary(combined, hash, total);
    combined = null;
    return { ...stored, complete: true };
  } catch (error) {
    if (combined) await unlink(combined).catch(() => {});
    throw error;
  } finally {
    pendingUploads.delete(state.id);
    await Promise.all([...state.parts.values()].map((part) => unlink(part.path).catch(() => {})));
  }
}

async function publishTemporary(temporary, hash, bytes) {
  try {
    const handle = await open(temporary, 'r');
    const head = Buffer.alloc(32);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    await handle.close();
    const format = sniff(head.subarray(0, bytesRead));
    if (!format) throw new HttpError(400, 'ads.imageFormat', 'use WebP, PNG, JPEG, MP4, WebM or MOV');

    const name = `${hash.digest('hex').slice(0, 20)}${format.ext}`;
    const destination = join(MEDIA_DIR, name);
    await rename(temporary, destination).catch(async (error) => {
      if (await stat(destination).catch(() => null)) await unlink(temporary).catch(() => {});
      else throw error;
    });
    return { path: name, bytes, type: format.type, kind: format.kind };
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function prunePendingUploads() {
  const staleBefore = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, state] of pendingUploads) {
    if (state.touchedAt >= staleBefore) continue;
    pendingUploads.delete(id);
    for (const part of state.parts.values()) unlink(part.path).catch(() => {});
  }
}

export async function readMedia(name) {
  if (!/^[0-9a-f]{20}\.(webp|png|jpg|webm|mp4|mov)$/.test(String(name ?? ''))) return null;
  const filePath = join(MEDIA_DIR, name);
  if (!resolve(filePath).startsWith(resolve(MEDIA_DIR))) return null;
  const info = await stat(filePath).catch(() => null);
  return info?.isFile() ? {
    path: filePath, size: info.size, type: mediaType(name),
    stream: (options) => createReadStream(filePath, options),
  } : null;
}

export async function removeMedia(name) {
  if (!/^[0-9a-f]{20}\.(webp|png|jpg|webm|mp4|mov)$/.test(String(name ?? ''))) return;
  await unlink(join(MEDIA_DIR, name)).catch(() => {});
}
