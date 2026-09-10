/**
 * Accounts, sessions and credentials.
 *
 * Password handling rules that the rest of the codebase relies on:
 *   - passwords are hashed with Argon2id and never stored, logged or returned
 *   - session tokens are stored as SHA-256 hashes, so a database dump does not
 *     hand anyone a working session
 *   - the hash itself is still one-way: nothing here turns password_hash back
 *     into a password.
 *
 * On top of that, this installation is configured to keep a RECOVERABLE copy
 * of the password in an encrypted vault (services/passwordVault.js), because
 * the operator requires a "show password" function in the superadmin console.
 * Logins are still checked against the Argon2id hash and only against it; the
 * vault is a separate, separately keyed copy. See passwordVault.js for what
 * that costs.
 */
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { getDatabase } from '../db/index.js';
import config from '../config.js';
import { invalidateUser } from './rbac.js';
import { sendMail } from '../mail/transport.js';
import { verifyEmailTemplate, passwordResetTemplate, passwordChangedTemplate } from '../mail/templates.js';
import { isValidLocale, DEFAULT_LOCALE } from '@schiffi/shared/i18n/index.js';
import { seal as sealPassword, open as openPassword, vaultEnabled, vaultKeyId } from './passwordVault.js';

const SESSION_BYTES = 32;
const TOKEN_TTL = {
  verify: 24 * 60 * 60 * 1000,
  reset: 2 * 60 * 60 * 1000,
};

