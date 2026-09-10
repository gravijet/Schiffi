/**
 * End-to-end test.
 *
 * Boots the real server against a throwaway database, then drives it exactly
 * as a client would: HTTP for accounts and world data, WebSocket for play.
 * Nothing is stubbed - the assertions are about what the server actually did.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { useTestDatabase } from './testdb.mjs';
import WebSocket from 'ws';

const ROOT = resolve(import.meta.dirname, '../..');
// Everything the suite writes lives in one throwaway directory: the
// repository's own data/ belongs to the running game, not to the tests.
const TEST_DIR = resolve(tmpdir(), `schiffi-e2e-${process.pid}`);
const TEST_DB = resolve(TEST_DIR, 'e2e.db');
mkdirSync(TEST_DIR, { recursive: true });
process.env.UPLOADS_DIR = resolve(TEST_DIR, 'uploads');
process.env.MAIL_SPOOL_DIR = resolve(TEST_DIR, 'mail');
// Port 0 lets the OS pick a free port, so a leftover server from an earlier
// run can never make the suite hang on EADDRINUSE.
const PORT = 0;

process.env.NODE_ENV = 'test';
process.env.PORT = String(PORT);
process.env.SESSION_SECRET = 'test-secret-'.padEnd(64, 'x');
process.env.DEFAULT_WORLD_SEED = '424242';
process.env.SMTP_HOST = '';
// The suite exercises the password vault, so it needs a key. A fixed test
// key is fine: the database it opens is thrown away with the temp directory.
process.env.PASSWORD_VAULT_KEY = 'a'.repeat(64);
// Who the superadmin is, is a configured address rather than a role anybody
// can hold - so the suite names its own first account and then tests both
// sides of the boundary: what that account can do, and what every other
// account (including a full administrator) is told when it tries.
process.env.SUPERADMIN_EMAIL = 'captain@example.org';

// Empty database, SQLite or PostgreSQL depending on TEST_DATABASE_URL.
await useTestDatabase(TEST_DB);
process.env.STARTING_COINS = '5';

let BASE;
let wsPort;
let server;
let session = { cookie: null, token: null };
// The superadmin's session, kept aside: several tests register further
// accounts, and registering signs you in as the account you just made.
let rootCookie = null;
let guestCookie = null;

before(async () => {
  const { bootstrap } = await import('../src/index.js');
  server = await bootstrap({ listen: true });
  wsPort = server.http.port;
  BASE = `http://127.0.0.1:${wsPort}`;
});

after(async () => {
  await server.shutdown();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (session.cookie) headers.Cookie = session.cookie;
  const response = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) session.cookie = setCookie.split(';')[0];
  if (raw) return response;
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: response.status, body: json, text };
}

// ---------------------------------------------------------------------------

test('status endpoint reports nine locales and the full goods catalogue', async () => {
  const { status, body } = await api('/api/status');
  assert.equal(status, 200);
  assert.equal(body.status, 'online');
  assert.equal(body.locales.length, 9);
  assert.equal(body.goods, 1000);
});

/**
 * Registering grants nothing.
 *
 * The old behaviour - first account becomes the owner - is gone along with the
 * owner role itself. What makes this account all-powerful is only that its
 * address is the configured one, and even then it holds no role: there is no
 * row anywhere that another administrator could read and learn from.
 */
