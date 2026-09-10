-- Rewarded ads: a player may watch an approved 'reward'-placement advert and
-- be paid coins for it. The cooldown lives on the character so it survives a
-- server restart, and completions are counted separately from clicks so an
-- advertiser's payout figures are never confused with a player's payout.

ALTER TABLE characters ADD COLUMN last_ad_reward_at {{TS}};
ALTER TABLE ads ADD COLUMN completions {{BIGINT}} NOT NULL DEFAULT 0;
