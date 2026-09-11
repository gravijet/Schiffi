-- Bilateral company treaties power the strategic alliance layer.
-- A company can maintain one treaty at a time, keeping map colours and
-- territorial ownership legible even in a busy world.
CREATE TABLE guild_alliances (
  id                 {{ID_PK}},
  world_id           {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  proposer_guild_id  {{ID_REF}} NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  recipient_guild_id {{ID_REF}} NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  status             {{TEXT}} NOT NULL DEFAULT 'pending',
  created_at         {{TS}} NOT NULL,
  accepted_at        {{TS}}
);
CREATE INDEX idx_guild_alliances_world ON guild_alliances (world_id, status);
CREATE INDEX idx_guild_alliances_proposer ON guild_alliances (proposer_guild_id, status);
CREATE INDEX idx_guild_alliances_recipient ON guild_alliances (recipient_guild_id, status);