const MIN_PASSWORD_LENGTH = 10;
/** Rejected outright: these appear at the top of every breach corpus. */
const BANNED_PASSWORDS = new Set([
  'password', 'passwort', '1234567890', 'qwertyuiop', 'qwertzuiop',
  'letmeinnow', 'iloveyou12', 'adminadmin', 'schiffi123', 'passwort1',
  'password1', '0123456789', 'welcome123', 'changeme12', 'football12',
]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const normEmail = (email) => String(email).trim().toLowerCase();
const normUsername = (name) => String(name).trim().toLowerCase();

function fail(status, code, message = code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function validateEmail(email) {
  const value = String(email ?? '').trim();
  // Deliberately permissive: the verification mail is the real check.
  if (value.length < 5 || value.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}

export function validateUsername(name) {
  return /^[\p{L}\p{N}][\p{L}\p{N} _.-]{1,23}$/u.test(String(name ?? '').trim());
}

/**
 * Password policy. Length first, then obvious weakness; we do not demand
 * symbol classes, which push people towards `Passwort1!` rather than length.
 */
export function validatePassword(password, { email, username } = {}) {
  const value = String(password ?? '');
  if (value.length < MIN_PASSWORD_LENGTH) return 'error.weakPassword';
  if (value.length > 200) return 'error.validation';
  if (BANNED_PASSWORDS.has(value.toLowerCase())) return 'error.weakPassword';
  // Reject a password that contains the account's own name - but only when
  // that name is long enough to be meaningful. A one-letter mail local part
  // ("d@example.org") would otherwise reject almost every password.
  const lower = value.toLowerCase();
  const localPart = email ? normEmail(email).split('@')[0] : '';
  if (localPart.length >= 4 && lower.includes(localPart)) return 'error.weakPassword';
  const name = username ? normUsername(username) : '';
  if (name.length >= 4 && lower.includes(name)) return 'error.weakPassword';
  // A single repeated character or a straight run is not a password.
  if (/^(.)\1+$/.test(value)) return 'error.weakPassword';
  if (/^(?:0123456789|abcdefghij|qwertyuiop)/i.test(value)) return 'error.weakPassword';
  return null;
}

export function hashPassword(password) {
  return argonHash(password, {
    memoryCost: config.security.argon2.memoryCost,
    timeCost: config.security.argon2.timeCost,
    parallelism: config.security.argon2.parallelism,
  });
}

/** Constant-time-ish verification that never leaks whether a user exists. */
async function verifyPassword(storedHash, password) {
  try {
    return await argonVerify(storedHash, password);
  } catch {
    return false;
  }
}

/** A dummy hash so a login for an unknown e-mail costs the same as a real one. */
let dummyHash = null;
async function equaliseTiming(password) {
  if (!dummyHash) dummyHash = await hashPassword(randomBytes(24).toString('hex'));
  await verifyPassword(dummyHash, password);
}

// ---------------------------------------------------------------------------
// rate limiting
// ---------------------------------------------------------------------------

async function recordAttempt(scope, success) {
  const db = getDatabase();
  await db.insert('login_attempts', { scope, at: Date.now(), success: success ? 1 : 0 });
}

async function isThrottled(scope) {
  const db = getDatabase();
  const since = Date.now() - config.security.loginWindowMinutes * 60_000;
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM login_attempts WHERE scope = ? AND success = 0 AND at > ?',
    [scope, since]);
  return Number(row?.n ?? 0) >= config.security.maxLoginAttempts;
}

async function clearAttempts(scope) {
  const db = getDatabase();
  await db.run('DELETE FROM login_attempts WHERE scope = ?', [scope]);
}

// ---------------------------------------------------------------------------
// registration and login
// ---------------------------------------------------------------------------

export async function register({ email, username, password, locale, ip }) {
  const db = getDatabase();
  if (!validateEmail(email)) throw fail(400, 'error.validation', 'invalid email');
  if (!validateUsername(username)) throw fail(400, 'error.validation', 'invalid username');
  const weak = validatePassword(password, { email, username });
  if (weak) throw fail(400, weak, 'weak password');

  const emailNorm = normEmail(email);
  const usernameNorm = normUsername(username);
  const chosenLocale = isValidLocale(locale) ? locale : DEFAULT_LOCALE;

  if (await db.get('SELECT 1 AS x FROM users WHERE email_norm = ?', [emailNorm])) {
    throw fail(409, 'error.emailTaken');
  }
  if (await db.get('SELECT 1 AS x FROM users WHERE username_norm = ?', [usernameNorm])) {
    throw fail(409, 'error.usernameTaken');
  }

  const passwordHash = await hashPassword(password);
  const now = Date.now();
  const userId = await db.insert('users', {
    email: String(email).trim(), email_norm: emailNorm,
    username: String(username).trim(), username_norm: usernameNorm,
    password_hash: passwordHash, password_algo: 'argon2id',
    password_vault: sealPassword(password),
    password_vault_at: vaultEnabled() ? now : null,
    password_vault_key_id: vaultKeyId(),
    locale: chosenLocale, theme: 'auto',
    settings: '{}', created_at: now, updated_at: now,
  });

  // Nobody is promoted by registering. There is no owner role to fall into
  // any more, and the single superadmin is an e-mail address in the server's
  // configuration - registering with it is what makes an account superadmin,
  // and nothing an account does at runtime can change that.

  const token = await issueEmailToken(userId, 'verify');
  const delivery = await sendMail({
    to: String(email).trim(),
    ...verifyEmailTemplate({ locale: chosenLocale, name: String(username).trim(), token }),
  });

  return { userId, verification: delivery };
}

export async function login({ identifier, password, ip, userAgent }) {
  const db = getDatabase();
  const scope = `ip:${ip ?? 'unknown'}`;
  const identScope = `id:${normEmail(identifier)}`;

  if (await isThrottled(scope) || await isThrottled(identScope)) {
    throw fail(429, 'error.rateLimited');
  }

  const key = normEmail(identifier);
  const user = await db.get(
    'SELECT * FROM users WHERE (email_norm = ? OR username_norm = ?) AND deleted_at IS NULL',
    [key, key]);

  if (!user) {
    await equaliseTiming(password);          // same cost as a real check
    await recordAttempt(scope, false);
    await recordAttempt(identScope, false);
    throw fail(401, 'error.badCredentials');
  }

  const ok = await verifyPassword(user.password_hash, password);
  if (!ok) {
    await recordAttempt(scope, false);
    await recordAttempt(identScope, false);
    throw fail(401, 'error.badCredentials');
  }

  if (user.banned_until && Number(user.banned_until) > Date.now()) {
    throw fail(403, 'error.accountBanned', user.ban_reason || 'banned');
  }

  await clearAttempts(identScope);
  await recordAttempt(scope, true);

  const session = await createSession(user.id, ip, userAgent);
  await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [Date.now(), user.id]);

  return { token: session.token, user: publicUser(user), mustResetPassword: user.force_password_reset === 1 };
}

export async function createSession(userId, ip, userAgent) {
  const db = getDatabase();
  const token = randomBytes(SESSION_BYTES).toString('base64url');
  const now = Date.now();
  await db.insert('sessions', {
    user_id: userId,
    token_hash: sha256(token),
    created_at: now,
    last_seen_at: now,
    expires_at: now + config.security.sessionTtlDays * 86_400_000,
    ip: ip ?? null,
    user_agent: (userAgent ?? '').slice(0, 250),
  });
  return { token };
}

/** Resolve a bearer token to a user, or null. Also refreshes last_seen_at. */
export async function resolveSession(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const db = getDatabase();
  const row = await db.get(`
    SELECT s.id AS session_id, s.expires_at, s.revoked_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`, [sha256(token)]);
  if (!row) return null;
  if (row.revoked_at) return null;
  if (Number(row.expires_at) < Date.now()) return null;
  if (row.deleted_at) return null;
  if (row.banned_until && Number(row.banned_until) > Date.now()) return null;

  // Throttle the write: once a minute is plenty for "last seen".
  const now = Date.now();
  if (now - Number(row.last_seen_at ?? 0) > 60_000) {
    await db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [now, row.session_id]);
  }
  return { sessionId: row.session_id, user: publicUser(row) };
}

