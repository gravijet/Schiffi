-- Player-created worlds, durable runtime settings and guest accounts.

ALTER TABLE users ADD COLUMN is_guest {{BOOL}} NOT NULL DEFAULT 0;

ALTER TABLE worlds ADD COLUMN creator_user_id {{ID_REF}} REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE worlds ADD COLUMN visibility {{TEXT}} NOT NULL DEFAULT 'public';
ALTER TABLE worlds ADD COLUMN invite_code {{TEXT}};
CREATE UNIQUE INDEX idx_worlds_invite_code ON worlds (invite_code);
CREATE INDEX idx_worlds_creator ON worlds (creator_user_id);

CREATE TABLE world_members (
  world_id  {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  user_id   {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at {{TS}} NOT NULL,
  PRIMARY KEY (world_id, user_id)
);
CREATE INDEX idx_world_members_user ON world_members (user_id, joined_at);

CREATE TABLE system_settings (
  key        {{TEXT}} PRIMARY KEY,
  value      {{TEXT}} NOT NULL,
  secret     {{BOOL}} NOT NULL DEFAULT 0,
  updated_at {{TS}} NOT NULL,
  updated_by {{ID_REF}}
);
