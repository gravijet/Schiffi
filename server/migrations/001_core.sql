-- Accounts, sessions, RBAC and the audit trail.
-- Timestamps are epoch milliseconds; booleans are 0/1; JSON is TEXT.

CREATE TABLE users (
  id                {{ID_PK}},
  email             {{TEXT}} NOT NULL,
  email_norm        {{TEXT}} NOT NULL UNIQUE,
  username          {{TEXT}} NOT NULL,
  username_norm     {{TEXT}} NOT NULL UNIQUE,
  password_hash     {{TEXT}} NOT NULL,
  password_algo     {{TEXT}} NOT NULL DEFAULT 'argon2id',
  email_verified_at {{TS}},
  locale            {{TEXT}} NOT NULL DEFAULT 'en',
  theme             {{TEXT}} NOT NULL DEFAULT 'auto',
  avatar_path       {{TEXT}},
  settings          {{JSON}} NOT NULL DEFAULT '{}',
  created_at        {{TS}} NOT NULL,
  updated_at        {{TS}} NOT NULL,
  last_login_at     {{TS}},
  banned_until      {{TS}},
  ban_reason        {{TEXT}},
  deleted_at        {{TS}},
  force_password_reset {{BOOL}} NOT NULL DEFAULT 0
);
CREATE INDEX idx_users_created ON users (created_at);

-- Session tokens are stored only as a hash: a database leak must not hand
-- anyone a working session.
CREATE TABLE sessions (
  id           {{ID_PK}},
  user_id      {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   {{TEXT}} NOT NULL UNIQUE,
  created_at   {{TS}} NOT NULL,
  last_seen_at {{TS}} NOT NULL,
  expires_at   {{TS}} NOT NULL,
  revoked_at   {{TS}},
  ip           {{TEXT}},
  user_agent   {{TEXT}}
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

-- One-time tokens for e-mail verification and password reset.
CREATE TABLE email_tokens (
  id         {{ID_PK}},
  user_id    {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       {{TEXT}} NOT NULL,
  token_hash {{TEXT}} NOT NULL UNIQUE,
  created_at {{TS}} NOT NULL,
  expires_at {{TS}} NOT NULL,
  used_at    {{TS}}
);
CREATE INDEX idx_email_tokens_user ON email_tokens (user_id, kind);

CREATE TABLE login_attempts (
  id       {{ID_PK}},
  scope    {{TEXT}} NOT NULL,
  at       {{TS}} NOT NULL,
  success  {{BOOL}} NOT NULL
);
CREATE INDEX idx_login_attempts_scope ON login_attempts (scope, at);

-- Roles are data, not code: an administrator with roles.create can define new
-- ones at runtime.  `system` marks the two roles the bootstrap needs and that
-- therefore cannot be deleted.
CREATE TABLE roles (
  id          {{ID_PK}},
  key         {{TEXT}} NOT NULL UNIQUE,
  name        {{TEXT}} NOT NULL,
  description {{TEXT}} NOT NULL DEFAULT '',
  active      {{BOOL}} NOT NULL DEFAULT 1,
  system      {{BOOL}} NOT NULL DEFAULT 0,
  priority    {{INT}} NOT NULL DEFAULT 0,
  created_at  {{TS}} NOT NULL,
  updated_at  {{TS}} NOT NULL
);

CREATE TABLE permissions (
  key         {{TEXT}} PRIMARY KEY,
  category    {{TEXT}} NOT NULL,
  description {{TEXT}} NOT NULL DEFAULT ''
);

CREATE TABLE role_permissions (
  role_id        {{ID_REF}} NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key {{TEXT}} NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE user_roles (
  user_id    {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    {{ID_REF}} NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at {{TS}} NOT NULL,
  granted_by {{ID_REF}},
  PRIMARY KEY (user_id, role_id)
);

-- Every privileged action is recorded.  This is what makes "no administrator
-- can read a password" verifiable rather than merely asserted.
CREATE TABLE audit_log (
  id           {{ID_PK}},
  at           {{TS}} NOT NULL,
  actor_user_id {{ID_REF}},
  actor_ip     {{TEXT}},
  action       {{TEXT}} NOT NULL,
  target_type  {{TEXT}},
  target_id    {{TEXT}},
  data         {{JSON}} NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_at ON audit_log (at);
CREATE INDEX idx_audit_actor ON audit_log (actor_user_id, at);
