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

// Empty database, SQLite or PostgreSQL depending on TEST_DATABASE_URL.
await useTestDatabase(TEST_DB);
process.env.STARTING_COINS = '5';

let BASE;
let wsPort;
let server;
let session = { cookie: null, token: null };
// The owner's session, kept aside: several tests register further accounts,
// and registering signs you in as the account you just made.
let ownerCookie = null;

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

test('registration creates the first account as owner', async () => {
  const { status, body } = await api('/api/auth/register', {
    method: 'POST',
    body: { email: 'captain@example.org', username: 'Captain', password: 'Nordwind-Segel-42', locale: 'de' },
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(body.userId);
  session.token = body.token;

  const me = await api('/api/auth/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.roles, ['owner']);
  assert.ok(me.body.permissions.includes('*'));
  ownerCookie = session.cookie;
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

test('a stored password can be read back by an owner, and the read is audited', async () => {
  // The suite's first account is the owner and holds the wildcard.
  const registered = await api('/api/auth/register', {
    method: 'POST',
    body: { email: 'vault@example.org', username: 'VaultMate', password: 'Sturmflut-Anker-91', locale: 'de' },
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  const targetId = registered.body.userId;

  // Registering signed us in as the new account; go back to the owner.
  session.cookie = ownerCookie;

  const revealed = await api(`/api/admin/users/${targetId}/password/reveal`, { method: 'POST' });
  assert.equal(revealed.status, 200, JSON.stringify(revealed.body));
  assert.equal(revealed.body.password, 'Sturmflut-Anker-91',
    'the vault did not return the password that was registered');
  assert.equal(revealed.body.reason, null);

  const security = await api(`/api/admin/users/${targetId}/security`);
  assert.equal(security.body.status.passwordReadable, true);
  assert.equal(security.body.status.passwordAlgorithm, 'argon2id',
    'the vault must not have replaced the hash used for authentication');

  const audit = await api('/api/admin/audit?action=user.password_revealed');
  assert.ok(audit.body.entries.some((e) => String(e.target_id) === String(targetId)),
    'reading a password left no audit entry');
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
  session.cookie = ownerCookie;
});

test('an ordinary account cannot read anyone\'s password', async () => {
  const outsider = await api('/api/auth/register', {
    method: 'POST',
    body: { email: 'deckhand@example.org', username: 'Deckhand', password: 'Kompass-Laterne-77', locale: 'en' },
  });
  assert.equal(outsider.status, 200);

  // Still signed in as Nosy, who holds no admin permission at all.
  const attempt = await api('/api/admin/users/1/password/reveal', { method: 'POST' });
  assert.equal(attempt.status, 403, 'a player without the permission read a password');
  session.cookie = ownerCookie;
});

test('a password set before the vault existed is reported as unreadable, not as an error', async () => {
  const { getDatabase } = await import('../src/db/index.js');
  const db = getDatabase();
  const row = await db.get('SELECT id FROM users WHERE username_norm = ?', ['vaultmate']);
  // Exactly the state of an account that predates the key.
  await db.run('UPDATE users SET password_vault = NULL, password_vault_at = NULL WHERE id = ?', [row.id]);

  const revealed = await api(`/api/admin/users/${row.id}/password/reveal`, { method: 'POST' });
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.password, null);
  assert.equal(revealed.body.reason, 'notStored',
    'the console would have shown a generic failure instead of the real reason');

  const security = await api(`/api/admin/users/${row.id}/security`);
  assert.equal(security.body.status.passwordReadable, false);
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
  session.cookie = ownerCookie;

  const revealed = await api(`/api/admin/users/${row.id}/password/reveal`, { method: 'POST' });
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
