/**
 * Administration endpoints.
 *
 * Every route is gated by a granular permission, and every mutation writes to
 * the audit log.
 *
 * One route here returns password material: POST /users/:id/password/reveal,
 * behind `users.password_reveal`. It exists because this installation is
 * operated that way; see services/passwordVault.js for the trade-off it makes.
 * `GET /users/:id/security` still reports status only.
 */
import * as rbac from '../services/rbac.js';
import * as auth from '../services/auth.js';
import { PERMISSIONS } from '../services/permissions.js';
import { readAuditLog, audit } from '../services/audit.js';
import { getDatabase } from '../db/index.js';
import { badRequest, notFound } from '../http/respond.js';

export function registerAdminRoutes(router) {
  // --- permissions and roles ---------------------------------------------
  router.get('/api/admin/permissions', async () => ({
    permissions: PERMISSIONS,
  }), { permission: 'roles.view' });

  router.get('/api/admin/roles', async () => ({
    roles: await rbac.listRoles(),
  }), { permission: 'roles.view' });

  router.post('/api/admin/roles', async (ctx) => {
    const body = await ctx.body();
    const id = await rbac.createRole({
      key: body.key, name: body.name, description: body.description,
      permissions: body.permissions ?? [], priority: body.priority ?? 100,
    }, ctx.actor);
    return { id };
  }, { permission: 'roles.create' });

  router.post('/api/admin/roles/:id/duplicate', async (ctx) => {
    const body = await ctx.body();
    if (!body.key) throw badRequest();
    const id = await rbac.duplicateRole(ctx.params.id, body.key, body.name, ctx.actor);
    return { id };
  }, { permission: 'roles.create' });

  router.patch('/api/admin/roles/:id', async (ctx) => {
    await rbac.updateRole(ctx.params.id, await ctx.body(), ctx.actor);
    return { ok: true };
  }, { permission: 'roles.edit' });

  router.delete('/api/admin/roles/:id', async (ctx) => {
    await rbac.deleteRole(ctx.params.id, ctx.actor);
    return { ok: true };
  }, { permission: 'roles.delete' });

  router.post('/api/admin/users/:userId/roles/:roleId', async (ctx) => {
    await rbac.assignRole(ctx.params.userId, ctx.params.roleId, ctx.actor);
    return { ok: true };
  }, { permission: 'roles.assign' });

  router.delete('/api/admin/users/:userId/roles/:roleId', async (ctx) => {
    await rbac.removeRole(ctx.params.userId, ctx.params.roleId, ctx.actor);
    return { ok: true };
  }, { permission: 'roles.assign' });

  // --- users --------------------------------------------------------------
  router.get('/api/admin/users', async (ctx) => {
    const db = getDatabase();
    const limit = Math.min(200, Math.max(1, Number(ctx.query.limit) || 50));
    const offset = Math.max(0, Number(ctx.query.offset) || 0);
    const search = (ctx.query.q ?? '').trim().toLowerCase();

    const where = search ? 'WHERE email_norm LIKE ? OR username_norm LIKE ?' : '';
    const params = search ? [`%${search}%`, `%${search}%`] : [];
    const rows = await db.all(
      `SELECT id, email, username, locale, created_at, last_login_at, banned_until, email_verified_at, deleted_at
       FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]);
    const total = await db.get(`SELECT COUNT(*) AS n FROM users ${where}`, params);

    return {
      total: Number(total?.n ?? 0),
      users: rows.map((r) => ({
        id: r.id, email: r.email, username: r.username, locale: r.locale,
        createdAt: Number(r.created_at),
        lastLoginAt: r.last_login_at ? Number(r.last_login_at) : null,
        bannedUntil: r.banned_until ? Number(r.banned_until) : null,
        emailVerified: Boolean(r.email_verified_at),
        deleted: Boolean(r.deleted_at),
      })),
    };
  }, { permission: 'users.view' });

  router.get('/api/admin/users/:id', async (ctx) => {
    const db = getDatabase();
    const user = await db.get('SELECT * FROM users WHERE id = ?', [ctx.params.id]);
    if (!user) throw notFound();
    const roles = await db.all(
      'SELECT r.id, r.key, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?',
      [ctx.params.id]);
    const characters = await db.all(
      'SELECT id, world_id, name, coins, level, last_seen_at FROM characters WHERE user_id = ?',
      [ctx.params.id]);
    return { user: auth.publicUser(user), roles, characters };
  }, { permission: 'users.view' });

  /**
   * Security status. Intentionally free of password material - see
   * services/auth.js. The `passwordReadable: false` field is part of the
   * response contract so an operator can see the guarantee, not infer it.
   */
  router.get('/api/admin/users/:id/security', async (ctx) => ({
    status: await auth.securityStatus(ctx.params.id),
  }), { permission: 'users.security_status' });

  /**
   * Show a stored password in clear text.
   *
   * POST, not GET: this must never end up in a browser history entry, a proxy
   * log or a shared URL. The response is marked no-store for the same reason.
   * Every call is written to the audit log BEFORE the value is returned, so a
   * reveal is recorded even if the response never reaches the client.
   */
  router.post('/api/admin/users/:id/password/reveal', async (ctx) => {
    const result = await auth.revealPassword(ctx.params.id);
    await audit(ctx.actor, 'user.password_revealed', 'user', String(ctx.params.id),
      { granted: result.password !== null, reason: result.reason ?? 'ok' });

    ctx.res.setHeader('Cache-Control', 'no-store, max-age=0');
    ctx.res.setHeader('Pragma', 'no-cache');
    return {
      password: result.password,
      reason: result.reason,
      storedAt: result.storedAt ?? null,
    };
  }, { permission: 'users.password_reveal' });

  router.post('/api/admin/users/:id/reset-password', async (ctx) => {
    const result = await auth.triggerPasswordReset(ctx.params.id, ctx.actor);
    return { ok: true, delivery: result.delivery.delivered };
  }, { permission: 'users.reset_password' });

  router.post('/api/admin/users/:id/revoke-sessions', async (ctx) => {
    const count = await auth.revokeAllSessions(ctx.params.id, ctx.actor);
    return { ok: true, revoked: count };
  }, { permission: 'users.revoke_sessions' });

  router.post('/api/admin/users/:id/ban', async (ctx) => {
    const body = await ctx.body();
    const days = Number(body.days ?? 0);
    const until = days > 0 ? Date.now() + days * 86_400_000 : 4_102_444_800_000; // ~2100 = permanent
    await auth.banUser(ctx.params.id, { until, reason: body.reason ?? '' }, ctx.actor);
    return { ok: true, until };
  }, { permission: 'users.ban' });

  router.post('/api/admin/users/:id/unban', async (ctx) => {
    await auth.unbanUser(ctx.params.id, ctx.actor);
    return { ok: true };
  }, { permission: 'users.ban' });

  router.delete('/api/admin/users/:id', async (ctx) => {
    await auth.deleteAccount(ctx.params.id, { actor: { ...ctx.actor, staff: true } });
    return { ok: true };
  }, { permission: 'users.delete' });

  // --- audit --------------------------------------------------------------
  router.get('/api/admin/audit', async (ctx) => ({
    entries: await readAuditLog({
      limit: Number(ctx.query.limit) || 100,
      before: ctx.query.before ? Number(ctx.query.before) : null,
      actorId: ctx.query.actor ?? null,
      action: ctx.query.action ?? null,
    }),
  }), { permission: 'audit.view' });
}
