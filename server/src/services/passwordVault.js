/**
 * Recoverable password storage.
 *
 * WHY THIS EXISTS
 * ---------------
 * The operator of this installation requires that the superadmin console can
 * display a user's password. That is a deliberate decision with a real cost,
 * so the mechanism is written down rather than hidden:
 *
 *   - Authentication is UNCHANGED. `users.password_hash` is still Argon2id and
 *     is still the only thing a login is checked against. Breaking the vault
 *     does not help anyone log in any faster than breaking the hash.
 *   - The vault is a SECOND copy of the plaintext, encrypted with AES-256-GCM
 *     under PASSWORD_VAULT_KEY, which lives in the environment and never in
 *     the database. A stolen database dump alone does not open it.
 *   - Anyone holding BOTH the dump and the key holds every password in it.
 *     There is no way to have this feature without that being true.
 *   - Argon2id is one-way, so passwords set before this feature existed can
 *     never be shown. Only a password set or changed after the key was
 *     configured lands in the vault.
 *
 * Every open() is the caller's responsibility to audit; see routes/admin.js.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import config from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

let cachedKey;
let cachedKeyId;

/**
 * The key, as 32 raw bytes.  Accepts 64 hex characters (the documented form)
 * or a base64 string of the same length.  A short or malformed key is refused
 * outright instead of being stretched into something that only looks secure.
 */
function resolveKey() {
  if (cachedKey !== undefined) return cachedKey;

  const raw = (process.env.PASSWORD_VAULT_KEY || '').trim();
  if (!raw) { cachedKey = null; return cachedKey; }

  let bytes = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    bytes = Buffer.from(raw, 'hex');
  } else {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) bytes = decoded;
  }

  if (!bytes) {
    console.error('[vault] PASSWORD_VAULT_KEY must be 64 hex characters or 32 base64 bytes - the vault stays closed');
    cachedKey = null;
    return cachedKey;
  }

  cachedKey = bytes;
  // A short, non-secret fingerprint, so a stored record says which key sealed
  // it. After a key rotation, older records can be reported as unreadable
  // instead of failing with a confusing authentication-tag error.
  cachedKeyId = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  return cachedKey;
}

/** Whether password reveal can work at all on this installation. */
export function vaultEnabled() {
  return resolveKey() !== null;
}

export function vaultKeyId() {
  resolveKey();
  return cachedKeyId ?? null;
}

/**
 * Encrypt a plaintext password for storage.
 * Returns null when no key is configured, in which case the caller stores
 * nothing and the console reports the password as unreadable - honestly.
 */
export function seal(password) {
  const key = resolveKey();
  if (!key) return null;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

/**
 * Decrypt a sealed password.
 * Throws nothing: a missing key, a rotated key or a corrupt record all come
 * back as null, because the caller has to explain the difference to a human
 * either way.
 */
export function open(sealed) {
  const key = resolveKey();
  if (!key || !sealed) return null;

  try {
    const [version, iv, tag, ciphertext] = String(sealed).split('.');
    if (version !== VERSION) return null;

    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;   // wrong key, or the record was tampered with
  }
}

/** Reset the memoised key. Only the tests need this. */
export function resetVaultCache() {
  cachedKey = undefined;
  cachedKeyId = undefined;
}

export default { vaultEnabled, vaultKeyId, seal, open, resetVaultCache };
