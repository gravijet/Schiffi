/**
 * Browser test.
 *
 * Drives the real client in a real browser against the real server: no DOM
 * shims, no stubbed network. It covers the things that can only break in a
 * browser - the canvas actually painting, terrain decoding, the language
 * switch re-rendering a running session, and a code redemption round trip that
 * moves the number in the top bar.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const TEST_DB = resolve(ROOT, `data/test-browser-${process.pid}.db`);

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.SQLITE_PATH = TEST_DB;
process.env.DATABASE_URL = '';
process.env.SESSION_SECRET = 'browser-test-'.padEnd(64, 'y');
process.env.DEFAULT_WORLD_SEED = '20260910';
process.env.SMTP_HOST = '';

let server;
let browser;
let page;
let base;
const consoleErrors = [];

before(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${TEST_DB}${suffix}`, { force: true });
  mkdirSync(resolve(ROOT, 'data'), { recursive: true });

  const { bootstrap } = await import('../../server/src/index.js');
  server = await bootstrap({ listen: true });
  base = `http://127.0.0.1:${server.http.port}`;

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
});

after(async () => {
  await browser?.close();
  await server?.shutdown();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${TEST_DB}${suffix}`, { force: true });
});

test('the client boots and offers all nine language variants', async () => {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lang-grid', { timeout: 30_000 });
  assert.equal(await page.locator('.lang-btn').count(), 9);
});

test('choosing a language renders the menu in that language', async () => {
  await page.locator('.lang-btn', { hasText: 'Deutsch' }).first().click();
  await page.waitForSelector('#menu-screen', { timeout: 20_000 });
  const nav = await page.locator('.menu-nav').innerText();
  assert.ok(nav.includes('Spielen'), `menu is not German: ${nav.slice(0, 140)}`);
  assert.ok(nav.includes('Einstellungen'));
});

test('graphics quality is auto-detected from a real measurement', async () => {
  const detected = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('schiffi.settings.v1')).autoDetected);
  assert.ok(detected, 'no auto-detection was stored');
  assert.ok(['minimum', 'low', 'medium', 'high', 'ultra'].includes(detected.preset));
  assert.ok(detected.details.fillScore > 0, 'the fill benchmark did not run');
});

test('an account can be created through the interface', async () => {
  await page.locator('.menu-nav button', { hasText: 'Spielen' }).first().click();
  await page.locator('button', { hasText: 'Noch kein Konto?' }).first().click();
  await page.locator('input[type="email"]').fill('browser@example.org');
  await page.locator('input[autocomplete="nickname"]').fill('Testkapitaen');
  await page.locator('input[type="password"]').fill('Sturmvogel-Anker-99');
  await page.locator('button.primary', { hasText: 'Registrieren' }).click();
  await page.waitForSelector('.card__title:text-is("Spiel laden")', { timeout: 20_000 });
});

test('a new game starts and the map actually paints', async () => {
  await page.locator('button.primary', { hasText: 'Neues Spiel' }).click();
  await page.waitForSelector('.modal', { timeout: 15_000 });
  await page.locator('.modal input').first().fill('Seebaer');
  await page.locator('.modal__foot button.primary').click();

  await page.waitForSelector('#map-canvas', { timeout: 90_000 });
  await page.waitForFunction(() => {
    const canvas = document.getElementById('map-canvas');
    return canvas && canvas.width > 100;
  }, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const distinctColours = await page.evaluate(() => {
    const canvas = document.getElementById('map-canvas');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 997) {
      seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      if (seen.size > 12) break;
    }
    return seen.size;
  });
  assert.ok(distinctColours > 3, `the canvas looks blank (${distinctColours} distinct colours)`);
});

test('the terrain decoded to the grid the server generated', async () => {
  const info = await page.evaluate(() => {
    const renderer = window.__schiffi.renderer;
    return {
      hasBitmap: Boolean(renderer.terrainBitmap),
      ports: window.__schiffi.world.ports.length,
      seed: window.__schiffi.world.seed,
    };
  });
  assert.ok(info.hasBitmap, 'the terrain bitmap was never built');
  assert.ok(info.ports > 50, `only ${info.ports} ports reached the client`);
});

test('the HUD shows the starting five coins', async () => {
  await page.waitForFunction(() => {
    const node = document.getElementById('stat-coins');
    return node && node.textContent && node.textContent !== '—';
  }, { timeout: 20_000 });
  const coins = await page.locator('#stat-coins').innerText();
  assert.equal(coins.replace(/\D/g, ''), '5', `expected 5 coins, got "${coins}"`);
});

test('the WebSocket connects and snapshots arrive', async () => {
  const rate = await page.waitForFunction(
    () => (window.__schiffi.socket.snapshotsPerSecond > 0
      ? window.__schiffi.socket.snapshotsPerSecond : false),
    { timeout: 25_000 }).then((handle) => handle.jsonValue());
  assert.ok(rate > 0, 'no snapshots were received');
});

test('a secret code is redeemed through the real action channel', async () => {
  await page.locator('#act-more').click();
  await page.locator('#more-code').click();
  await page.waitForSelector('.modal input');
  await page.locator('.modal input').fill('BUMG 1718 LURT 1838 TOOO 1444 dav26');
  await page.locator('.modal__foot button.primary').click();

  await page.waitForFunction(() => {
    const node = document.getElementById('stat-coins');
    return node && Number(node.textContent.replace(/\D/g, '')) >= 1005;
  }, { timeout: 20_000 });
  const coins = Number((await page.locator('#stat-coins').innerText()).replace(/\D/g, ''));
  assert.equal(coins, 1005, 'the code did not credit exactly 1000 coins');
});

test('the performance overlay reports a real frame rate', async () => {
  await page.keyboard.press('F3');
  await page.waitForSelector('#perf:not([hidden])', { timeout: 10_000 });
  await page.waitForTimeout(1500);
  const overlay = await page.locator('#perf').innerText();
  const fps = Number(/(\d+)/.exec(overlay)?.[1] ?? 0);
  assert.ok(fps > 5, `frame rate looks wrong: ${overlay.replace(/\n/g, ' | ')}`);
  assert.ok(overlay.includes('ms'), 'frame time is missing from the overlay');
});

test('switching language re-renders a running session', async () => {
  // Chinese is the unambiguous check: a script change cannot be a coincidence.
  // (German and Piratensprache share several of these particular words, so
  // comparing those two would test nothing.)
  await page.evaluate(() => window.__schiffi.setLocale('zh'));
  await page.waitForTimeout(900);
  const chinese = await page.locator('#actionbar').innerText();
  assert.ok(/[\u4e00-\u9fff]/.test(chinese), `expected Chinese text, got "${chinese}"`);

  await page.evaluate(() => window.__schiffi.setLocale('de'));
  await page.waitForTimeout(900);
  const german = await page.locator('#actionbar').innerText();
  assert.ok(!/[\u4e00-\u9fff]/.test(german), 'switching back to German left Chinese text behind');
});

test('reducing the resolution scale really shrinks the backbuffer', async () => {
  const before = await page.evaluate(() => document.getElementById('map-canvas').width);
  await page.evaluate(() => window.__schiffi.settings.setGraphics('resolutionScale', 0.5));
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => document.getElementById('map-canvas').width);
  assert.ok(after < before, `backbuffer did not shrink: ${before} -> ${after}`);
});

test('the contract board shows what the port has really posted', async () => {
  // The character starts docked, so the board is reachable straight away.
  await page.locator('#act-missions').click();
  await page.waitForSelector('.modal', { timeout: 10_000 });
  await page.waitForFunction(
    () => !document.querySelector('.modal__body')?.textContent.includes('…'),
    { timeout: 15_000 });

  const [shown, posted] = await Promise.all([
    page.locator('.modal__body .card').count(),
    page.evaluate(async () => {
      const character = window.__schiffi.character;
      const response = await fetch(
        `/api/worlds/${character.worldId}/ports/${character.portId}/missions`,
        { credentials: 'same-origin' });
      return (await response.json()).missions.length;
    }),
  ]);
  assert.ok(posted > 0, 'the port posted no contracts at all');
  assert.equal(shown, posted, `board shows ${shown} contracts, the port has ${posted}`);
  await page.locator('.modal__foot button').last().click();
});

test('accepting a contract really moves it into the active list', async () => {
  await page.locator('#act-missions').click();
  await page.waitForSelector('.modal .card button', { timeout: 10_000 });
  // Contracts the starting boat cannot carry are offered greyed out with a
  // reason, so take the first one it can actually accept.
  const accept = page.locator('.modal .card button:not([disabled])').first();
  await accept.click();
  await page.waitForTimeout(1500);

  const active = await page.evaluate(async () => {
    const response = await fetch(`/api/characters/${window.__schiffi.character.id}/missions`,
      { credentials: 'same-origin' });
    return (await response.json()).missions.length;
  });
  assert.equal(active, 1, `expected one active contract on the server, found ${active}`);
  await page.locator('.modal__foot button').last().click();
});

test('the exchange screen loads the world market from the server', async () => {
  await page.locator('#act-exchange').click();
  await page.waitForSelector('.modal', { timeout: 10_000 });
  await page.waitForFunction(
    () => !document.querySelector('.modal__body')?.textContent.includes('…'),
    { timeout: 15_000 });
  const body = await page.locator('.modal__body').innerText();
  // A fresh world has no lots yet; the empty state is the honest answer.
  assert.ok(body.length > 0, 'the exchange rendered nothing at all');
  await page.locator('.modal__foot button').last().click();
});

test('the album lists the full collectable set with the found ones marked', async () => {
  await page.locator('#act-more').click();
  await page.locator('#more-album').click();
  await page.waitForSelector('.album-grid', { timeout: 15_000 });

  const cells = await page.locator('.album-cell').count();
  const expected = await page.evaluate(async () => {
    const response = await fetch('/api/data/discoveries', { credentials: 'same-origin' });
    const data = await response.json();
    return data.wildlife.length + data.collectables.length;
  });
  assert.equal(cells, expected, `album shows ${cells} slots, the server defines ${expected}`);
  // Nothing has been found yet, so nothing may claim to have been.
  assert.equal(await page.locator('.album-cell.is-found').count(), 0);
  await page.locator('.modal__foot button').last().click();
});

test('the company screen founds nothing it cannot pay for', async () => {
  await page.locator('#act-more').click();
  await page.locator('#more-guild').click();
  await page.waitForSelector('.modal', { timeout: 10_000 });
  await page.waitForFunction(
    () => !document.querySelector('.modal__body')?.textContent.includes('…'),
    { timeout: 15_000 });

  const coinsBefore = await page.evaluate(() => window.__schiffi.character.coins);
  await page.locator('.modal__body button.primary').first().click();
  await page.waitForSelector('.modal .field input', { timeout: 5000 });
  const inputs = page.locator('.modal .field input');
  await inputs.nth(0).fill('Testkompanie Nordsee');
  await inputs.nth(1).fill('TKN');
  await page.locator('.modal__foot button.primary').click();
  await page.waitForTimeout(1200);

  const coinsAfter = await page.evaluate(async () => {
    const response = await fetch(`/api/characters/${window.__schiffi.character.id}`,
      { credentials: 'same-origin' });
    return (await response.json()).coins;
  });
  assert.equal(coinsAfter, coinsBefore,
    'a company was founded without the coins to pay the founding fee');
  const guild = await page.evaluate(async () => {
    const response = await fetch(`/api/characters/${window.__schiffi.character.id}/guild`,
      { credentials: 'same-origin' });
    return (await response.json()).guild;
  });
  assert.equal(guild, null, 'the server created a company that was never paid for');
});

test('every action-bar button opens a screen without an error', async () => {
  // Close whatever the previous test left open.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  for (const id of ['#act-missions', '#act-exchange']) {
    await page.locator(id).click();
    await page.waitForSelector('.modal', { timeout: 10_000 });
    await page.waitForTimeout(700);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  for (const id of ['#more-guild', '#more-company', '#more-album']) {
    await page.locator('#act-more').click();
    await page.locator(id).click();
    await page.waitForSelector('.modal', { timeout: 10_000 });
    await page.waitForTimeout(900);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
});

test('no uncaught errors were logged during the session', () => {
  const ignorable = /favicon|ERR_INTERNET_DISCONNECTED|WebSocket is closed before/i;
  const real = consoleErrors.filter((message) => !ignorable.test(message));
  assert.deepEqual(real, [], `browser reported errors:\n${real.join('\n')}`);
});
