/**
 * Role-based access control.
 *
 * Roles live in the database so they can be created, renamed, duplicated,
 * deactivated and deleted at runtime.  Permission *keys* are code-defined, so
 * a role can never grant an ability the server does not implement.
 *
 * A short-lived cache keeps the hot path (one permission check per request)
 * off the database; it is invalidated on every write.
 */
import { PERMISSIONS, BOOTSTRAP_ROLES, WILDCARD, isKnownPermission } from './permissions.js';
import { getDatabase } from '../db/index.js';
import { audit } from './audit.js';

const CACHE_TTL_MS = 30_000;
const cache = new Map(); // userId -> { at, permissions: Set, roles: [] }

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
  // The wildcard is a real row so role_permissions can reference it.
  if (!existing.has(WILDCARD)) {
    await db.run('INSERT INTO permissions (key, category, description) VALUES (?, ?, ?)',
      [WILDCARD, 'system', 'Every permission, including future ones']).catch(() => {});
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

/** Effective permissions for a user, from all their active roles. */
export async function permissionsFor(userId) {
  const cacheKey = String(userId);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;

  const db = getDatabase();
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
  const entry = { at: Date.now(), permissions, roles: [...roles.keys()], roleNames: [...roles.values()] };
  cache.set(cacheKey, entry);
  return entry;
}

/** True when the user holds `permission` (or the wildcard). */
export async function can(userId, permission) {
  if (!userId) return false;
  const { permissions } = await permissionsFor(userId);
  return permissions.has(WILDCARD) || permissions.has(permission);
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

export async function createRole({ key, name, description = '', permissions = [], priority = 100 }, actor) {
  const db = getDatabase();
  validateRoleKey(key);
  const unknown = permissions.filter((p) => !isKnownPermission(p));
  if (unknown.length) throw badRequest(`unknown permissions: ${unknown.join(', ')}`);
  if (permissions.includes(WILDCARD)) throw badRequest('the wildcard permission cannot be granted to a new role');

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

  await audit(actor, 'role.create', 'role', key, { name, permissions });
  invalidateAll();
  return id;
}

export async function duplicateRole(roleId, newKey, newName, actor) {
  const db = getDatabase();
  const source = await db.get('SELECT * FROM roles WHERE id = ?', [roleId]);
  if (!source) throw notFound('role');
  const perms = (await db.all('SELECT permission_key FROM role_permissions WHERE role_id = ?', [roleId]))
    .map((r) => r.permission_key)
    .filter((p) => p !== WILDCARD); // a duplicate never inherits the wildcard

  return createRole({
    key: newKey,
    name: newName || `${source.name} (copy)`,
    description: source.description,
    permissions: perms,
    priority: source.priority,
  }, actor);
}

export async function updateRole(roleId, changes, actor) {
  const db = getDatabase();
  const role = await db.get('SELECT * FROM roles WHERE id = ?', [roleId]);
  if (!role) throw notFound('role');

  const fields = {};
  if (changes.name !== undefined) fields.name = String(changes.name).slice(0, 80);
  if (changes.description !== undefined) fields.description = String(changes.description).slice(0, 500);
  if (changes.priority !== undefined) fields.priority = Number(changes.priority) | 0;
  if (changes.active !== undefined) {
    if (role.key === 'owner' && !changes.active) throw badRequest('the owner role cannot be deactivated');
    fields.active = changes.active ? 1 : 0;
  }
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
    // The owner role must keep its wildcard, or the instance can lock itself out.
    if (role.key === 'owner' && !changes.permissions.includes(WILDCARD)) {
      throw badRequest('the owner role must keep the wildcard permission');
    }
    if (role.key !== 'owner' && changes.permissions.includes(WILDCARD)) {
      throw badRequest('only the owner role may hold the wildcard permission');
    }
    await db.tx(async (tx) => {
      await tx.run('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
      for (const perm of changes.permissions) {
        await tx.run('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)', [roleId, perm]);
      }
    });
  }

  await audit(actor, 'role.update', 'role', role.key, changes);
  invalidateAll();
}

export async function deleteRole(roleId, actor) {
  const db = getDatabase();
  const role = await db.get('SELECT * FROM roles WHERE id = ?', [roleId]);
  if (!role) throw notFound('role');
  if (role.system === 1) throw badRequest('system roles cannot be deleted');

  await db.run('DELETE FROM roles WHERE id = ?', [roleId]);
  await audit(actor, 'role.delete', 'role', role.key, {});
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
  await audit(actor, 'role.assign', 'user', String(userId), { role: role.key });
  invalidateUser(userId);
}

export async function removeRole(userId, roleId, actor) {
  const db = getDatabase();
  const role = await db.get('SELECT key FROM roles WHERE id = ?', [roleId]);
  await db.run('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?', [userId, roleId]);
  await audit(actor, 'role.remove', 'user', String(userId), { role: role?.key });
  invalidateUser(userId);
}

/** Grant the owner role. Used by the bootstrap and never exposed over HTTP. */
export async function grantOwner(userId) {
  const db = getDatabase();
  const role = await db.get('SELECT id FROM roles WHERE key = ?', ['owner']);
  if (!role) throw new Error('owner role missing - run syncPermissions() first');
  await assignRole(userId, role.id, { userId: null, ip: 'bootstrap' });
}

export async function ownerCount() {
  const db = getDatabase();
  const row = await db.get(`
    SELECT COUNT(*) AS n FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id WHERE r.key = 'owner'`);
  return Number(row?.n ?? 0);
}

function validateRoleKey(key) {
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(key ?? '')) {
    throw badRequest('role key must be 2-32 chars, lowercase letters, digits and underscores');
  }
}

function badRequest(message) { const e = new Error(message); e.status = 400; return e; }
function conflict(message) { const e = new Error(message); e.status = 409; return e; }
function notFound(what) { const e = new Error(`${what} not found`); e.status = 404; return e; }