export async function logout(token) {
  const db = getDatabase();
  await db.run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    [Date.now(), sha256(token)]);
}

export async function listSessions(userId) {
  const db = getDatabase();
  const rows = await db.all(
    'SELECT id, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions ' +
    'WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC',
    [userId, Date.now()]);
  return rows;
}

export async function revokeSession(userId, sessionId, actor) {
  const db = getDatabase();
  await db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?',
    [Date.now(), sessionId, userId]);
}

export async function revokeAllSessions(userId, actor, exceptSessionId = null) {
  const db = getDatabase();
  const params = [Date.now(), userId];
  let sql = 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL';
  if (exceptSessionId) { sql += ' AND id <> ?'; params.push(exceptSessionId); }
  const { changes } = await db.run(sql, params);
  return changes;
}

// ---------------------------------------------------------------------------
// e-mail verification and password reset
// ---------------------------------------------------------------------------

async function issueEmailToken(userId, kind) {
  const db = getDatabase();
  const token = randomBytes(32).toString('base64url');
  // Only one live token per kind: requesting a new one invalidates the old.
  await db.run('UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL',
    [Date.now(), userId, kind]);
  await db.insert('email_tokens', {
    user_id: userId, kind, token_hash: sha256(token),
    created_at: Date.now(), expires_at: Date.now() + TOKEN_TTL[kind],
  });
  return token;
}

async function consumeEmailToken(token, kind) {
  const db = getDatabase();
  const row = await db.get(
    'SELECT * FROM email_tokens WHERE token_hash = ? AND kind = ?', [sha256(token), kind]);
  if (!row || row.used_at || Number(row.expires_at) < Date.now()) return null;
  await db.run('UPDATE email_tokens SET used_at = ? WHERE id = ?', [Date.now(), row.id]);
  return row.user_id;
}

export async function verifyEmail(token) {
  const db = getDatabase();
  const userId = await consumeEmailToken(token, 'verify');
  if (!userId) throw fail(400, 'error.validation', 'invalid or expired token');
  await db.run('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?',
    [Date.now(), Date.now(), userId]);
  return true;
}

