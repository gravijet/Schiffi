-- Markets, prices, banking, auctions, companies and outposts.

-- One row per (world, port, good) that a port actually trades.  Stock and
-- demand are simulated; price is derived from them, never stored blindly.
CREATE TABLE port_market (
  world_id   {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  port_id    {{TEXT}} NOT NULL,
  good_id    {{INT}} NOT NULL,
  stock      {{REAL}} NOT NULL,
  base_stock {{REAL}} NOT NULL,
  demand     {{REAL}} NOT NULL,
  price      {{REAL}} NOT NULL,
  produced   {{BOOL}} NOT NULL DEFAULT 0,
  updated_at {{TS}} NOT NULL,
  PRIMARY KEY (world_id, port_id, good_id)
);
CREATE INDEX idx_market_port ON port_market (world_id, port_id);

-- Hourly price samples, retained for the 7-day chart.
CREATE TABLE price_history (
  id       {{ID_PK}},
  world_id {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  port_id  {{TEXT}} NOT NULL,
  good_id  {{INT}} NOT NULL,
  at       {{TS}} NOT NULL,
  price    {{REAL}} NOT NULL
);
CREATE INDEX idx_price_history_lookup ON price_history (world_id, port_id, good_id, at);

CREATE TABLE loans (
  id          {{ID_PK}},
  character_id {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  principal   {{BIGINT}} NOT NULL,
  outstanding {{BIGINT}} NOT NULL,
  rate        {{REAL}} NOT NULL,
  taken_at    {{TS}} NOT NULL,
  due_at      {{TS}} NOT NULL,
  repaid_at   {{TS}},
  defaulted   {{BOOL}} NOT NULL DEFAULT 0
);
CREATE INDEX idx_loans_character ON loans (character_id);

CREATE TABLE insurance_policies (
  id           {{ID_PK}},
  character_id {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  ship_id      {{ID_REF}} NOT NULL REFERENCES ships(id) ON DELETE CASCADE,
  premium      {{BIGINT}} NOT NULL,
  coverage     {{BIGINT}} NOT NULL,
  starts_at    {{TS}} NOT NULL,
  ends_at      {{TS}} NOT NULL,
  claimed_at   {{TS}},
  payout       {{BIGINT}}
);

CREATE TABLE auctions (
  id            {{ID_PK}},
  world_id      {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  seller_id     {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  good_id       {{INT}} NOT NULL,
  qty           {{INT}} NOT NULL,
  freshness     {{REAL}} NOT NULL DEFAULT 1.0,
  start_price   {{BIGINT}} NOT NULL,
  buyout_price  {{BIGINT}},
  current_bid   {{BIGINT}},
  bidder_id     {{ID_REF}},
  created_at    {{TS}} NOT NULL,
  ends_at       {{TS}} NOT NULL,
  status        {{TEXT}} NOT NULL DEFAULT 'open',
  settled_at    {{TS}}
);
CREATE INDEX idx_auctions_open ON auctions (world_id, status, ends_at);

CREATE TABLE auction_bids (
  id         {{ID_PK}},
  auction_id {{ID_REF}} NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  bidder_id  {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  amount     {{BIGINT}} NOT NULL,
  at         {{TS}} NOT NULL
);

-- The global marketplace is a fixed-price order book, separate from auctions.
CREATE TABLE market_listings (
  id         {{ID_PK}},
  world_id   {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  seller_id  {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  good_id    {{INT}} NOT NULL,
  qty        {{INT}} NOT NULL,
  unit_price {{BIGINT}} NOT NULL,
  freshness  {{REAL}} NOT NULL DEFAULT 1.0,
  created_at {{TS}} NOT NULL,
  status     {{TEXT}} NOT NULL DEFAULT 'open'
);
CREATE INDEX idx_listings_good ON market_listings (world_id, good_id, status);

-- Direct player-to-player trade: both sides must confirm, then it applies
-- atomically inside one transaction.
CREATE TABLE trade_offers (
  id            {{ID_PK}},
  world_id      {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  from_id       {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  to_id         {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  offer_goods   {{JSON}} NOT NULL DEFAULT '[]',
  offer_coins   {{BIGINT}} NOT NULL DEFAULT 0,
  request_goods {{JSON}} NOT NULL DEFAULT '[]',
  request_coins {{BIGINT}} NOT NULL DEFAULT 0,
  from_confirmed {{BOOL}} NOT NULL DEFAULT 0,
  to_confirmed   {{BOOL}} NOT NULL DEFAULT 0,
  status        {{TEXT}} NOT NULL DEFAULT 'open',
  created_at    {{TS}} NOT NULL,
  settled_at    {{TS}}
);

CREATE TABLE companies (
  id           {{ID_PK}},
  world_id     {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  character_id {{ID_REF}} NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name         {{TEXT}} NOT NULL,
  capital      {{BIGINT}} NOT NULL DEFAULT 0,
  created_at   {{TS}} NOT NULL
);

CREATE TABLE trade_routes (
  id           {{ID_PK}},
  company_id   {{ID_REF}} NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         {{TEXT}} NOT NULL,
  ship_class   {{TEXT}} NOT NULL,
  waypoints    {{JSON}} NOT NULL DEFAULT '[]',
  cargo_plan   {{JSON}} NOT NULL DEFAULT '[]',
  status       {{TEXT}} NOT NULL DEFAULT 'idle',
  leg_index    {{INT}} NOT NULL DEFAULT 0,
  next_arrival_at {{TS}},
  total_profit {{BIGINT}} NOT NULL DEFAULT 0,
  runs         {{INT}} NOT NULL DEFAULT 0,
  created_at   {{TS}} NOT NULL
);
CREATE INDEX idx_routes_company ON trade_routes (company_id);

CREATE TABLE outposts (
  id           {{ID_PK}},
  world_id     {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  owner_id     {{ID_REF}} REFERENCES characters(id) ON DELETE SET NULL,
  guild_id     {{ID_REF}},
  island_id    {{INT}},
  name         {{TEXT}} NOT NULL,
  x            {{REAL}} NOT NULL,
  y            {{REAL}} NOT NULL,
  created_at   {{TS}} NOT NULL
);

CREATE TABLE outpost_buildings (
  id         {{ID_PK}},
  outpost_id {{ID_REF}} NOT NULL REFERENCES outposts(id) ON DELETE CASCADE,
  kind       {{TEXT}} NOT NULL,
  level      {{INT}} NOT NULL DEFAULT 1,
  built_at   {{TS}} NOT NULL
);

CREATE TABLE missions (
  id         {{ID_PK}},
  world_id   {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  port_id    {{TEXT}} NOT NULL,
  type       {{TEXT}} NOT NULL,
  data       {{JSON}} NOT NULL DEFAULT '{}',
  reward     {{BIGINT}} NOT NULL,
  reputation {{JSON}} NOT NULL DEFAULT '{}',
  deadline   {{TS}},
  taken_by   {{ID_REF}} REFERENCES characters(id) ON DELETE SET NULL,
  taken_at   {{TS}},
  status     {{TEXT}} NOT NULL DEFAULT 'open',
  created_at {{TS}} NOT NULL
);
CREATE INDEX idx_missions_port ON missions (world_id, port_id, status);

CREATE TABLE passengers (
  id           {{ID_PK}},
  world_id     {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  ship_id      {{ID_REF}} REFERENCES ships(id) ON DELETE CASCADE,
  from_port    {{TEXT}} NOT NULL,
  to_port      {{TEXT}} NOT NULL,
  name         {{TEXT}} NOT NULL,
  fare         {{INT}} NOT NULL,
  comfort_req  {{INT}} NOT NULL DEFAULT 0,
  boarded_at   {{TS}},
  delivered_at {{TS}},
  deadline     {{TS}}
);

CREATE TABLE rumours (
  id         {{ID_PK}},
  world_id   {{ID_REF}} NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  port_id    {{TEXT}} NOT NULL,
  kind       {{TEXT}} NOT NULL,
  data       {{JSON}} NOT NULL DEFAULT '{}',
  price      {{INT}} NOT NULL DEFAULT 0,
  truth      {{REAL}} NOT NULL DEFAULT 1,
  created_at {{TS}} NOT NULL,
  expires_at {{TS}} NOT NULL
);
