-- Charts have to carry the thing they point at, not just a reference.
--
-- A rumour bought in a tavern is a position with a radius and a truth value; a
-- treasure map names an island. `ref_id` alone could hold none of that, so the
-- table gains a world, a JSON payload and a proper timestamp. `acquired_at`
-- stays as the historical column and is kept in step for existing rows.
ALTER TABLE charts ADD COLUMN world_id {{ID_REF}};
ALTER TABLE charts ADD COLUMN data {{JSON}} NOT NULL DEFAULT '{}';
ALTER TABLE charts ADD COLUMN created_at {{TS}} NOT NULL DEFAULT 0;

UPDATE charts SET created_at = acquired_at WHERE created_at = 0;

CREATE INDEX idx_charts_world ON charts (world_id, character_id);

-- A frozen season standing needs its place recorded. Deriving it from the
-- score ordering would be ambiguous on a tie, and the whole point of freezing
-- is that the row still means the same thing years later.
ALTER TABLE leaderboard_entries ADD COLUMN rank {{INT}} NOT NULL DEFAULT 0;
