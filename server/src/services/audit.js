/**
 * Audit trail.
 *
 * Every privileged action writes a row here.  Failures are logged but never
 * propagate: an audit write must not be able to roll back the action it
 * describes, and a broken log must not take the server down.
 */
import { getDatabase } from '../db/index.js';

export async function audit(actor, action, targetType = null, targetId = null, data = {}) {
  try {
    const db = getDatabase();
    await db.insert('audit_log', {
      at: Date.now(),
      actor_user_id: actor?.userId ?? null,
      actor_ip: actor?.ip ?? null,
      action,
      target_type: targetType,
      target_id: targetId === null ? null : String(targetId),
      data: JSON.stringify(redact(data)),
    });
  } catch (error) {
    console.error('[audit] failed to record', action, error.message);
  }
}

/** Never let a secret reach the audit log, whatever the caller passed. */
const SECRET_KEYS = /pass|secret|token|hash|key|authorization|cookie/i;

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEYS.test(key) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export async function readAuditLog({ limit = 100, before = null, actorId = null, action = null } = {}) {
  const db = getDatabase();
  const where = [];
  const params = [];
  if (before) { where.push('at < ?'); params.push(before); }
  if (actorId) { where.push('actor_user_id = ?'); params.push(actorId); }
  if (action) { where.push('action = ?'); params.push(action); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(Math.min(500, Math.max(1, limit)));
  const rows = await db.all(`SELECT * FROM audit_log ${clause} ORDER BY at DESC LIMIT ?`, params);
  return rows.map((r) => ({ ...r, data: JSON.parse(r.data || '{}') }));
}
