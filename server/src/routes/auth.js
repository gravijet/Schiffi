/**
 * Authentication and account endpoints.
 *
 * The session token is returned in the body *and* set as an HttpOnly cookie:
 * the cookie is what the browser client uses (so no token ever touches
 * JavaScript-readable storage), the body is there for non-browser clients.
 */
import * as auth from '../services/auth.js';
import { badRequest, unauthorized, notFound } from '../http/respond.js';
import { negotiateLocale } from '@schiffi/shared/i18n/index.js';
import { permissionsFor } from '../services/rbac.js';
import config from '../config.js';
import { storeAvatar, readAvatar, removeAvatar } from '../services/avatars.js';
import { audit } from '../services/audit.js';

const SESSION_COOKIE = 'sid';

function setSessionCookie(ctx, token) {
  ctx.setCookie(SESSION_COOKIE, token, {
    maxAge: config.security.sessionTtlDays * 86_400,
    httpOnly: true,
    sameSite: 'Lax',
  });
}

export function registerAuthRoutes(router) {
  router.post('/api/auth/register', async (ctx) => {
    const body = await ctx.body();
    const locale = body.locale || negotiateLocale(ctx.locale);
    const result = await auth.register({
      email: body.email, username: body.username, password: body.password,
      locale, ip: ctx.ip,
    });
    // Registering signs you in; e-mail verification gates multiplayer, not login.
    const session = await auth.createSession(result.userId, ctx.ip, ctx.req.headers['user-agent']);
    setSessionCookie(ctx, session.token);
    return {
      userId: result.userId,
      token: session.token,
      verificationDelivery: result.verification.delivered,
    };
  }, { auth: false });

  router.post('/api/auth/login', async (ctx) => {
    const body = await ctx.body();
    if (!body.identifier || !body.password) throw badRequest();
    const result = await auth.login({
      identifier: body.identifier, password: body.password,
      ip: ctx.ip, userAgent: ctx.req.headers['user-agent'],
    });
    setSessionCookie(ctx, result.token);
    return result;
  }, { auth: false });

  router.post('/api/auth/logout', async (ctx) => {
    if (ctx.token) await auth.logout(ctx.token);
    ctx.setCookie(SESSION_COOKIE, '', { maxAge: 0 });
    return { ok: true };
  }, { auth: false });

  /**
   * Current session. Answers 200 with `user: null` when signed out rather than
   * 401: this is the "am I signed in?" probe every page load makes, and a 401
   * would fill the browser console with errors for an expected state.
   */
  router.get('/api/auth/me', async (ctx) => {
    if (!ctx.user) return { user: null, roles: [], permissions: [] };
    const { permissions, roles } = await permissionsFor(ctx.user.id);
    return { user: ctx.user, roles, permissions: [...permissions] };
  }, { auth: false });

  router.patch('/api/auth/me', async (ctx) => {
    const body = await ctx.body();
    await auth.updateProfile(ctx.user.id, {
      username: body.username, locale: body.locale, theme: body.theme, settings: body.settings,
    }, ctx.actor);
    return { ok: true };
  });

  // --- avatar ---------------------------------------------------------------

  router.post('/api/auth/avatar', async (ctx) => {
    const buffer = await ctx.rawBody();
    const stored = await storeAvatar(ctx.user.id, buffer);
    await audit(ctx.actor, 'account.avatar_set', 'user', String(ctx.user.id),
      { bytes: stored.bytes });
    return { avatar: `/api/users/${ctx.user.id}/avatar?v=${stored.path.split('-')[1]}` };
  });

  router.delete('/api/auth/avatar', async (ctx) => {
    await removeAvatar(ctx.user.id);
    await audit(ctx.actor, 'account.avatar_cleared', 'user', String(ctx.user.id));
    return { ok: true };
  });

  /**
   * Avatars are public: other players see them in chat and on the leaderboard.
   * The name carries a content digest, so this may be cached hard.
   */
  router.get('/api/users/:id/avatar', async (ctx) => {
    const avatar = await readAvatar(ctx.params.id);
    if (!avatar) throw notFound();
    ctx.res.writeHead(200, {
      'Content-Type': 'image/webp',
      'Content-Length': avatar.data.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    ctx.res.end(avatar.data);
    return undefined;
  }, { auth: false });

  router.post('/api/auth/password', async (ctx) => {
    const body = await ctx.body();
    if (!body.currentPassword || !body.newPassword) throw badRequest();
    await auth.changePassword({
      userId: ctx.user.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      ip: ctx.ip,
      keepSessionId: ctx.sessionId,
    });
    return { ok: true };
  });

  router.post('/api/auth/password/forgot', async (ctx) => {
    const body = await ctx.body();
    if (!body.email) throw badRequest();
    await auth.requestPasswordReset({ email: body.email, ip: ctx.ip });
    // Always the same answer, so the endpoint cannot enumerate accounts.
    return { ok: true, message: 'error.resetSent' };
  }, { auth: false });

  router.post('/api/auth/password/reset', async (ctx) => {
    const body = await ctx.body();
    if (!body.token || !body.newPassword) throw badRequest();
    await auth.resetPassword({ token: body.token, newPassword: body.newPassword, ip: ctx.ip });
    return { ok: true };
  }, { auth: false });

  router.post('/api/auth/email/verify', async (ctx) => {
    const body = await ctx.body();
    if (!body.token) throw badRequest();
    await auth.verifyEmail(body.token);
    return { ok: true };
  }, { auth: false });

  router.post('/api/auth/email/resend', async (ctx) => {
    const sent = await auth.resendVerification(ctx.user.id);
    return { ok: true, sent };
  });

  router.get('/api/auth/sessions', async (ctx) => ({
    sessions: (await auth.listSessions(ctx.user.id)).map((s) => ({
      id: s.id,
      current: s.id === ctx.sessionId,
      createdAt: Number(s.created_at),
      lastSeenAt: Number(s.last_seen_at),
      expiresAt: Number(s.expires_at),
      ip: s.ip,
      userAgent: s.user_agent,
    })),
  }));

  router.delete('/api/auth/sessions/:id', async (ctx) => {
    await auth.revokeSession(ctx.user.id, ctx.params.id, ctx.actor);
    return { ok: true };
  });

  router.post('/api/auth/sessions/revoke-all', async (ctx) => {
    const count = await auth.revokeAllSessions(ctx.user.id, ctx.actor, ctx.sessionId);
    return { ok: true, revoked: count };
  });

  router.get('/api/auth/export', async (ctx) => {
    const data = await auth.exportUserData(ctx.user.id);
    ctx.res.setHeader('Content-Disposition', `attachment; filename="schiffi-export-${ctx.user.id}.json"`);
    return data;
  });

  router.post('/api/auth/delete', async (ctx) => {
    const body = await ctx.body();
    if (!body.password) throw badRequest();
    await auth.deleteAccount(ctx.user.id, { password: body.password, actor: ctx.actor });
    ctx.setCookie(SESSION_COOKIE, '', { maxAge: 0 });
    return { ok: true };
  });
}

export { SESSION_COOKIE };