test('registration grants no role; the configured address is the superadmin', async () => {
  const { status, body } = await api('/api/auth/register', {
    method: 'POST',
    body: { email: 'captain@example.org', username: 'Captain', password: 'Nordwind-Segel-42', locale: 'de' },
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(body.userId);
  session.token = body.token;

  const me = await api('/api/auth/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.roles, [], 'the superadmin holds no role');
  assert.equal(me.body.superadmin, true);
  assert.ok(me.body.permissions.includes('users.view'));
  assert.ok(!me.body.permissions.includes('*'), 'the wildcard permission no longer exists');
  rootCookie = session.cookie;
});

test('a weak password is rejected with a translatable code', async () => {
  const { status, body } = await api('/api/auth/register', {
    method: 'POST',
    body: { email: 'weak@example.org', username: 'Weak', password: 'password' },
  });
  assert.equal(status, 400);
  assert.equal(body.code, 'error.weakPassword');
});

test('a duplicate username is rejected', async () => {
  const { status, body } = await api('/api/auth/register', {
    method: 'POST',
    body: { email: 'other@example.org', username: 'captain', password: 'Sturmvogel-Anker-99' },
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'error.usernameTaken');
});

test('guest play creates a signed-in account with a generated nickname', async () => {
  session.cookie = null;
  const created = await api('/api/auth/guest', {
    method: 'POST', body: { locale: 'de' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.match(created.body.username, /^[\p{L}\p{N}][\p{L}\p{N}_. -]{1,23}$/u);
  guestCookie = session.cookie;

  const me = await api('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.guest, true);
  assert.equal(me.body.user.email, null);
  assert.equal(me.body.user.emailVerified, true);
  session.cookie = rootCookie;
});

/**
 * Password material still leaks from nowhere *except* the one endpoint that is
 * meant to hand it over. The hash in particular must never appear anywhere:
 * the vault is a separate copy, and the thing a login is checked against stays
 * out of every response.
 */
test('only the reveal endpoint returns password material', async () => {
  const security = await api('/api/admin/users/1/security');
  assert.equal(security.status, 200);
  assert.equal(security.body.status.passwordAlgorithm, 'argon2id');
  assert.ok(!security.text.includes('$argon2'), 'security status leaked a hash');
  assert.ok(!security.text.includes('Nordwind-Segel-42'),
    'security status leaked the password itself - it reports state, not secrets');

  const detail = await api('/api/admin/users/1');
  assert.ok(!detail.text.includes('password_hash'), 'user detail leaked the hash column');
  assert.ok(!detail.text.includes('password_vault'), 'user detail leaked the sealed record');

  const exported = await api('/api/auth/export');
  assert.ok(!exported.text.includes('$argon2'), 'data export leaked a hash');
  assert.ok(!exported.text.includes('password_vault'), 'data export leaked the sealed record');

  const me = await api('/api/auth/me');
  assert.ok(!me.text.includes('$argon2') && !me.text.includes('password_vault'),
    'the session probe leaked password material');
});

test('the world exposes metadata and a compressed terrain blob', async () => {
  const worlds = await api('/api/worlds');
  assert.equal(worlds.status, 200);
  assert.ok(worlds.body.worlds.length >= 1);
  const worldId = worlds.body.worlds[0].id;

  const meta = await api(`/api/worlds/${worldId}`);
  assert.equal(meta.status, 200);
  assert.ok(meta.body.ports.length > 50, `expected many ports, got ${meta.body.ports.length}`);
  assert.ok(meta.body.regions.length > 0);
  assert.ok(meta.body.start.portId);

  const terrain = await api(`/api/worlds/${worldId}/terrain`, { raw: true });
  assert.equal(terrain.status, 200);
  const buffer = Buffer.from(await terrain.arrayBuffer());
  // fetch transparently decompresses, so this is the raw grid plus header.
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'SCHF');
  assert.equal(buffer.length, 16 + 1024 * 640);
});

let worldId;
let characterId;

test('a character starts with a boat, five coins and an empty hold', async () => {
  const worlds = await api('/api/worlds');
  worldId = worlds.body.worlds[0].id;

  const created = await api('/api/characters', {
    method: 'POST', body: { worldId, name: 'Seebaer', mode: 'trader' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  characterId = created.body.id;

  const character = created.body.character;
  assert.equal(character.coins, 5);
  assert.equal(character.ship.classKey, 'small_boat');
  assert.equal(character.cargo.length, 0);
  assert.equal(character.crew.length, 1);
  assert.equal(character.docked, true);
  assert.ok(character.protectionUntil > Date.now());
});

// --- WebSocket play --------------------------------------------------------

function connect() {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws`, { headers: { Cookie: session.cookie } });
    const inbox = [];
    const waiters = [];

    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      inbox.push(message);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].match(message)) {
          waiters[i].resolve(message);
          waiters.splice(i, 1);
        }
      }
    });
    ws.on('error', reject);
    ws.on('open', () => {
      resolvePromise({
        ws,
        inbox,
        send: (message) => ws.send(JSON.stringify(message)),
        waitFor(match, timeout = 8000) {
          const existing = inbox.find(match);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('timed out waiting for message')), timeout);
            waiters.push({ match, resolve: (m) => { clearTimeout(timer); res(m); } });
          });
        },
        async action(name, payload) {
          const rid = Math.random().toString(36).slice(2);
          this.send({ t: 'action', rid, action: name, payload });
          return this.waitFor((m) => m.t === 'result' && m.rid === rid);
        },
        close: () => ws.close(),
      });
    });
  });
}

let client;

test('a client can join the world over WebSocket', async () => {
  client = await connect();
  client.send({ t: 'hello', v: 1, characterId, token: session.token });
  const welcome = await client.waitFor((m) => m.t === 'welcome');
  assert.equal(welcome.worldId, worldId);
  assert.equal(welcome.character.name, 'Seebaer');
  assert.ok(welcome.seed);
  assert.ok(welcome.fog, 'fog bitmap missing from welcome');
});

test('the server sends snapshots and acknowledges input', async () => {
  await client.action('port.leave', {});
  for (let seq = 1; seq <= 12; seq++) {
    client.send({ t: 'input', s: seq, x: 1, y: 0, d: 0.05 });
    await new Promise((r) => setTimeout(r, 30));
  }
  const snapshot = await client.waitFor((m) => m.t === 'snapshot' && m.self.ack >= 12);
  assert.ok(snapshot.self.x > 0);
  assert.equal(typeof snapshot.wind.s, 'number');
  assert.ok(Array.isArray(snapshot.e));
});

test('the ship actually moves and cannot sail onto land', async () => {
  const before = await client.waitFor((m) => m.t === 'snapshot');
  const startX = before.self.x;
  const startY = before.self.y;

  for (let seq = 100; seq < 160; seq++) {
    client.send({ t: 'input', s: seq, x: 1, y: 0.3, d: 0.05 });
    await new Promise((r) => setTimeout(r, 20));
  }
  const after = await client.waitFor((m) => m.t === 'snapshot' && m.self.ack >= 159);
  const moved = Math.hypot(after.self.x - startX, after.self.y - startY);
  assert.ok(moved > 20, `ship barely moved: ${moved.toFixed(1)} units`);

  // Whatever it did, it is still on water: the server refuses land moves.
  const { getLoadedWorld } = await import('../src/game/worldManager.js');
  const instance = getLoadedWorld(worldId);
  const { NAVIGABLE, CELL_SIZE, CELLS_X } = await import('@schiffi/shared/world/constants.js');
  const cx = Math.floor(after.self.x / CELL_SIZE);
  const cy = Math.floor(after.self.y / CELL_SIZE);
  assert.equal(NAVIGABLE[instance.world.terrain[cy * CELLS_X + cx]], 1, 'ship ended up on land');
});

test('a speed hack is rejected: input is clamped and integrated server-side', async () => {
  const before = await client.waitFor((m) => m.t === 'snapshot');
  // Claim a direction vector of length 1000.
  for (let seq = 300; seq < 320; seq++) {
    client.send({ t: 'input', s: seq, x: 1000, y: 1000, d: 100 });
    await new Promise((r) => setTimeout(r, 20));
  }
  const after = await client.waitFor((m) => m.t === 'snapshot' && m.self.ack >= 319);
  const elapsedSeconds = 0.02 * 20 + 1;
  const distance = Math.hypot(after.self.x - before.self.x, after.self.y - before.self.y);
  // A small boat tops out around 46 units/s; allow generous slack for wind.
  assert.ok(distance < 46 * 3 * elapsedSeconds,
    `moved ${distance.toFixed(0)} units - the clamp is not holding`);
});

test('docking requires being close to the port', async () => {
  const meta = await api(`/api/worlds/${worldId}`);
  const farPort = meta.body.ports[meta.body.ports.length - 1];
  const result = await client.action('port.dock', { portId: farPort.id });
  assert.equal(result.error, 'error.tooFar');
});

test('buying and selling moves coins, cargo and the market price', async () => {
  // Teleport home by docking at the start port: the character is still near it.
  const meta = await api(`/api/worlds/${worldId}`);
  const startPort = meta.body.start.portId;

  // Give the captain something to trade with, through the real code path.
  const redeemed = await client.action('code.redeem', { code: 'BUMG 1718 LURT 1838 TOOO 1444 dav26' });
  assert.equal(redeemed.result.coins, 1000);

  const { getLoadedWorld } = await import('../src/game/worldManager.js');
  const instance = getLoadedWorld(worldId);
  const port = instance.portsById.get(startPort);
  // Move the character next to the port the honest way: the server owns the
  // position, so we ask the simulation, not the client.
  const player = instance.players.get(`p${characterId}`);
  player.x = port.x;
  player.y = port.y;

  const docked = await client.action('port.dock', { portId: startPort });
  assert.ok(docked.result?.docked, JSON.stringify(docked));

  const portInfo = await api(`/api/worlds/${worldId}/ports/${startPort}?characterId=${characterId}`);
  assert.equal(portInfo.status, 200);
  const affordable = portInfo.body.market.goods
    .filter((g) => g.buy <= 200 && g.stock > 20)
    .sort((a, b) => a.buy - b.buy)[0];
  assert.ok(affordable, 'no affordable good in the starting port');

  const priceBefore = affordable.buy;
  const buy = await client.action('trade.buy', { goodId: affordable.id, qty: 3 });
  assert.ok(!buy.error, JSON.stringify(buy));
  assert.equal(buy.result.qty, 3);
  assert.equal(buy.result.total, priceBefore * 3);

  const afterBuy = await api(`/api/characters/${characterId}`);
  assert.equal(afterBuy.body.coins, 1005 - buy.result.total);
  const lot = afterBuy.body.cargo.find((c) => c.goodId === affordable.id);
  assert.equal(lot.qty, 3);

  const sell = await client.action('trade.sell', { goodId: affordable.id, qty: 3 });
  assert.ok(!sell.error, JSON.stringify(sell));
  assert.ok(sell.result.total > 0);

  const afterSell = await api(`/api/characters/${characterId}`);
  assert.equal(afterSell.body.cargo.filter((c) => c.goodId === affordable.id).length, 0,
    'cargo was not removed on sale');
  assert.ok(afterSell.body.coins > 1005 - buy.result.total);
});

test('you cannot buy what you cannot afford', async () => {
  const meta = await api(`/api/worlds/${worldId}`);
  const startPort = meta.body.start.portId;
  const portInfo = await api(`/api/worlds/${worldId}/ports/${startPort}?characterId=${characterId}`);
  const expensive = portInfo.body.market.goods.sort((a, b) => b.buy - a.buy)[0];

  const result = await client.action('trade.buy', { goodId: expensive.id, qty: 100000 });
  assert.ok(result.error, 'an unaffordable order went through');
  assert.ok(['trade.notEnoughCoins', 'trade.notEnoughStock', 'trade.notEnoughSpace'].includes(result.error),
    `unexpected error ${result.error}`);
});

test('the repeatable code pays out every time, the one-shot code does not', async () => {
  const first = await client.action('code.redeem', { code: 'many coins dav26' });
  assert.equal(first.result.coins, 1_000_000_000_000);
  const second = await client.action('code.redeem', { code: 'MANY  Coins  DAV26' });
  assert.equal(second.result.coins, 1_000_000_000_000, 'repeatable code refused a second use');

  const repeat = await client.action('code.redeem', { code: 'BUMG 1718 LURT 1838 TOOO 1444 dav26' });
  assert.equal(repeat.error, 'code.alreadyUsed');

  const bogus = await client.action('code.redeem', { code: 'give me everything' });
  assert.equal(bogus.error, 'code.invalid');
});

test('chat is persisted and returned by the history endpoint', async () => {
  client.send({ t: 'chat.send', channel: 'global', body: 'Ahoi zusammen!' });
  const echoed = await client.waitFor((m) => m.t === 'chat' && m.body === 'Ahoi zusammen!');
  assert.equal(echoed.from, 'Seebaer');

  const history = await api(`/api/worlds/${worldId}/chat?channel=global`);
  assert.equal(history.status, 200);
  assert.ok(history.body.messages.some((m) => m.body === 'Ahoi zusammen!'));
});

test('roles can be created, assigned and enforced at runtime', async () => {
  const created = await api('/api/admin/roles', {
    method: 'POST',
    body: { key: 'harbourmaster', name: 'Harbourmaster', permissions: ['world.view', 'chat.mute'] },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const roles = await api('/api/admin/roles');
  const role = roles.body.roles.find((r) => r.key === 'harbourmaster');
  assert.deepEqual(role.permissions.sort(), ['chat.mute', 'world.view']);

  const wildcard = await api('/api/admin/roles', {
    method: 'POST', body: { key: 'godmode', name: 'God', permissions: ['*'] },
  });
  assert.equal(wildcard.status, 400, 'the wildcard was grantable to a new role');

  const del = await api(`/api/admin/roles/${role.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
});

test('an anonymous request cannot reach admin endpoints', async () => {
  const saved = session.cookie;
  session.cookie = null;
  const roles = await api('/api/admin/roles');
  assert.equal(roles.status, 401);
  const users = await api('/api/admin/users');
  assert.equal(users.status, 401);
  session.cookie = saved;
});

test('a support ticket is stored, answered and closed', async () => {
  const created = await api('/api/support/tickets', {
    method: 'POST',
    body: { subject: 'Mein Schiff steckt fest', category: 'bug', body: 'Es bewegt sich nicht mehr vom Fleck.' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const ticketId = created.body.id;

  const mine = await api('/api/support/tickets');
  assert.equal(mine.body.tickets.length, 1);
  assert.equal(mine.body.tickets[0].subject, 'Mein Schiff steckt fest');

  const read = await api(`/api/support/tickets/${ticketId}`);
  assert.equal(read.body.ticket.messages.length, 1);
  assert.equal(read.body.ticket.messages[0].body, 'Es bewegt sich nicht mehr vom Fleck.');
  // The author is not staff on their own ticket, even holding every permission.
  assert.equal(read.body.ticket.messages[0].staff, false);

  const reply = await api(`/api/support/tickets/${ticketId}/messages`, {
    method: 'POST', body: { body: 'Wir sehen uns das an.' },
  });
  assert.equal(reply.status, 200);

  const closed = await api(`/api/support/tickets/${ticketId}/close`, { method: 'POST' });
  assert.equal(closed.status, 200);

  const afterClose = await api(`/api/support/tickets/${ticketId}/messages`, {
    method: 'POST', body: { body: 'noch etwas' },
  });
  assert.equal(afterClose.status, 400, 'a closed ticket still accepted messages');

  const staffView = await api('/api/admin/support/tickets?status=closed');
  assert.equal(staffView.status, 200);
  assert.ok(staffView.body.tickets.some((ticket) => String(ticket.id) === String(ticketId)));
});

test('a support ticket cannot be read by another account', async () => {
  const created = await api('/api/support/tickets', {
    method: 'POST', body: { subject: 'Vertraulich', body: 'Das geht niemanden sonst etwas an.' },
  });
  const ticketId = created.body.id;
  const owner = session.cookie;

  // A fresh account with no permissions at all.
  session.cookie = null;
  const other = await api('/api/auth/register', {
    method: 'POST',
    body: { email: 'nosy@example.org', username: 'Neugier', password: 'Treibholz-Anker-77', locale: 'de' },
  });
  assert.equal(other.status, 200, JSON.stringify(other.body));

  const peek = await api(`/api/support/tickets/${ticketId}`);
  assert.equal(peek.status, 403, 'another account could read the ticket');
  const list = await api('/api/support/tickets');
  assert.equal(list.body.tickets.length, 0);
  const staff = await api('/api/admin/support/tickets');
  assert.equal(staff.status, 403, 'a player reached the staff queue');

  session.cookie = owner;
});

test('news is only public once it is published', async () => {
  const created = await api('/api/admin/news', {
    method: 'POST',
    body: {
      slug: 'erste-flotte',
      title: { de: 'Die erste Flotte', en: 'The first fleet' },
      body: { de: 'Nachricht auf Deutsch.', en: 'A message in English.' },
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const draft = await api('/api/news');
  assert.equal(draft.body.posts.length, 0, 'an unpublished draft was public');

  const published = await api(`/api/admin/news/${created.body.id}`, {
    method: 'PATCH', body: { publish: true },
  });
  assert.equal(published.status, 200);

  const live = await api('/api/news?locale=de');
  assert.equal(live.body.posts.length, 1);
  assert.equal(live.body.posts[0].title, 'Die erste Flotte');

  const english = await api('/api/news?locale=en');
  assert.equal(english.body.posts[0].title, 'The first fleet');

  // Tirolerisch has no text of its own, so it falls back rather than break.
  const tirol = await api('/api/news?locale=de-tirol');
  assert.equal(tirol.body.posts[0].title, 'Die erste Flotte');
});

test('an advert is reviewed before anyone sees it', async () => {
  const bad = await api('/api/ads', {
    method: 'POST',
    body: { title: 'Boot zu verkaufen', body: 'Ein sehr gutes Boot, kaum benutzt.', targetUrl: 'javascript:alert(1)' },
  });
  assert.equal(bad.status, 400, 'a javascript: URL was accepted');

  const created = await api('/api/ads', {
    method: 'POST',
    body: { title: 'Boot zu verkaufen', body: 'Ein sehr gutes Boot, kaum benutzt.', targetUrl: 'https://example.org/boot' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const beforeReview = await api('/api/ads');
  assert.equal(beforeReview.body.ads.length, 0, 'an unreviewed advert was served');

  const approved = await api(`/api/admin/ads/${created.body.id}`, {
    method: 'POST', body: { status: 'approved', note: 'in Ordnung' },
  });
  assert.equal(approved.status, 200);

  const served = await api('/api/ads');
  assert.equal(served.body.ads.length, 1);
  assert.equal(served.body.ads[0].targetUrl, 'https://example.org/boot');

  const click = await api(`/api/ads/${created.body.id}/click`, { method: 'POST' });
  assert.equal(click.status, 200);

  const queue = await api('/api/admin/ads?status=approved');
  const row = queue.body.ads.find((ad) => String(ad.id) === String(created.body.id));
  assert.equal(row.impressions, 1, `impressions were not counted: ${row.impressions}`);
  assert.equal(row.clicks, 1);
});

test('an avatar is stored only if it really is a WebP', async () => {
  // A PNG renamed to WebP must be refused: the magic bytes decide, not the
  // Content-Type the client claims.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const refused = await fetch(`${BASE}/api/auth/avatar`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/webp', Cookie: session.cookie },
    body: png,
  });
  assert.equal(refused.status, 400, 'a PNG was accepted as a WebP');

  // A minimal but genuine WebP container: "RIFF" + size + "WEBP" + a chunk.
  const payload = Buffer.alloc(64);
  payload.write('RIFF', 0, 'ascii');
  payload.writeUInt32LE(56, 4);
  payload.write('WEBP', 8, 'ascii');
  payload.write('VP8 ', 12, 'ascii');

  const stored = await fetch(`${BASE}/api/auth/avatar`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/webp', Cookie: session.cookie },
    body: payload,
  });
  const storedBody = await stored.json();
  assert.equal(stored.status, 200, JSON.stringify(storedBody));
  const { avatar } = storedBody;
  assert.match(avatar, /^\/api\/users\/\d+\/avatar/);

  const served = await fetch(`${BASE}${avatar}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/webp');
  const bytes = Buffer.from(await served.arrayBuffer());
  assert.equal(bytes.length, payload.length, 'the stored bytes changed on the way back');

  // It shows up on the account, as a URL rather than a path on disk.
  const me = await api('/api/auth/me');
  assert.equal(typeof me.body.user.avatar, 'string');
  assert.equal(me.body.user.avatarPath, undefined, 'the file name leaked to the client');

  const cleared = await api('/api/auth/avatar', { method: 'DELETE' });
  assert.equal(cleared.status, 200);
  const after = await api('/api/auth/me');
  assert.equal(after.body.user.avatar, null);
  assert.equal((await fetch(`${BASE}${avatar}`)).status, 404, 'a deleted avatar was still served');
});

test('an oversized avatar is refused', async () => {
  const big = Buffer.alloc(600 * 1024);
  big.write('RIFF', 0, 'ascii');
  big.write('WEBP', 8, 'ascii');
  const response = await fetch(`${BASE}/api/auth/avatar`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/webp', Cookie: session.cookie },
    body: big,
  });
  assert.equal(response.status, 413, 'a 600 KiB avatar got through');
});

test('the simulation is actually running', async () => {
  const status = await api(`/api/worlds/${worldId}/status`);
  assert.equal(status.body.loaded, true);
  assert.ok(status.body.tick > 20, `world only ticked ${status.body.tick} times`);
  assert.ok(status.body.npcs > 10, 'no NPC ships were spawned');
  client.close();
});

// --- the password vault ----------------------------------------------------
//
// The vault is the one place in this codebase that deliberately trades safety
// for an operator feature, so it gets tested from both sides: that it really
// returns the password when it should, and that it really refuses when it
// cannot - rather than returning something misleading.

test('a stored password can be read back by the superadmin', async () => {
  // The suite's first account holds the configured superadmin address.
  const registered = await api('/api/auth/register', {
    method: 'POST',
    body: { email: 'vault@example.org', username: 'VaultMate', password: 'Sturmflut-Anker-91', locale: 'de' },
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  const targetId = registered.body.userId;

  // Registering signed us in as the new account; go back to the superadmin.
  session.cookie = rootCookie;

  const revealed = await api(`/api/superadmin/users/${targetId}/password`, { method: 'POST' });
  assert.equal(revealed.status, 200, JSON.stringify(revealed.body));
  assert.equal(revealed.body.password, 'Sturmflut-Anker-91',
    'the vault did not return the password that was registered');
  assert.equal(revealed.body.reason, null);

  // The administration's own view of the same account says nothing about any
  // of this: an administrator must not be able to work out that a readable
  // copy exists at all.
  const security = await api(`/api/admin/users/${targetId}/security`);
  assert.equal(security.body.status.passwordAlgorithm, 'argon2id',
    'the vault must not have replaced the hash used for authentication');
  assert.ok(!security.text.includes('assword_vault'), 'the security view mentions the vault');
  assert.ok(!security.text.includes('passwordReadable'), 'the security view hints a password is readable');

  const overview = await api('/api/superadmin/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.body.vault.enabled, true);
});

test('the vault does not weaken the login itself', async () => {
  // The hash is still what a login is checked against: a wrong password must
  // fail even though the right one is sitting in the vault next to it.
  const bad = await api('/api/auth/login', {
    method: 'POST',
    body: { identifier: 'VaultMate', password: 'Sturmflut-Anker-92' },
  });
  assert.equal(bad.status, 401, 'a wrong password was accepted');

  const good = await api('/api/auth/login', {
    method: 'POST',
    body: { identifier: 'VaultMate', password: 'Sturmflut-Anker-91' },
  });
  assert.equal(good.status, 200, 'the right password stopped working');
  session.cookie = rootCookie;
});

/**
 * The other half of the boundary, and the more important half.
 *
 * An account that is not the superadmin must not merely be refused - it must
 * be told the address does not exist. A 403 confirms there is something there
 * to be forbidden from, which is exactly what this installation must not
 * admit. So: 404, for a plain player and for a full administrator alike.
 */
test('to everybody else the superadmin routes do not exist', async () => {
  const outsider = await api('/api/auth/register', {
    method: 'POST',
    body: { email: 'deckhand@example.org', username: 'Deckhand', password: 'Kompass-Laterne-77', locale: 'en' },
  });
  assert.equal(outsider.status, 200);

  // A plain player.
  for (const path of ['/api/superadmin/overview', '/api/superadmin/interstitials']) {
    const attempt = await api(path);
    assert.equal(attempt.status, 404, `${path} admitted it exists to a player`);
  }
  const read = await api('/api/superadmin/users/1/password', { method: 'POST' });
  assert.equal(read.status, 404, 'a player was told the reveal endpoint exists');

  // Now the same account with every permission an administrator can hold.
  const { getDatabase } = await import('../src/db/index.js');
  const db = getDatabase();
  const me = await db.get('SELECT id FROM users WHERE username_norm = ?', ['deckhand']);
  const role = await db.get('SELECT id FROM roles WHERE key = ?', ['admin']);
  await db.run('INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)',
    [me.id, role.id, Date.now()]);
  const { invalidateAll } = await import('../src/services/rbac.js');
  invalidateAll();

  const asAdmin = await api('/api/superadmin/overview');
  assert.equal(asAdmin.status, 404, 'a full administrator was shown the superadmin surface');
  const adminRead = await api('/api/superadmin/users/1/password', { method: 'POST' });
  assert.equal(adminRead.status, 404, 'a full administrator could see the reveal endpoint');

  // And nothing in the catalogue an administrator can read names it.
  const permissions = await api('/api/admin/permissions');
  const keys = permissions.body.permissions.map((entry) => entry.key);
  assert.ok(!keys.includes('*'), 'the wildcard permission is still on offer');
  assert.ok(!keys.some((key) => key.includes('reveal')), 'a reveal permission is visible to administrators');
  assert.ok(!keys.includes('audit.view'), 'the audit permission outlived the audit log');

  const roles = await api('/api/admin/roles');
  const roleKeys = roles.body.roles.map((entry) => entry.key);
  assert.ok(!roleKeys.includes('owner'), 'the owner role still exists');
  assert.ok(roleKeys.includes('advertiser'), 'the advertiser role was not created');

  session.cookie = rootCookie;
});

test('the audit log is gone, table and route alike', async () => {
  const route = await api('/api/admin/audit');
  assert.equal(route.status, 404, 'the audit route still answers');

  const { getDatabase } = await import('../src/db/index.js');
  const db = getDatabase();
  const rows = await db.all('SELECT 1 AS x FROM audit_log LIMIT 1').then(() => 'table still there',
    () => 'table gone');
  assert.equal(rows, 'table gone');
});

test('a password set before the vault existed is reported as unreadable, not as an error', async () => {
  const { getDatabase } = await import('../src/db/index.js');
  const db = getDatabase();
  const row = await db.get('SELECT id FROM users WHERE username_norm = ?', ['vaultmate']);
  // Exactly the state of an account that predates the key.
  await db.run('UPDATE users SET password_vault = NULL, password_vault_at = NULL WHERE id = ?', [row.id]);

  const revealed = await api(`/api/superadmin/users/${row.id}/password`, { method: 'POST' });
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.password, null);
  assert.equal(revealed.body.reason, 'notStored',
    'the console would have shown a generic failure instead of the real reason');

  // The administrator's view is unchanged by any of this - it never carried
  // the field in the first place.
  const security = await api(`/api/admin/users/${row.id}/security`);
  assert.equal(security.status, 200);
  assert.equal(security.body.status.passwordReadable, undefined);
});

test('changing a password refreshes what the vault holds', async () => {
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { identifier: 'Deckhand', password: 'Kompass-Laterne-77' },
  });
  assert.equal(login.status, 200);

  const changed = await api('/api/auth/password', {
    method: 'POST',
    body: { currentPassword: 'Kompass-Laterne-77', newPassword: 'Steuerbord-Nordlicht-08' },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  const { getDatabase } = await import('../src/db/index.js');
  const row = await getDatabase().get('SELECT id FROM users WHERE username_norm = ?', ['deckhand']);
  session.cookie = rootCookie;

  const revealed = await api(`/api/superadmin/users/${row.id}/password`, { method: 'POST' });
  assert.equal(revealed.body.password, 'Steuerbord-Nordlicht-08',
    'the vault still held the old password after a change');
});

test('the vault stores ciphertext, never the password itself', async () => {
  const { getDatabase } = await import('../src/db/index.js');
  const rows = await getDatabase().all('SELECT password_vault FROM users WHERE password_vault IS NOT NULL');
  assert.ok(rows.length > 0, 'nothing was sealed at all');
  for (const row of rows) {
    assert.ok(!/Steuerbord-Nordlicht-08|Sturmflut-Anker-91|Nordwind-Segel-42/.test(row.password_vault),
      'a password was written to the database in clear text');
    assert.match(row.password_vault, /^v1\./, 'the sealed record is not in the expected format');
  }
});

test('private player worlds stay hidden until their share code is used', async () => {
  session.cookie = rootCookie;
  const created = await api('/api/worlds', {
    method: 'POST',
    body: { name: 'Verborgene See', seed: 987654321, maxPlayers: 12, visibility: 'private' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.visibility, 'private');
  assert.match(created.body.inviteCode, /^[A-Z0-9]{6,8}$/);
  const privateId = created.body.id;

  session.cookie = null;
  const anonymous = await api('/api/worlds');
  assert.ok(!anonymous.body.worlds.some((world) => String(world.id) === String(privateId)));
  const anonymousStatus = await api(`/api/worlds/${privateId}/status`);
  assert.equal(anonymousStatus.status, 404);

  session.cookie = guestCookie;
  const before = await api(`/api/worlds/${privateId}`);
  assert.equal(before.status, 404);
  const joined = await api('/api/worlds/join', {
    method: 'POST', body: { code: created.body.inviteCode.toLowerCase() },
  });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const visible = await api('/api/worlds');
  assert.ok(visible.body.worlds.some((world) => String(world.id) === String(privateId)));
  const status = await api(`/api/worlds/${privateId}/status`);
  assert.equal(status.status, 200);
  assert.equal(status.body.loaded, true);
  session.cookie = rootCookie;
});

test('superadmin runtime settings persist secrets encrypted and apply immediately', async () => {
  const updated = await api('/api/superadmin/settings', {
    method: 'PATCH',
    body: {
      mail: { host: 'smtp.test.invalid', port: 465, secure: true, user: 'mailer', pass: 'smtp-secret', from: 'Schiffi <mail@test.invalid>' },
      uploads: { maxMediaMiB: 1024 },
      game: { startingCoins: 7, maxPlayersPerWorld: 300, newbieProtectionMinutes: 120 },
    },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.settings.uploads.maxMediaMiB, 1024);
  assert.equal(updated.body.settings.game.startingCoins, 7);
  assert.equal(updated.body.settings.mail.passwordConfigured, true);
  assert.ok(!updated.text.includes('smtp-secret'));

  const { getDatabase } = await import('../src/db/index.js');
  const stored = await getDatabase().get("SELECT value, secret FROM system_settings WHERE key = 'mail.pass'");
  assert.equal(Boolean(stored.secret), true);
  assert.match(stored.value, /^v1\./);
  assert.ok(!stored.value.includes('smtp-secret'));

  // Keep the remainder of this isolated suite on the mail spool; the setting
  // test must not turn later account registrations into real network calls.
  const restored = await api('/api/superadmin/settings', {
    method: 'PATCH', body: { mail: { host: '' } },
  });
  assert.equal(restored.status, 200);
});

test('an administrator can adjust a character economy without making it negative', async () => {
  session.cookie = rootCookie;
  const before = await api(`/api/characters/${characterId}`);
  const granted = await api(`/api/admin/characters/${characterId}/economy`, {
    method: 'PATCH', body: { coins: 321, bank: 12, xp: 5 },
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal(granted.body.character.coins, before.body.coins + 321);

  const clamped = await api(`/api/admin/characters/${characterId}/economy`, {
    method: 'PATCH', body: { coins: -1_000_000_000_000 },
  });
  assert.equal(clamped.status, 200);
  assert.equal(clamped.body.applied.coins, -1_000_000_000_000);
  assert.equal(clamped.body.character.coins,
    Math.max(0, before.body.coins + 321 - 1_000_000_000_000));
  // Earlier in this suite a repeatable test code deliberately paid out two
  // trillion coins, so drain two more bounded admin adjustments to reach the
  // lower clamp.
  await api(`/api/admin/characters/${characterId}/economy`, {
    method: 'PATCH', body: { coins: -1_000_000_000_000 },
  });
  const zero = await api(`/api/admin/characters/${characterId}/economy`, {
    method: 'PATCH', body: { coins: -1_000_000_000_000 },
  });
  assert.equal(zero.body.character.coins, 0);
});

// ---------------------------------------------------------------------------
// Advertising: the role that lets a player upload one, and the advert the
// superadmin puts in front of the site.

/** A minimal but genuine WebP container: "RIFF" + size + "WEBP" + a chunk. */
function webp(bytes = 64) {
  const payload = Buffer.alloc(bytes);
  payload.write('RIFF', 0, 'ascii');
  payload.writeUInt32LE(bytes - 8, 4);
  payload.write('WEBP', 8, 'ascii');
  payload.write('VP8 ', 12, 'ascii');
  return payload;
}

/** A structurally identifiable MP4 payload, deliberately larger than 1 MiB. */
function mp4(bytes = 2 * 1024 * 1024) {
  const payload = Buffer.alloc(bytes);
  payload.writeUInt32BE(24, 0);
  payload.write('ftyp', 4, 'ascii');
  payload.write('isom', 8, 'ascii');
  return payload;
}

test('uploading an advert needs the advertiser role, and nothing more', async () => {
  const account = await api('/api/auth/register', {
    method: 'POST',
    body: { email: 'werber@example.org', username: 'Werber', password: 'Leuchtturm-Kompass-12', locale: 'de' },
  });
  assert.equal(account.status, 200);
  const advertiserId = account.body.userId;
  const advertiserCookie = session.cookie;

  const advert = {
    title: 'Segeltuch vom Hafenmeister',
    body: 'Reissfestes Tuch, geliefert in jeden Hafen der Nordsee.',
    targetUrl: 'https://example.com/segeltuch',
  };

  // Without the role: refused. This is a permission, not a hidden thing, so
  // 403 is the right answer here - unlike the superadmin surface.
  const refused = await api('/api/ads', { method: 'POST', body: advert });
  assert.equal(refused.status, 403, 'any account could upload advertising');

  // Grant it the way an administrator would.
  session.cookie = rootCookie;
  const roles = await api('/api/admin/roles');
  const advertiser = roles.body.roles.find((role) => role.key === 'advertiser');
  assert.ok(advertiser, 'the advertiser role is missing');
  assert.deepEqual(advertiser.permissions, ['ads.submit'],
    'the advertiser role must grant exactly one thing');
  const granted = await api(`/api/admin/users/${advertiserId}/roles/${advertiser.id}`, { method: 'POST' });
  assert.equal(granted.status, 200);

  session.cookie = advertiserCookie;
  const created = await api('/api/ads', { method: 'POST', body: advert });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.status, 'pending');

  // The picture is real bytes, checked against the format's magic number.
  const badImage = await fetch(`${BASE}/api/ads/${created.body.id}/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/webp', Cookie: session.cookie },
    body: Buffer.from('not an image at all'),
  });
  assert.equal(badImage.status, 400, 'anything at all was accepted as an image');

  const image = await fetch(`${BASE}/api/ads/${created.body.id}/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/webp', Cookie: session.cookie },
    body: webp(),
  });
  assert.equal(image.status, 200);
  const { image: imageUrl } = await image.json();
  assert.match(imageUrl, /^\/media\/ads\/[0-9a-f]{20}\.webp$/);

  const served = await fetch(`${BASE}${imageUrl}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/webp');

  // Video uploads bypass the ordinary 1 MiB JSON body reader and are streamed
  // to disk. Replacing the image also sends the advert back to review.
  const videoBytes = mp4();
  const firstVideoChunk = await fetch(`${BASE}/api/ads/${created.body.id}/image`, {
    method: 'POST',
    headers: {
      'Content-Type': 'video/mp4', Cookie: session.cookie,
      'Content-Range': `bytes 0-${1024 * 1024 - 1}/${videoBytes.length}`,
    },
    body: videoBytes.subarray(0, 1024 * 1024),
  });
  assert.equal(firstVideoChunk.status, 200);
  const progress = await firstVideoChunk.json();
  assert.equal(progress.complete, false);
  assert.equal(progress.received, 1024 * 1024);

  const video = await fetch(`${BASE}/api/ads/${created.body.id}/image`, {
    method: 'POST',
    headers: {
      'Content-Type': 'video/mp4', Cookie: session.cookie,
      'Content-Range': `bytes ${1024 * 1024}-${videoBytes.length - 1}/${videoBytes.length}`,
      'X-Upload-Id': progress.uploadId,
    },
    body: videoBytes.subarray(1024 * 1024),
  });
  const videoText = await video.text();
  assert.equal(video.status, 200, videoText);
  const uploadedVideo = JSON.parse(videoText);
  assert.equal(uploadedVideo.kind, 'video');
  assert.match(uploadedVideo.video, /^\/media\/ads\/[0-9a-f]{20}\.mp4$/);

  const range = await fetch(`${BASE}${uploadedVideo.video}`, { headers: { Range: 'bytes=0-11' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-11/${2 * 1024 * 1024}`);
  assert.equal((await range.arrayBuffer()).byteLength, 12);
  const suffix = await fetch(`${BASE}${uploadedVideo.video}`, { headers: { Range: 'bytes=-16' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'),
    `bytes ${2 * 1024 * 1024 - 16}-${2 * 1024 * 1024 - 1}/${2 * 1024 * 1024}`);
  assert.equal((await suffix.arrayBuffer()).byteLength, 16);

  // The role grants nothing beyond advertising.
  const users = await api('/api/admin/users');
  assert.equal(users.status, 403, 'the advertiser role reached the user list');

  // Unapproved, so nobody sees it yet.
  const publicBefore = await api('/api/ads');
  assert.ok(!publicBefore.body.ads.some((ad) => ad.id === created.body.id),
    'an unreviewed advert was served to visitors');

  session.cookie = rootCookie;
  const approved = await api(`/api/admin/ads/${created.body.id}`, {
    method: 'POST', body: { status: 'approved', note: 'passt' },
  });
  assert.equal(approved.status, 200);

  const publicAfter = await api('/api/ads');
  const shown = publicAfter.body.ads.find((ad) => ad.id === created.body.id);
  assert.ok(shown, 'an approved advert was not served');
  assert.equal(shown.image, null);
  assert.equal(shown.video, uploadedVideo.video);

  // Media and target links are optional: plain text is a valid advert.
  session.cookie = advertiserCookie;
  const textOnly = await api('/api/ads', {
    method: 'POST', body: { title: 'Nur eine Nachricht' },
  });
  assert.equal(textOnly.status, 200, JSON.stringify(textOnly.body));
  session.cookie = rootCookie;
  await api(`/api/admin/ads/${textOnly.body.id}`, {
    method: 'POST', body: { status: 'approved', note: 'Text reicht' },
  });
  const publicText = await api('/api/ads');
  const plain = publicText.body.ads.find((ad) => ad.id === textOnly.body.id);
  assert.ok(plain);
  assert.equal(plain.image, null);
  assert.equal(plain.video, null);

  // The advertiser sees the figures the server counted, not an estimate.
  session.cookie = advertiserCookie;
  const mine = await api('/api/ads/mine');
  const own = mine.body.ads.find((ad) => ad.id === created.body.id);
  assert.equal(own.status, 'approved');
  assert.ok(own.impressions >= 1, 'the impression was not counted');
  session.cookie = rootCookie;
});

test('the advert in front of the site is the superadmin\'s alone', async () => {
  // Nothing is shown until something is switched on.
  const empty = await api('/api/interstitial');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.interstitial, null, 'something was shown before anything was created');

  const created = await api('/api/superadmin/interstitials', {
    method: 'POST',
    body: { headline: 'Neu: Winterrouten', body: 'Ab sofort befahrbar.', targetUrl: 'https://example.com/winter', seconds: 3 },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const withImage = await fetch(`${BASE}/api/superadmin/interstitials/${created.body.id}/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/webp', Cookie: session.cookie },
    body: webp(),
  });
  assert.equal(withImage.status, 200);

  // Created is not the same as shown.
  const stillEmpty = await api('/api/interstitial');
  assert.equal(stillEmpty.body.interstitial, null, 'a new advert switched itself on');

  const shown = await api(`/api/superadmin/interstitials/${created.body.id}`, {
    method: 'PATCH', body: { active: true },
  });
  assert.equal(shown.status, 200);

  const visitor = await api('/api/interstitial');
  assert.equal(visitor.body.interstitial.headline, 'Neu: Winterrouten');
  assert.equal(visitor.body.interstitial.seconds, 3);
  assert.match(visitor.body.interstitial.image, /^\/media\/ads\//);

  // Only ever one. Switching a second one on switches the first one off.
  const second = await api('/api/superadmin/interstitials', {
    method: 'POST', body: { headline: 'Zweite', seconds: 0 },
  });
  await api(`/api/superadmin/interstitials/${second.body.id}`, { method: 'PATCH', body: { active: true } });
  const after = await api('/api/superadmin/interstitials');
  assert.deepEqual(after.body.interstitials.filter((item) => item.active).map((item) => item.id),
    [second.body.id], 'two adverts were active at once');

  // A click is counted, and a click on an inactive advert is not.
  const click = await api(`/api/interstitial/${second.body.id}/click`, { method: 'POST' });
  assert.equal(click.status, 200);
  const stale = await api(`/api/interstitial/${created.body.id}/click`, { method: 'POST' });
  assert.equal(stale.status, 404, 'a click on a switched-off advert was counted');

  await api(`/api/superadmin/interstitials/${second.body.id}`, { method: 'PATCH', body: { active: false } });
  const gone = await api('/api/interstitial');
  assert.equal(gone.body.interstitial, null);
});

test('a javascript: link is refused wherever a link is accepted', async () => {
  const advert = await api('/api/superadmin/interstitials', {
    method: 'POST',
    body: { headline: 'Boes', targetUrl: 'javascript:alert(1)', seconds: 0 },
  });
  assert.equal(advert.status, 400, 'a javascript: URL was stored as an advert target');
});
