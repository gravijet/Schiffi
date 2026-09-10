/**
 * Role-based access control.
 *
 * Roles live in the database so they can be created, renamed, duplicated,
 * deactivated and deleted at runtime.  Permission *keys* are code-defined, so
 * a role can never grant an ability the server does not implement.
 *
 * Above all of that sits exactly one account, and it is deliberately outside
 * the model: the superadmin is whoever holds config.superadmin.email. It has
 * no role, no wildcard permission and no row of its own, so an administrator
 * reading the roles table, the permissions table or another account's role
 * list finds nothing that hints a higher level exists. That is a requirement
 * here, not a nicety - see routes/superadmin.js for the other half of it.
 *
 * A short-lived cache keeps the hot path (one permission check per request)
 * off the database; it is invalidated on every write.
 */
import { PERMISSIONS, PERMISSION_KEYS, BOOTSTRAP_ROLES, isKnownPermission } from './permissions.js';
import { getDatabase } from '../db/index.js';
import config from '../config.js';

const CACHE_TTL_MS = 30_000;
const cache = new Map(); // userId -> { at, permissions: Set, roles: [], superadmin: bool }

export function invalidateUser(userId) {
  cache.delete(String(userId));
}
export function invalidateAll() {
  cache.clear();
}

/** Insert new permission keys and create the bootstrap roles once. */
export async function syncPermissions() {
  const db = getDatabase();
  const existing = new Set((await db.all('SELECT key FROM permissions')).map((r) => r.key));

  for (const perm of PERMISSIONS) {
    if (existing.has(perm.key)) {
      await db.run('UPDATE permissions SET category = ?, description = ? WHERE key = ?',
        [perm.category, perm.description, perm.key]);
    } else {
      await db.insert('permissions', perm);
    }
  }

  for (const role of BOOTSTRAP_ROLES) {
    const found = await db.get('SELECT id FROM roles WHERE key = ?', [role.key]);
    if (found) continue;
    const now = Date.now();
    const id = await db.insert('roles', {
      key: role.key, name: role.name, description: role.description,
      active: 1, system: role.system, priority: role.priority,
      created_at: now, updated_at: now,
    });
    for (const key of role.permissions) {
      await db.run('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)', [id, key]);
    }
  }
  invalidateAll();
}

/**
 * Is this account the superadmin?
 *
 * Compared against email_norm rather than email so capitalisation cannot be
 * used to slip past it, and a deleted account never qualifies.
 */
export async function isSuperadmin(userId) {
  if (!userId) return false;
  const { superadmin } = await permissionsFor(userId);
  return superadmin;
}

/** Effective permissions for a user, from all their active roles. */
export async function permissionsFor(userId) {
  const cacheKey = String(userId);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;

  const db = getDatabase();
  const account = await db.get(
    'SELECT email_norm FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
  const superadmin = Boolean(account)
    && String(account.email_norm ?? '').toLowerCase() === config.superadmin.email;

  const rows = await db.all(`
    SELECT r.key AS role_key, r.name AS role_name, rp.permission_key AS perm
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id AND r.active = 1
    LEFT JOIN role_permissions rp ON rp.role_id = r.id
    WHERE ur.user_id = ?`, [userId]);

  const permissions = new Set();
  const roles = new Map();
  for (const row of rows) {
    roles.set(row.role_key, row.role_name);
    if (row.perm) permissions.add(row.perm);
  }
  // The superadmin can do everything the code knows how to do. This is
  // computed, never stored: there is no row anywhere saying so.
  if (superadmin) for (const key of PERMISSION_KEYS) permissions.add(key);

  const entry = {
    at: Date.now(),
    permissions,
    superadmin,
    roles: [...roles.keys()],
    roleNames: [...roles.values()],
  };
  cache.set(cacheKey, entry);
  return entry;
}

/** True when the user holds `permission`, or is the superadmin. */
export async function can(userId, permission) {
  if (!userId) return false;
  const { permissions } = await permissionsFor(userId);
  return permissions.has(permission);
}

/** Throwing variant used by route guards. */
export async function require(userId, permission) {
  if (!(await can(userId, permission))) {
    const error = new Error('forbidden');
    error.status = 403;
    error.code = 'error.forbidden';
    error.permission = permission;
    throw error;
  }
}

// --- role management -------------------------------------------------------

export async function listRoles() {
  const db = getDatabase();
  const roles = await db.all('SELECT * FROM roles ORDER BY priority DESC, key');
  const perms = await db.all('SELECT role_id, permission_key FROM role_permissions');
  const byRole = new Map();
  for (const row of perms) {
    if (!byRole.has(row.role_id)) byRole.set(row.role_id, []);
    byRole.get(row.role_id).push(row.permission_key);
  }
  const counts = await db.all('SELECT role_id, COUNT(*) AS n FROM user_roles GROUP BY role_id');
  const countMap = new Map(counts.map((r) => [String(r.role_id), Number(r.n)]));

  return roles.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    active: r.active === 1,
    system: r.system === 1,
    priority: r.priority,
    permissions: (byRole.get(r.id) ?? []).sort(),
    memberCount: countMap.get(String(r.id)) ?? 0,
  }));
}

