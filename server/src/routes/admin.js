/**
 * Administration endpoints.
 *
 * Every route is gated by a granular permission from services/permissions.js,
 * and that catalogue is the whole world as far as this file is concerned.
 * Nothing here can reach a superadmin-only ability, and nothing here mentions
 * that such abilities exist - reading a password, for instance, lives in
 * routes/superadmin.js and answers 404 to everyone else.
 *
 * There is no audit trail. It was removed on the operator's instruction; the
 * consequence is that these actions leave no record of who performed them.
 */
import * as rbac from '../services/rbac.js';
import * as auth from '../services/auth.js';
import { PERMISSIONS } from '../services/permissions.js';
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
    });
    return { id };
  }, { permission: 'roles.create' });

  router.post('/api/admin/roles/:id/duplicate', async (ctx) => {
    const body = await ctx.body();
    if (!body.key) throw badRequest();
    const id = await rbac.duplicateRole(ctx.params.id, body.key, body.name);
    return { id };
  }, { permission: 'roles.create' });

  router.patch('/api/admin/roles/:id', async (ctx) => {
    await rbac.updateRole(ctx.params.id, await ctx.body());
    return { ok: true };
  }, { permission: 'roles.edit' });

  router.delete('/api/admin/roles/:id', async (ctx) => {
    await rbac.deleteRole(ctx.params.id);
    return { ok: true };
  }, { permission: 'roles.delete' });

  router.post('/api/admin/users/:userId/roles/:roleId', async (ctx) => {
    await rbac.assignRole(ctx.params.userId, ctx.params.roleId, ctx.actor);
    return { ok: true };
  }, { permission: 'roles.assign' });

  router.delete('/api/admin/users/:userId/roles/:roleId', async (ctx) => {
    await rbac.removeRole(ctx.params.userId, ctx.params.roleId);
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
   * Security status: when the account last signed in, how many sessions it
   * has, whether it is locked out. No password material of any kind, and no
   * field that would betray that reading one is possible elsewhere.
   */
  router.get('/api/admin/users/:id/security', async (ctx) => ({
    status: await auth.securityStatus(ctx.params.id),
  }), { permission: 'users.security_status' });

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
}
