/**
 * The superadmin surface.
 *
 * Two rules govern this file, and they are the reason it is separate from
 * routes/admin.js rather than a few extra permissions inside it:
 *
 *   1. Only one account reaches it - the address in config.superadmin.email.
 *      No role grants it, no permission implies it, nothing an administrator
 *      can edit affects it.
 *   2. To everybody else it does not exist. Every route answers 404, the same
 *      answer an invented path gets, whether the caller is signed out, signed
 *      in, or an administrator holding every permission there is. A 401 or a
 *      403 would confirm the address, which is exactly what must not happen.
 *
 * The console's own HTML is served from here too, for the same reason: it is
 * not in the static build's index, so there is no link, no chunk name and no
 * asset an administrator could stumble over.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as auth from '../services/auth.js';
import { isSuperadmin } from '../services/rbac.js';
import { getDatabase } from '../db/index.js';
import { notFound, badRequest } from '../http/respond.js';
import { vaultEnabled, vaultKeyId } from '../services/passwordVault.js';
import { storeMediaUpload } from '../services/media.js';
import * as interstitial from '../services/interstitial.js';
import config from '../config.js';
import { currentSystemSettings, updateSystemSettings } from '../services/systemSettings.js';
import { sendMail } from '../mail/transport.js';

const trim = (value, max) => String(value ?? '').trim().slice(0, max);

/** A URL we are willing to send a visitor to: http(s) only, absolute. */
function safeUrl(value) {
  const raw = trim(value, 500);
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { throw badRequest('error.validation'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('error.validation');
  return url.toString();
}

export function registerSuperadminRoutes(router, { staticRoot } = {}) {
  /**
   * The console page.
   *
   * `auth: false` because the guard here is not "are you signed in" but "are
   * you that one account", and the answer for everyone else has to be the
   * ordinary application shell - the same thing /anything-else returns - so
   * the address gives nothing away.
   */
  router.get('/superadmin', async (ctx) => {
    const superadmin = ctx.user ? await isSuperadmin(ctx.user.id) : false;
    const file = superadmin ? 'console.html' : 'index.html';
    const html = await readFile(join(staticRoot, file), 'utf8').catch(() => null);
    if (html === null) throw notFound();
    ctx.res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // The console must never be framed, and must never be indexed.
      'X-Robots-Tag': 'noindex, nofollow',
    });
    ctx.res.end(html);
    return undefined;
  }, { auth: false });

  const sa = (path, method, handler) => {
    router[method](path, async (ctx) => {
      if (!ctx.user || !(await isSuperadmin(ctx.user.id))) throw notFound();
      return handler(ctx);
    }, { auth: false });
  };

  // --- overview -----------------------------------------------------------

  sa('/api/superadmin/overview', 'get', async () => {
    const db = getDatabase();
    const users = await db.get('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL');
    const characters = await db.get('SELECT COUNT(*) AS n FROM characters WHERE deleted_at IS NULL');
    const sessions = await db.get(
      'SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?', [Date.now()]);
    const readable = await db.get(
      'SELECT COUNT(*) AS n FROM users WHERE password_vault IS NOT NULL AND deleted_at IS NULL');
    return {
      superadminEmail: config.superadmin.email,
      vault: {
        enabled: vaultEnabled(),
        keyId: vaultKeyId(),
        readableAccounts: Number(readable?.n ?? 0),
      },
      counts: {
        users: Number(users?.n ?? 0),
        characters: Number(characters?.n ?? 0),
        activeSessions: Number(sessions?.n ?? 0),
      },
      mailConfigured: Boolean(config.mail.host),
    };
  });

  sa('/api/superadmin/settings', 'get', async () => ({ settings: currentSystemSettings() }));

  sa('/api/superadmin/settings', 'patch', async (ctx) => ({
    settings: await updateSystemSettings(await ctx.body(), ctx.user.id),
  }));

  sa('/api/superadmin/settings/test-mail', 'post', async (ctx) => {
    const body = await ctx.body();
    const to = trim(body.to || ctx.user.email, 254);
    if (!to.includes('@')) throw badRequest();
    const delivery = await sendMail({
      to, subject: 'Schiffi SMTP-Test',
      text: 'Diese Nachricht bestätigt, dass die E-Mail-Konfiguration im Leitstand funktioniert.',
      html: '<p>Diese Nachricht bestätigt, dass die E-Mail-Konfiguration im Leitstand funktioniert.</p>',
      locale: 'de',
    });
    return { delivered: delivery.delivered };
  });

  // --- password reveal ----------------------------------------------------

  /**
   * Show a stored password in clear text.
   *
   * POST, not GET: this must never end up in a browser history entry, a proxy
   * log or a shared URL, and the response is marked no-store for the same
   * reason. It reports honestly when it cannot - an account whose password
   * predates the vault key is gone for good, Argon2id being one-way.
   */
  sa('/api/superadmin/users/:id/password', 'post', async (ctx) => {
    const result = await auth.revealPassword(ctx.params.id);
    ctx.res.setHeader('Cache-Control', 'no-store, max-age=0');
    ctx.res.setHeader('Pragma', 'no-cache');
    return {
      password: result.password,
      reason: result.reason,
      storedAt: result.storedAt ?? null,
    };
  });

  // --- the advert shown before the site -----------------------------------

  sa('/api/superadmin/interstitials', 'get', async () => ({
    interstitials: await interstitial.listInterstitials(),
  }));

  sa('/api/superadmin/interstitials', 'post', async (ctx) => {
    const body = await ctx.body();
    const headline = trim(body.headline, 120);
    if (headline.length < 2) throw badRequest('error.validation');
    const id = await interstitial.createInterstitial({
      headline,
      body: trim(body.body, 600),
      targetUrl: safeUrl(body.targetUrl),
      seconds: Math.min(30, Math.max(0, Number(body.seconds) || 5)),
      imagePath: null,
    }, ctx.user.id);
    return { id };
  });

  sa('/api/superadmin/interstitials/:id', 'patch', async (ctx) => {
    const body = await ctx.body();
    const fields = {};
    if (body.headline !== undefined) fields.headline = trim(body.headline, 120);
    if (body.body !== undefined) fields.body = trim(body.body, 600);
    if (body.targetUrl !== undefined) fields.targetUrl = safeUrl(body.targetUrl);
    if (body.seconds !== undefined) fields.seconds = Math.min(30, Math.max(0, Number(body.seconds) || 0));
    await interstitial.updateInterstitial(ctx.params.id, fields);
    if (body.active !== undefined) await interstitial.setActive(body.active ? ctx.params.id : null);
    return { ok: true };
  });

  /** Image or video, streamed with the id in the path. */
  sa('/api/superadmin/interstitials/:id/image', 'post', async (ctx) => {
    const stored = await storeMediaUpload(ctx.req, {
      contentLength: ctx.req.headers['content-length'],
      contentRange: ctx.req.headers['content-range'],
      uploadId: ctx.req.headers['x-upload-id'],
      scope: `interstitial:${ctx.params.id}:user:${ctx.user.id}`,
    });
    if (!stored.complete) return stored;
    await interstitial.updateInterstitial(ctx.params.id, { imagePath: stored.path });
    return { media: `/media/ads/${stored.path}`, kind: stored.kind, complete: true };
  });

  sa('/api/superadmin/interstitials/:id', 'delete', async (ctx) => {
    await interstitial.deleteInterstitial(ctx.params.id);
    return { ok: true };
  });

  // --- roles a superadmin grants but never appears in ----------------------

  sa('/api/superadmin/users/:id/roles', 'get', async (ctx) => {
    const db = getDatabase();
    const rows = await db.all(
      'SELECT r.id, r.key, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?',
      [ctx.params.id]);
    return { roles: rows };
  });
}