export async function createRole({ key, name, description = '', permissions = [], priority = 100 }) {
  const db = getDatabase();
  validateRoleKey(key);
  const unknown = permissions.filter((p) => !isKnownPermission(p));
  if (unknown.length) throw badRequest(`unknown permissions: ${unknown.join(', ')}`);

  const existing = await db.get('SELECT id FROM roles WHERE key = ?', [key]);
  if (existing) throw conflict('a role with that key already exists');

  const now = Date.now();
  const id = await db.tx(async (tx) => {
    const roleId = await tx.insert('roles', {
      key, name, description, active: 1, system: 0, priority,
      created_at: now, updated_at: now,
    });
    for (const perm of permissions) {
      await tx.run('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)', [roleId, perm]);
    }
    return roleId;
  });

  invalidateAll();
  return id;
}

export async function duplicateRole(roleId, newKey, newName) {
  const db = getDatabase();
  const source = await db.get('SELECT * FROM roles WHERE id = ?', [roleId]);
  if (!source) throw notFound('role');
  const perms = (await db.all('SELECT permission_key FROM role_permissions WHERE role_id = ?', [roleId]))
    .map((r) => r.permission_key);

  return createRole({
    key: newKey,
    name: newName || `${source.name} (Kopie)`,
    description: source.description,
    permissions: perms,
    priority: source.priority,
  });
}

export async function updateRole(roleId, changes) {
  const db = getDatabase();
  const role = await db.get('SELECT * FROM roles WHERE id = ?', [roleId]);
  if (!role) throw notFound('role');

  const fields = {};
  if (changes.name !== undefined) fields.name = String(changes.name).slice(0, 80);
  if (changes.description !== undefined) fields.description = String(changes.description).slice(0, 500);
  if (changes.priority !== undefined) fields.priority = Number(changes.priority) | 0;
  if (changes.active !== undefined) fields.active = changes.active ? 1 : 0;
  if (changes.key !== undefined && changes.key !== role.key) {
    if (role.system === 1) throw badRequest('a system role cannot be renamed by key');
    validateRoleKey(changes.key);
    fields.key = changes.key;
  }

  if (Object.keys(fields).length) {
    fields.updated_at = Date.now();
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    await db.run(`UPDATE roles SET ${sets} WHERE id = ?`, [...Object.values(fields), roleId]);
  }

  if (changes.permissions) {
    const unknown = changes.permissions.filter((p) => !isKnownPermission(p));
    if (unknown.length) throw badRequest(`unknown permissions: ${unknown.join(', ')}`);
    await db.tx(async (tx) => {
      await tx.run('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
      for (const perm of changes.permissions) {
        await tx.run('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)', [roleId, perm]);
      }
    });
  }

  invalidateAll();
}

export async function deleteRole(roleId) {
  const db = getDatabase();
  const role = await db.get('SELECT * FROM roles WHERE id = ?', [roleId]);
  if (!role) throw notFound('role');
  if (role.system === 1) throw badRequest('system roles cannot be deleted');

  await db.run('DELETE FROM roles WHERE id = ?', [roleId]);
  invalidateAll();
}

export async function assignRole(userId, roleId, actor) {
  const db = getDatabase();
  const role = await db.get('SELECT key FROM roles WHERE id = ?', [roleId]);
  if (!role) throw notFound('role');
  const existing = await db.get('SELECT 1 AS x FROM user_roles WHERE user_id = ? AND role_id = ?', [userId, roleId]);
  if (!existing) {
    await db.insert('user_roles', {
      user_id: userId, role_id: roleId, granted_at: Date.now(), granted_by: actor?.userId ?? null,
    });
  }
  invalidateUser(userId);
}

export async function removeRole(userId, roleId) {
  const db = getDatabase();
  await db.run('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?', [userId, roleId]);
  invalidateUser(userId);
}

function validateRoleKey(key) {
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(key ?? '')) {
    throw badRequest('role key must be 2-32 chars, lowercase letters, digits and underscores');
  }
}

function badRequest(message) { const e = new Error(message); e.status = 400; return e; }
function conflict(message) { const e = new Error(message); e.status = 409; return e; }
function notFound(what) { const e = new Error(`${what} not found`); e.status = 404; return e; }