export async function resendVerification(userId) {
  const db = getDatabase();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user || user.email_verified_at) return false;
  const token = await issueEmailToken(userId, 'verify');
  await sendMail({ to: user.email, ...verifyEmailTemplate({ locale: user.locale, name: user.username, token }) });
  return true;
}

/**
 * Request a password reset.  Always resolves the same way whether or not the
 * address exists, so this endpoint cannot be used to enumerate accounts.
 */
export async function requestPasswordReset({ email, ip }) {
  const db = getDatabase();
  const user = await db.get('SELECT * FROM users WHERE email_norm = ? AND deleted_at IS NULL',
    [normEmail(email)]);
  if (!user) {
    return { sent: false };
  }
  const token = await issueEmailToken(user.id, 'reset');
  const delivery = await sendMail({
    to: user.email,
    ...passwordResetTemplate({ locale: user.locale, name: user.username, token, hours: 2 }),
  });
  return { sent: true, delivery };
}

/** Reset triggered by staff. Never exposes or changes the password itself. */
export async function triggerPasswordReset(userId, actor) {
  const db = getDatabase();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw fail(404, 'error.notFound');
  const token = await issueEmailToken(user.id, 'reset');
  const delivery = await sendMail({
    to: user.email,
    ...passwordResetTemplate({ locale: user.locale, name: user.username, token, hours: 2, byAdmin: true }),
  });
  await db.run('UPDATE users SET force_password_reset = 1 WHERE id = ?', [userId]);
  return { delivery };
}

export async function resetPassword({ token, newPassword, ip }) {
  const db = getDatabase();
  const userId = await consumeEmailToken(token, 'reset');
  if (!userId) throw fail(400, 'error.validation', 'invalid or expired token');

  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  const weak = validatePassword(newPassword, { email: user.email, username: user.username });
  if (weak) throw fail(400, weak, 'weak password');

  const passwordHash = await hashPassword(newPassword);
  await db.run(
    'UPDATE users SET password_hash = ?, password_algo = ?, password_vault = ?, ' +
    'password_vault_at = ?, password_vault_key_id = ?, force_password_reset = 0, updated_at = ? WHERE id = ?',
    [passwordHash, 'argon2id', sealPassword(newPassword),
      vaultEnabled() ? Date.now() : null, vaultKeyId(), Date.now(), userId]);
  await revokeAllSessions(userId, { userId, ip });
  await sendMail({ to: user.email, ...passwordChangedTemplate({ locale: user.locale, name: user.username }) });
  return true;
}

export async function changePassword({ userId, currentPassword, newPassword, ip, keepSessionId }) {
  const db = getDatabase();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw fail(404, 'error.notFound');
  if (!(await verifyPassword(user.password_hash, currentPassword))) {
    throw fail(401, 'error.badCredentials');
  }
  const weak = validatePassword(newPassword, { email: user.email, username: user.username });
  if (weak) throw fail(400, weak, 'weak password');

  await db.run(
    'UPDATE users SET password_hash = ?, password_vault = ?, password_vault_at = ?, ' +
    'password_vault_key_id = ?, force_password_reset = 0, updated_at = ? WHERE id = ?',
    [await hashPassword(newPassword), sealPassword(newPassword),
      vaultEnabled() ? Date.now() : null, vaultKeyId(), Date.now(), userId]);
  await revokeAllSessions(userId, { userId, ip }, keepSessionId);
  await sendMail({ to: user.email, ...passwordChangedTemplate({ locale: user.locale, name: user.username }) });
  return true;
}

// ---------------------------------------------------------------------------
// account management
// ---------------------------------------------------------------------------

export function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    locale: row.locale,
    theme: row.theme,
    // The client gets a URL, not a file name: the digest in the name makes it
    // cacheable forever, and nothing outside this module needs the path.
    avatar: row.avatar_path ? `/api/users/${row.id}/avatar?v=${String(row.avatar_path).split('-')[1] ?? ''}` : null,
    emailVerified: Boolean(row.email_verified_at),
    createdAt: Number(row.created_at),
    lastLoginAt: row.last_login_at ? Number(row.last_login_at) : null,
    bannedUntil: row.banned_until ? Number(row.banned_until) : null,
  };
}

