-- Chat, moderation, friends, convoys and trading companies (guilds).

CREATE TABLE chat_messages (
  id           {{ID_PK}},
  world_id     {{ID_REF}} REFERENCES worlds(id) ON DELETE CASCADE,
  channel      {{TEXT}} NOT NULL,
  scope_id     {{TEXT}},
  user_id      {{ID_REF}} REFERENCES users(id) ON DELETE SET NULL,
  character_id {{ID_REF}},
  author_name  {{TEXT}} NOT NULL,
  body         {{TEXT}} NOT NULL,
  reply_to     {{ID_REF}},
  mentions     {{JSON}} NOT NULL DEFAULT '[]',
  at           {{TS}} NOT NULL,
  deleted_at   {{TS}},
  deleted_by   {{ID_REF}}
);
CREATE INDEX idx_chat_channel ON chat_messages (world_id, channel, scope_id, at);

CREATE TABLE chat_mutes (
  id      {{ID_PK}},
  user_id {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  until   {{TS}} NOT NULL,
  reason  {{TEXT}} NOT NULL DEFAULT '',
  by      {{ID_REF}},
  at      {{TS}} NOT NULL
);
CREATE INDEX idx_chat_mutes_user ON chat_mutes (user_id, until);

CREATE TABLE reports (
  id          {{ID_PK}},
  reporter_id {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type {{TEXT}} NOT NULL,
  target_id   {{TEXT}} NOT NULL,
  reason      {{TEXT}} NOT NULL,
  detail      {{TEXT}} NOT NULL DEFAULT '',
  status      {{TEXT}} NOT NULL DEFAULT 'open',
  at          {{TS}} NOT NULL,
  handled_by  {{ID_REF}},
  handled_at  {{TS}},
  resolution  {{TEXT}}
);
CREATE INDEX idx_reports_status ON reports (status, at);

CREATE TABLE friendships (
  user_id    {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     {{TEXT}} NOT NULL DEFAULT 'pending',
  created_at {{TS}} NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE blocks (
  user_id    {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at         {{TS}} NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);

CREATE TABLE guilds (
  id          {{ID_PK}},
  world_id    {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name        {{TEXT}} NOT NULL,
  tag         {{TEXT}} NOT NULL,
  description {{TEXT}} NOT NULL DEFAULT '',
  founder_id  {{ID_REF}} NOT NULL,
  treasury    {{BIGINT}} NOT NULL DEFAULT 0,
  created_at  {{TS}} NOT NULL,
  UNIQUE (world_id, tag)
);

CREATE TABLE guild_ranks (
  id          {{ID_PK}},
  guild_id    {{ID_REF}} NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  key         {{TEXT}} NOT NULL,
  name        {{TEXT}} NOT NULL,
  priority    {{INT}} NOT NULL DEFAULT 0,
  permissions {{JSON}} NOT NULL DEFAULT '[]'
);

CREATE TABLE guild_members (
  guild_id     {{ID_REF}} NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  character_id {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  rank_key     {{TEXT}} NOT NULL DEFAULT 'member',
  joined_at    {{TS}} NOT NULL,
  PRIMARY KEY (guild_id, character_id)
);

-- Every treasury movement is auditable; withdrawals need a rank permission.
CREATE TABLE guild_ledger (
  id           {{ID_PK}},
  guild_id     {{ID_REF}} NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  character_id {{ID_REF}},
  actor_name   {{TEXT}} NOT NULL,
  delta        {{BIGINT}} NOT NULL,
  balance      {{BIGINT}} NOT NULL,
  reason       {{TEXT}} NOT NULL DEFAULT '',
  at           {{TS}} NOT NULL
);
CREATE INDEX idx_guild_ledger ON guild_ledger (guild_id, at);

CREATE TABLE convoys (
  id         {{ID_PK}},
  world_id   {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  leader_id  {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name       {{TEXT}} NOT NULL DEFAULT '',
  created_at {{TS}} NOT NULL
);

CREATE TABLE convoy_members (
  convoy_id    {{ID_REF}} NOT NULL REFERENCES convoys(id) ON DELETE CASCADE,
  character_id {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  joined_at    {{TS}} NOT NULL,
  PRIMARY KEY (convoy_id, character_id)
);

CREATE TABLE bounties (
  id          {{ID_PK}},
  world_id    {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  target_id   {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  placed_by   {{ID_REF}} REFERENCES characters(id) ON DELETE SET NULL,
  amount      {{BIGINT}} NOT NULL,
  reason      {{TEXT}} NOT NULL DEFAULT '',
  created_at  {{TS}} NOT NULL,
  claimed_by  {{ID_REF}},
  claimed_at  {{TS}}
);
CREATE INDEX idx_bounties_target ON bounties (world_id, target_id);
