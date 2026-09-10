-- Administration rework.
--
-- Three things the operator asked for, and one consequence of them.
--
-- 1. The audit log is gone. It was a table every privileged action wrote to;
--    dropping it is deliberate, so nothing here writes an action trail any
--    more and the audit.view permission stops existing.
-- 2. The owner role is gone, and with it the wildcard permission. "Who is
--    superadmin" is no longer a row anyone can read: it is one e-mail address
--    compared in code. An administrator inspecting roles and permissions now
--    finds no evidence that a higher level exists at all.
-- 3. Advertising becomes a first-class thing: a role can let an ordinary
--    player submit adverts, and the superadmin can put one interstitial in
--    front of the site itself.

DROP TABLE IF EXISTS audit_log;

DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE key = 'owner');
DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE key = 'owner');
DELETE FROM roles WHERE key = 'owner';

DELETE FROM role_permissions WHERE permission_key IN ('*', 'audit.view');
DELETE FROM permissions WHERE key IN ('*', 'audit.view');

-- The advert shown before the site itself. Only one row is ever active; the
-- service enforces that, because two "first" adverts is a contradiction.
CREATE TABLE interstitials (
  id          {{ID_PK}},
  headline    {{TEXT}} NOT NULL,
  body        {{TEXT}} NOT NULL DEFAULT '',
  image_path  {{TEXT}},
  target_url  {{TEXT}},
  seconds     {{INT}} NOT NULL DEFAULT 5,
  active      {{BOOL}} NOT NULL DEFAULT 0,
  created_by  {{ID_REF}},
  created_at  {{TS}} NOT NULL,
  updated_at  {{TS}} NOT NULL,
  impressions {{BIGINT}} NOT NULL DEFAULT 0,
  clicks      {{BIGINT}} NOT NULL DEFAULT 0
);
CREATE INDEX idx_interstitials_active ON interstitials (active);

-- Where in the interface a submitted advert appears. Existing rows keep the
-- behaviour they already had.
ALTER TABLE ads ADD COLUMN placement {{TEXT}} NOT NULL DEFAULT 'menu';
