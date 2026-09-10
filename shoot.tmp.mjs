import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = '/home/benj/Schiffi';
const SHOTS = '/tmp/claude-1000/-home-benj-Schiffi/ac607969-b9fd-4ab6-8509-5013c5742571/scratchpad/shots';
const TEST_DB = resolve(ROOT, `data/shot-${process.pid}.db`);

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.SQLITE_PATH = TEST_DB;
process.env.DATABASE_URL = '';
process.env.SESSION_SECRET = 'shot-'.padEnd(64, 'z');
process.env.DEFAULT_WORLD_SEED = '20260910';
process.env.SMTP_HOST = '';

for (const s of ['', '-wal', '-shm']) rmSync(`${TEST_DB}${s}`, { force: true });
mkdirSync(resolve(ROOT, 'data'), { recursive: true });

const { bootstrap } = await import(`${ROOT}/server/src/index.js`);
const server = await bootstrap({ listen: true });
const base = `http://127.0.0.1:${server.http.port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const shot = async (n) => { await page.screenshot({ path: `${SHOTS}/${n}.png` }); console.log('shot', n); };

await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.lang-grid', { timeout: 30_000 });
await page.locator('.lang-btn', { hasText: 'Deutsch' }).first().click();
await page.waitForSelector('#menu-screen', { timeout: 20_000 });
await page.locator('.menu-nav button', { hasText: 'Spielen' }).first().click();
await page.locator('button', { hasText: 'Noch kein Konto?' }).first().click();
await page.locator('input[type="email"]').fill('sail@example.org');
await page.locator('input[autocomplete="nickname"]').fill('Segelkapitaen');
await page.locator('input[type="password"]').fill('Sturmvogel-Anker-99');
await page.locator('button.primary', { hasText: 'Registrieren' }).click();
await page.waitForSelector('.card__title:text-is("Spiel laden")', { timeout: 20_000 });
await page.locator('button.primary', { hasText: 'Neues Spiel' }).click();
await page.waitForSelector('.modal', { timeout: 15_000 });
await page.locator('.modal input').first().fill('Landgaenger');
await page.locator('.modal__foot button.primary').click();
await page.waitForSelector('#map-canvas', { timeout: 90_000 });
await page.waitForFunction(() => document.getElementById('map-canvas')?.width > 100, { timeout: 30_000 });
await page.waitForTimeout(2500);

// Means, and a ship that can actually get somewhere.
await page.evaluate(() => window.__schiffi.socket.action('code.redeem', { code: 'many coins dav26' }));
await page.waitForTimeout(800);
await page.evaluate(() => window.__schiffi.socket.action('ship.buy', { classKey: 'fast_clipper' }));
await page.waitForTimeout(1200);

// Hire a crew: an expedition needs somebody to send ashore.
const hired = await page.evaluate(async () => {
  const c = window.__schiffi.character;
  const port = await (await fetch(`/api/worlds/${c.worldId}/ports/${c.portId}?characterId=${c.id}`,
    { credentials: 'same-origin' })).json();
  let n = 0;
  for (const offer of (port.crewOffers ?? []).slice(0, 5)) {
    try { await window.__schiffi.socket.action('crew.hire', { slot: offer.slot }); n++; } catch { /* full */ }
  }
  return n;
});
console.log('hired', hired, 'crew');

await page.evaluate(() => window.__schiffi.socket.action('port.leave', {}));
await page.waitForTimeout(1500);

// Sail to the nearest anchorage.
const target = await page.evaluate(() => {
  const w = window.__schiffi.world;
  const self = window.__schiffi.socket.self;
  let best = null, bestD = Infinity;
  for (const a of w.anchorages) {
    const d = Math.hypot(a.x - self.x, a.y - self.y);
    if (d < bestD) { bestD = d; best = a; }
  }
  return { ...best, d: Math.round(bestD) };
});
console.log('nearest anchorage', JSON.stringify(target));

// Steer with the arrow keys, the way a player does: the render loop polls the
// input module every frame, so anything set behind its back is overwritten.
const held = new Set();
const hold = async (keys) => {
  for (const key of [...held]) if (!keys.has(key)) { await page.keyboard.up(key); held.delete(key); }
  for (const key of keys) if (!held.has(key)) { await page.keyboard.down(key); held.add(key); }
};

let reached = { ok: false, closest: Infinity };
const deadline = Date.now() + 240_000;
while (Date.now() < deadline) {
  const self = await page.evaluate(() => {
    const s = window.__schiffi.socket.self;
    return s ? { x: s.x, y: s.y, v: s.v } : null;
  });
  if (!self) { await page.waitForTimeout(150); continue; }
  const dx = target.x - self.x;
  const dy = target.y - self.y;
  const d = Math.hypot(dx, dy);
  reached.closest = Math.min(reached.closest, Math.round(d));
  if (d < 45) { reached = { ok: true, d: Math.round(d) }; break; }

  const keys = new Set();
  if (dx > 40) keys.add('ArrowRight'); else if (dx < -40) keys.add('ArrowLeft');
  if (dy > 40) keys.add('ArrowDown'); else if (dy < -40) keys.add('ArrowUp');
  await hold(keys);
  await page.waitForTimeout(250);
}
await hold(new Set());
// Let the ship coast to a stop before asking to land.
await page.waitForFunction(() => (window.__schiffi.socket.self?.v ?? 99) < 1, { timeout: 15_000 })
  .catch(() => {});
await page.waitForTimeout(600);
console.log('sail result', JSON.stringify(reached));
await shot('10-near-island');

if (reached.ok) {
  // Probe the action directly first, so a refusal shows its reason.
  const probe = await page.evaluate(async () => {
    try { return { ok: true, report: await window.__schiffi.socket.action('explore.land', {}) }; }
    catch (e) { return { ok: false, code: e.code, message: e.message }; }
  });
  console.log('land probe:', JSON.stringify(probe).slice(0, 400));

  await page.locator('#act-explore').click();
  await page.waitForSelector('.modal', { timeout: 15_000 });
  await page.waitForTimeout(1200);
  await shot('11-expedition');

  // Do everything the island offers.
  const buttons = await page.locator('.modal__body .row button').count();
  console.log('activity buttons:', buttons);
  for (let i = 0; i < Math.min(buttons, 7); i++) {
    const b = page.locator('.modal__body .row button').nth(i);
    if (await b.isEnabled()) { await b.click(); await page.waitForTimeout(900); }
  }
  await page.waitForTimeout(800);
  await shot('12-expedition-yield');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  await page.locator('#act-more').click();
  await page.locator('#more-album').click();
  await page.waitForSelector('.album-grid', { timeout: 15_000 });
  await page.waitForTimeout(800);
  await shot('13-album-filled');
  await page.keyboard.press('Escape');
}

await browser.close();
await server.shutdown();
for (const s of ['', '-wal', '-shm']) rmSync(`${TEST_DB}${s}`, { force: true });
console.log('errors:', errors.length ? errors : 'none');
