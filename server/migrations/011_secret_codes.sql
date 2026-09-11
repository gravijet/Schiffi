-- Secret codes, as data rather than a hardcoded list, so an admin can create,
-- edit, deactivate or delete one without a deploy. `code_redemptions`
-- (005_meta.sql) already tracks who has used what; this table is the
-- definition of a code itself.

CREATE TABLE secret_codes (
  id           {{ID_PK}},
  code         {{TEXT}} NOT NULL UNIQUE,
  reward_coins {{BIGINT}} NOT NULL DEFAULT 0,
  limit_type   {{TEXT}} NOT NULL DEFAULT 'once_per_character',
  active       {{BOOL}} NOT NULL DEFAULT 1,
  expires_at   {{TS}},
  created_by   {{ID_REF}} REFERENCES users(id) ON DELETE SET NULL,
  created_at   {{TS}} NOT NULL,
  updated_at   {{TS}} NOT NULL
);
CREATE INDEX idx_secret_codes_active ON secret_codes (active);
