-- Durable campaign state for contested outposts.
ALTER TABLE outposts ADD COLUMN last_captured_at {{TS}};
CREATE INDEX idx_outposts_campaign ON outposts (world_id, last_captured_at);
