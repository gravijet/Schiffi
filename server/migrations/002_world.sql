-- Worlds, characters, ships, crew, cargo, exploration.

CREATE TABLE worlds (
  id               {{ID_PK}},
  name             {{TEXT}} NOT NULL,
  seed             {{BIGINT}} NOT NULL,
  worldgen_version {{INT}} NOT NULL,
  status           {{TEXT}} NOT NULL DEFAULT 'open',
  created_at       {{TS}} NOT NULL,
  tick             {{BIGINT}} NOT NULL DEFAULT 0,
  game_time_ms     {{BIGINT}} NOT NULL DEFAULT 0,
  season           {{INT}} NOT NULL DEFAULT 0,
  settings         {{JSON}} NOT NULL DEFAULT '{}',
  max_players      {{INT}} NOT NULL DEFAULT 400
);

CREATE TABLE characters (
  id               {{ID_PK}},
  user_id          {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  world_id         {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name             {{TEXT}} NOT NULL,
  mode             {{TEXT}} NOT NULL DEFAULT 'trader',
  coins            {{BIGINT}} NOT NULL DEFAULT 0,
  bank_balance     {{BIGINT}} NOT NULL DEFAULT 0,
  x                {{REAL}} NOT NULL,
  y                {{REAL}} NOT NULL,
  heading          {{REAL}} NOT NULL DEFAULT 0,
  active_ship_id   {{ID_REF}},
  current_port_id  {{TEXT}},
  docked           {{BOOL}} NOT NULL DEFAULT 1,
  level            {{INT}} NOT NULL DEFAULT 1,
  xp               {{BIGINT}} NOT NULL DEFAULT 0,
  profession       {{TEXT}} NOT NULL DEFAULT 'trader',
  playtime_ms      {{BIGINT}} NOT NULL DEFAULT 0,
  protection_until {{TS}},
  created_at       {{TS}} NOT NULL,
  last_seen_at     {{TS}} NOT NULL,
  deleted_at       {{TS}}
);
CREATE INDEX idx_characters_user ON characters (user_id);
CREATE INDEX idx_characters_world ON characters (world_id);

CREATE TABLE ships (
  id           {{ID_PK}},
  character_id {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  class_key    {{TEXT}} NOT NULL,
  name         {{TEXT}} NOT NULL,
  hull         {{REAL}} NOT NULL,
  sail         {{REAL}} NOT NULL,
  upgrades     {{JSON}} NOT NULL DEFAULT '{}',
  cannons      {{INT}} NOT NULL DEFAULT 0,
  ammunition   {{INT}} NOT NULL DEFAULT 0,
  stored_at_port {{TEXT}},
  created_at   {{TS}} NOT NULL
);
CREATE INDEX idx_ships_character ON ships (character_id);

CREATE TABLE crew_members (
  id        {{ID_PK}},
  ship_id   {{ID_REF}} NOT NULL REFERENCES ships(id) ON DELETE CASCADE,
  name      {{TEXT}} NOT NULL,
  role      {{TEXT}} NOT NULL,
  spec      {{TEXT}} NOT NULL DEFAULT 'none',
  level     {{INT}} NOT NULL DEFAULT 1,
  xp        {{BIGINT}} NOT NULL DEFAULT 0,
  morale    {{INT}} NOT NULL DEFAULT 70,
  health    {{INT}} NOT NULL DEFAULT 100,
  wage      {{INT}} NOT NULL DEFAULT 0,
  disease   {{TEXT}},
  hired_at  {{TS}} NOT NULL
);
CREATE INDEX idx_crew_ship ON crew_members (ship_id);

-- Cargo tracks freshness per lot so spoilage can be reported exactly.
CREATE TABLE cargo (
  id          {{ID_PK}},
  ship_id     {{ID_REF}} NOT NULL REFERENCES ships(id) ON DELETE CASCADE,
  good_id     {{INT}} NOT NULL,
  qty         {{INT}} NOT NULL,
  freshness   {{REAL}} NOT NULL DEFAULT 1.0,
  avg_cost    {{REAL}} NOT NULL DEFAULT 0,
  acquired_at {{TS}} NOT NULL
);
CREATE INDEX idx_cargo_ship ON cargo (ship_id);

CREATE TABLE warehouses (
  id       {{ID_PK}},
  character_id {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  port_id  {{TEXT}} NOT NULL,
  capacity {{INT}} NOT NULL DEFAULT 50,
  rent_due_at {{TS}},
  rent_per_day {{INT}} NOT NULL DEFAULT 10
);
CREATE TABLE warehouse_cargo (
  id           {{ID_PK}},
  warehouse_id {{ID_REF}} NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  good_id      {{INT}} NOT NULL,
  qty          {{INT}} NOT NULL,
  freshness    {{REAL}} NOT NULL DEFAULT 1.0
);

-- Fog of war: one bit per fog cell, stored as a blob per character.
CREATE TABLE fog (
  character_id {{ID_REF}} PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  bitmap       {{BLOB}} NOT NULL,
  explored     {{INT}} NOT NULL DEFAULT 0,
  updated_at   {{TS}} NOT NULL
);

-- First discovery is recorded once per island per world and can never be
-- awarded twice - enforced by the primary key, not by application logic.
CREATE TABLE island_discoveries (
  world_id      {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  island_id     {{INT}} NOT NULL,
  user_id       {{ID_REF}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id  {{ID_REF}} NOT NULL,
  player_name   {{TEXT}} NOT NULL,
  discovered_at {{TS}} NOT NULL,
  proposed_name {{TEXT}},
  name_status   {{TEXT}} NOT NULL DEFAULT 'none',
  final_name    {{TEXT}},
  moderated_by  {{ID_REF}},
  moderated_at  {{TS}},
  PRIMARY KEY (world_id, island_id)
);

CREATE TABLE discovery_album (
  id           {{ID_PK}},
  character_id {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  kind         {{TEXT}} NOT NULL,
  entry_key    {{TEXT}} NOT NULL,
  found_at     {{TS}} NOT NULL,
  data         {{JSON}} NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_album_character ON discovery_album (character_id);

CREATE TABLE charts (
  id           {{ID_PK}},
  character_id {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  kind         {{TEXT}} NOT NULL,
  ref_id       {{TEXT}} NOT NULL,
  acquired_at  {{TS}} NOT NULL,
  source       {{TEXT}} NOT NULL DEFAULT 'explored'
);
CREATE INDEX idx_charts_character ON charts (character_id, kind);

CREATE TABLE wrecks (
  id         {{ID_PK}},
  world_id   {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  x          {{REAL}} NOT NULL,
  y          {{REAL}} NOT NULL,
  contents   {{JSON}} NOT NULL DEFAULT '[]',
  created_at {{TS}} NOT NULL,
  looted_by  {{ID_REF}},
  looted_at  {{TS}}
);
CREATE INDEX idx_wrecks_world ON wrecks (world_id);

CREATE TABLE treasures (
  id         {{ID_PK}},
  world_id   {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  island_id  {{INT}},
  x          {{REAL}} NOT NULL,
  y          {{REAL}} NOT NULL,
  contents   {{JSON}} NOT NULL DEFAULT '[]',
  found_by   {{ID_REF}},
  found_at   {{TS}},
  created_at {{TS}} NOT NULL
);

CREATE TABLE reputation (
  character_id {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  faction_key  {{TEXT}} NOT NULL,
  value        {{INT}} NOT NULL DEFAULT 0,
  PRIMARY KEY (character_id, faction_key)
);

CREATE TABLE faction_relations (
  world_id   {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  faction_a  {{TEXT}} NOT NULL,
  faction_b  {{TEXT}} NOT NULL,
  relation   {{REAL}} NOT NULL DEFAULT 0,
  at_war     {{BOOL}} NOT NULL DEFAULT 0,
  updated_at {{TS}} NOT NULL,
  PRIMARY KEY (world_id, faction_a, faction_b)
);