export async function updateProfile(userId, changes, actor) {
  const db = getDatabase();
  const fields = {};
  if (changes.locale !== undefined) {
    if (!isValidLocale(changes.locale)) throw fail(400, 'error.validation');
    fields.locale = changes.locale;
  }
  if (changes.theme !== undefined) {
    if (!['auto', 'light', 'dark'].includes(changes.theme)) throw fail(400, 'error.validation');
    fields.theme = changes.theme;
  }
  if (changes.username !== undefined) {
    if (!validateUsername(changes.username)) throw fail(400, 'error.validation');
    const norm = normUsername(changes.username);
    const taken = await db.get('SELECT id FROM users WHERE username_norm = ? AND id <> ?', [norm, userId]);
    if (taken) throw fail(409, 'error.usernameTaken');
    fields.username = String(changes.username).trim();
    fields.username_norm = norm;
  }
  if (changes.settings !== undefined) {
    fields.settings = JSON.stringify(changes.settings).slice(0, 20_000);
  }
  if (!Object.keys(fields).length) return false;

  fields.updated_at = Date.now();
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  await db.run(`UPDATE users SET ${sets} WHERE id = ?`, [...Object.values(fields), userId]);
  invalidateUser(userId);
  return true;
}

export async function banUser(userId, { until, reason }, actor) {
  const db = getDatabase();
  await db.run('UPDATE users SET banned_until = ?, ban_reason = ?, updated_at = ? WHERE id = ?',
    [until, reason ?? '', Date.now(), userId]);
  await revokeAllSessions(userId, actor);
}

export async function unbanUser(userId, actor) {
  const db = getDatabase();
  await db.run('UPDATE users SET banned_until = NULL, ban_reason = NULL, updated_at = ? WHERE id = ?',
    [Date.now(), userId]);
}

/**
 * Security status for support staff.
 *
 * Deliberately contains no password material - not the hash, not its length,
 * not a hint - and, just as deliberately, no sign that a recoverable copy
 * exists at all. An administrator reading this must not be able to infer that
 * somebody else can read a password; the vault's status is reported only by
 * routes/superadmin.js, to the one account that may use it.
 */
export async function securityStatus(userId) {
  const db = getDatabase();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw fail(404, 'error.notFound');
  const sessions = await db.get(
    'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?',
    [userId, Date.now()]);
  const failures = await db.get(
    'SELECT COUNT(*) AS n FROM login_attempts WHERE scope = ? AND success = 0 AND at > ?',
    [`id:${user.email_norm}`, Date.now() - 86_400_000]);
  return {
    userId: user.id,
    username: user.username,
    emailVerified: Boolean(user.email_verified_at),
    passwordAlgorithm: user.password_algo,
    forcePasswordReset: user.force_password_reset === 1,
    activeSessions: Number(sessions?.n ?? 0),
    failedLogins24h: Number(failures?.n ?? 0),
    lastLoginAt: user.last_login_at ? Number(user.last_login_at) : null,
    bannedUntil: user.banned_until ? Number(user.banned_until) : null,
    createdAt: Number(user.created_at),
  };
}

/**
 * Read a user's password back out of the vault.
 *
 * The caller must already have checked the permission; this function does the
 * work and reports honestly why it cannot when it cannot. Auditing is the
 * caller's job because only the caller knows the actor and the request IP.
 *
 * Returns { password, reason }: exactly one of the two is set.
 */
export async function revealPassword(userId) {
  const db = getDatabase();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw fail(404, 'error.notFound');

  if (!vaultEnabled()) {
    return { password: null, reason: 'vaultDisabled' };
  }
  if (!user.password_vault) {
    // Set before the vault existed, or cleared by an account deletion.
    return { password: null, reason: 'notStored' };
  }
  if (user.password_vault_key_id !== vaultKeyId()) {
    return { password: null, reason: 'keyRotated' };
  }

  const password = openPassword(user.password_vault);
  if (password === null) return { password: null, reason: 'undecryptable' };

  return { password, reason: null, storedAt: Number(user.password_vault_at ?? 0) };
}

