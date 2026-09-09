-- Progression, live-ops content, support and advertising.

CREATE TABLE user_achievements (
  user_id   {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key       {{TEXT}} NOT NULL,
  progress  {{BIGINT}} NOT NULL DEFAULT 0,
  unlocked_at {{TS}},
  PRIMARY KEY (user_id, key)
);

CREATE TABLE seasons (
  id        {{ID_PK}},
  number    {{INT}} NOT NULL UNIQUE,
  name      {{TEXT}} NOT NULL,
  starts_at {{TS}} NOT NULL,
  ends_at   {{TS}} NOT NULL,
  closed_at {{TS}}
);

CREATE TABLE leaderboard_entries (
  id           {{ID_PK}},
  season_id    {{ID_REF}} REFERENCES seasons(id) ON DELETE CASCADE,
  world_id     {{ID_REF}} REFERENCES worlds(id) ON DELETE CASCADE,
  board        {{TEXT}} NOT NULL,
  character_id {{ID_REF}},
  guild_id     {{ID_REF}},
  display_name {{TEXT}} NOT NULL,
  score        {{BIGINT}} NOT NULL,
  updated_at   {{TS}} NOT NULL
);
CREATE INDEX idx_leaderboard ON leaderboard_entries (board, season_id, score);

-- Secret codes.  `per_character` codes are redeemable once per save; repeatable
-- codes have no uniqueness constraint at all.
CREATE TABLE code_redemptions (
  id           {{ID_PK}},
  code         {{TEXT}} NOT NULL,
  user_id      {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id {{ID_REF}} REFERENCES characters(id) ON DELETE CASCADE,
  amount       {{BIGINT}} NOT NULL DEFAULT 0,
  at           {{TS}} NOT NULL
);
CREATE INDEX idx_code_redemptions ON code_redemptions (code, character_id);

-- Administrators author events here; the simulation reads them. No code change.
CREATE TABLE world_events (
  id          {{ID_PK}},
  world_id    {{ID_REF}} REFERENCES worlds(id) ON DELETE CASCADE,
  kind        {{TEXT}} NOT NULL,
  scope       {{TEXT}} NOT NULL DEFAULT 'global',
  region_id   {{INT}},
  port_id     {{TEXT}},
  title       {{JSON}} NOT NULL DEFAULT '{}',
  body        {{JSON}} NOT NULL DEFAULT '{}',
  effects     {{JSON}} NOT NULL DEFAULT '{}',
  starts_at   {{TS}} NOT NULL,
  ends_at     {{TS}} NOT NULL,
  active      {{BOOL}} NOT NULL DEFAULT 1,
  created_by  {{ID_REF}},
  created_at  {{TS}} NOT NULL
);
CREATE INDEX idx_world_events_active ON world_events (world_id, active, starts_at, ends_at);

CREATE TABLE support_tickets (
  id         {{ID_PK}},
  user_id    {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject    {{TEXT}} NOT NULL,
  category   {{TEXT}} NOT NULL DEFAULT 'general',
  priority   {{TEXT}} NOT NULL DEFAULT 'normal',
  status     {{TEXT}} NOT NULL DEFAULT 'open',
  created_at {{TS}} NOT NULL,
  updated_at {{TS}} NOT NULL,
  assigned_to {{ID_REF}}
);
CREATE INDEX idx_tickets_user ON support_tickets (user_id, status);

CREATE TABLE support_messages (
  id        {{ID_PK}},
  ticket_id {{ID_REF}} NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id   {{ID_REF}} REFERENCES users(id) ON DELETE SET NULL,
  body      {{TEXT}} NOT NULL,
  is_staff  {{BOOL}} NOT NULL DEFAULT 0,
  at        {{TS}} NOT NULL
);

CREATE TABLE news_posts (
  id           {{ID_PK}},
  slug         {{TEXT}} NOT NULL UNIQUE,
  title        {{JSON}} NOT NULL,
  body         {{JSON}} NOT NULL,
  author_id    {{ID_REF}},
  published_at {{TS}},
  created_at   {{TS}} NOT NULL,
  updated_at   {{TS}} NOT NULL
);

CREATE TABLE ads (
  id          {{ID_PK}},
  user_id     {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       {{TEXT}} NOT NULL,
  body        {{TEXT}} NOT NULL,
  target_url  {{TEXT}} NOT NULL,
  image_path  {{TEXT}},
  status      {{TEXT}} NOT NULL DEFAULT 'pending',
  submitted_at {{TS}} NOT NULL,
  reviewed_by {{ID_REF}},
  reviewed_at {{TS}},
  review_note {{TEXT}},
  impressions {{BIGINT}} NOT NULL DEFAULT 0,
  clicks      {{BIGINT}} NOT NULL DEFAULT 0
);
CREATE INDEX idx_ads_status ON ads (status);

-- Per-user analytics that the player can see and export: session counts,
-- distance sailed, goods traded. No third-party tracking is involved.
CREATE TABLE player_stats (
  character_id  {{ID_REF}} PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  distance      {{REAL}} NOT NULL DEFAULT 0,
  goods_bought  {{BIGINT}} NOT NULL DEFAULT 0,
  goods_sold    {{BIGINT}} NOT NULL DEFAULT 0,
  coins_earned  {{BIGINT}} NOT NULL DEFAULT 0,
  coins_spent   {{BIGINT}} NOT NULL DEFAULT 0,
  ports_visited {{INT}} NOT NULL DEFAULT 0,
  islands_found {{INT}} NOT NULL DEFAULT 0,
  battles_won   {{INT}} NOT NULL DEFAULT 0,
  battles_lost  {{INT}} NOT NULL DEFAULT 0,
  storms_survived {{INT}} NOT NULL DEFAULT 0,
  cargo_lost    {{BIGINT}} NOT NULL DEFAULT 0,
  updated_at    {{TS}} NOT NULL
);

CREATE TABLE tutorial_progress (
  character_id {{ID_REF}} PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  step         {{INT}} NOT NULL DEFAULT 0,
  completed_at {{TS}},
  skipped      {{BOOL}} NOT NULL DEFAULT 0
);