export async function deleteAccount(userId, { password, actor }) {
  const db = getDatabase();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw fail(404, 'error.notFound');
  // Staff-initiated deletion carries no password; self-deletion must prove it.
  if (!actor?.staff) {
    if (!(await verifyPassword(user.password_hash, password))) throw fail(401, 'error.badCredentials');
  }
  await db.tx(async (tx) => {
    // Anonymise rather than delete outright, so chat history and discovery
    // records stay consistent while the personal data goes.
    await tx.run(
      'UPDATE users SET email = ?, email_norm = ?, username = ?, username_norm = ?, ' +
      'password_hash = ?, password_vault = NULL, password_vault_at = NULL, ' +
      'password_vault_key_id = NULL, avatar_path = NULL, settings = ?, ' +
      'deleted_at = ?, updated_at = ? WHERE id = ?',
      [`deleted+${userId}@invalid`, `deleted+${userId}@invalid`,
        `deleted_${userId}`, `deleted_${userId}`,
        `deleted:${randomBytes(16).toString('hex')}`, '{}', Date.now(), Date.now(), userId]);
    await tx.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ?', [Date.now(), userId]);
    await tx.run('DELETE FROM email_tokens WHERE user_id = ?', [userId]);
  });
  invalidateUser(userId);
  return true;
}

/** GDPR-style export: everything the account owns, as plain JSON. */
export async function exportUserData(userId) {
  const db = getDatabase();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw fail(404, 'error.notFound');

  // An allow-list, not a blacklist.
  //
  // This used to strip password_hash and pass everything else through, which
  // meant the day a password_vault column was added the export quietly started
  // handing out the sealed record too. Naming what may leave is the only form
  // of this that survives a schema change.
  const EXPORTED_USER_COLUMNS = [
    'id', 'email', 'username', 'locale', 'theme', 'avatar_path', 'settings',
    'created_at', 'updated_at', 'last_login_at', 'email_verified_at',
    'banned_until', 'ban_reason', 'deleted_at',
  ];
  const safeUser = Object.fromEntries(
    EXPORTED_USER_COLUMNS.filter((column) => column in user).map((column) => [column, user[column]]));
  const characters = await db.all('SELECT * FROM characters WHERE user_id = ?', [userId]);
  const charIds = characters.map((c) => c.id);
  const inList = charIds.length ? charIds.map(() => '?').join(',') : 'NULL';

  const [ships, achievements, tickets, chats, discoveries] = await Promise.all([
    charIds.length ? db.all(`SELECT * FROM ships WHERE character_id IN (${inList})`, charIds) : [],
    db.all('SELECT * FROM user_achievements WHERE user_id = ?', [userId]),
    db.all('SELECT * FROM support_tickets WHERE user_id = ?', [userId]),
    db.all('SELECT id, channel, body, at FROM chat_messages WHERE user_id = ? ORDER BY at DESC LIMIT 5000', [userId]),
    db.all('SELECT * FROM island_discoveries WHERE user_id = ?', [userId]),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    note: 'No password material is included. The login hash is one-way, and the '
      + 'recoverable copy this server keeps for the operator console is not exported '
      + 'either - it would only put another copy of your password on your disk.',
    user: safeUser,
    characters, ships, achievements, tickets, chatMessages: chats, discoveries,
  };
}

/** Housekeeping: drop expired sessions, tokens and old rate-limit rows. */
export async function pruneExpired() {
  const db = getDatabase();
  const now = Date.now();
  await db.run('DELETE FROM sessions WHERE expires_at < ?', [now - 86_400_000]);
  await db.run('DELETE FROM email_tokens WHERE expires_at < ?', [now - 86_400_000]);
  await db.run('DELETE FROM login_attempts WHERE at < ?', [now - 86_400_000]);
}

export { sha256 as hashToken };
