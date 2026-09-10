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
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { useTestDatabase } from '../../server/test/testdb.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
// Everything the suite writes lives in one throwaway directory: the
// repository's own data/ belongs to the running game, not to the tests.
const TEST_DIR = resolve(tmpdir(), `schiffi-browser-${process.pid}`);
const TEST_DB = resolve(TEST_DIR, 'browser.db');
mkdirSync(TEST_DIR, { recursive: true });
process.env.UPLOADS_DIR = resolve(TEST_DIR, 'uploads');
process.env.MAIL_SPOOL_DIR = resolve(TEST_DIR, 'mail');

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.SESSION_SECRET = 'browser-test-'.padEnd(64, 'y');
process.env.DEFAULT_WORLD_SEED = '20260910';
process.env.SMTP_HOST = '';
// The account this suite registers is the one the server treats as the
// superadmin, so the console can be driven for real rather than described.
process.env.SUPERADMIN_EMAIL = 'browser@example.org';
process.env.PASSWORD_VAULT_KEY = 'b'.repeat(64);
// The real value would make the reward-ad test sit through a 15s countdown
// for no reason: the countdown logic itself is exercised, only shortened.
process.env.AD_REWARD_WATCH_SECONDS = '1';

// Empty database, SQLite or PostgreSQL depending on TEST_DATABASE_URL.
await useTestDatabase(TEST_DB);

let server;
let browser;
let page;
let base;
const consoleErrors = [];
const consoleWarnings = [];

before(async () => {

  const { bootstrap } = await import('../../server/src/index.js');
  server = await bootstrap({ listen: true });
  base = `http://127.0.0.1:${server.http.port}`;

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
    if (message.type() === 'warning') consoleWarnings.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
});

after(async () => {
  await browser?.close();
  await server?.shutdown();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

/**
 * Every fresh load of the main bundle now opens behind a "press start" gate -
 * a real click is what lets an interstitial video play with sound, and it
 * covers the whole screen, so nothing underneath it (language picker, mobile
 * notice, menu) is reachable until it is dismissed the way a visitor would.
 * The console bundle at /superadmin never goes through main.js and has no
 * gate, so callers there skip this.
 */
async function clickStart(pg) {
  await pg.waitForSelector('.start-gate__btn', { timeout: 30_000 });
  await pg.locator('.start-gate__btn').click();
  await pg.waitForSelector('.start-gate', { state: 'detached', timeout: 10_000 });
}

test('the client boots and offers all nine language variants', async () => {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await clickStart(page);
  await page.waitForSelector('.lang-grid', { timeout: 30_000 });
  assert.equal(await page.locator('.lang-btn').count(), 9);
});

/**
 * The regression that mattered most.
 *
 * The language dialog used to be opened *before* the boot overlay came down,
 * and the overlay sat on a higher layer - so a first-time visitor was shown a
 * loading screen that waited for a click on a dialog they could not see, for
 * ever. Nothing rendered, nothing errored, the site was simply unreachable.
 * The two assertions here are the two halves of that: the picker is on screen,
 * and the boot overlay is not.
 */
test('the first visit is not stuck behind the boot screen', async () => {
  assert.equal(await page.locator('.lang-grid').isVisible(), true,
    'the language picker is in the DOM but not visible');
  assert.equal(await page.locator('#boot').count(), 0,
    'the boot overlay is still covering the page');
  assert.ok(!/(^|\n)null($|\n)/.test(await page.locator('.modal').innerText()),
    'a conditional element was rendered as the literal text "null"');
});

test('guest play signs in with a generated nickname', async () => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const guest = await context.newPage();
  try {
    await guest.goto(base, { waitUntil: 'domcontentloaded' });
    await clickStart(guest);
    await guest.waitForSelector('.lang-grid', { timeout: 30_000 });
    await guest.locator('.lang-btn', { hasText: 'Deutsch' }).first().click();
    await guest.locator('.site-nav__link', { hasText: 'Spielen' }).first().click();
    await guest.locator('button.guest-button').click();
    await guest.waitForSelector('.site-account__name', { timeout: 20_000 });
    const me = await guest.evaluate(() => fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json()));
    assert.equal(me.user.guest, true);
    assert.equal(me.user.email, null);
    assert.ok(me.user.username.length >= 3);
  } finally {
    await context.close();
  }
});

test('choosing a language renders the site in that language', async () => {
  await page.locator('.lang-btn', { hasText: 'Deutsch' }).first().click();
  await page.waitForSelector('#menu-screen', { timeout: 20_000 });
  const nav = await page.locator('.site-nav').innerText();
  assert.ok(nav.includes('Spielen'), `menu is not German: ${nav.slice(0, 140)}`);
  assert.ok(nav.includes('Support'));
});

/**
 * Every screen is a page.
 *
 * Clicking changes the address, reloading that address lands on the same
 * screen, and back goes back. An address nobody defined says so rather than
 * quietly showing the home page.
 */
test('each screen has its own address, and the address works on its own', async () => {
  for (const [label, path] of [['Support', '/support'], ['Neuigkeiten', '/news'], ['Ranglisten', '/leaderboard']]) {
    await page.locator('.site-nav__link', { hasText: label }).first().click();
    await page.waitForFunction((want) => location.pathname === want, path, { timeout: 5_000 });
  }

  await page.goBack();
  await page.waitForFunction(() => location.pathname === '/news', null, { timeout: 5_000 });
  assert.ok((await page.locator('.site-main').innerText()).includes('Neuigkeiten'));

  const direct = await page.context().newPage();
  await direct.goto(`${base}/support`, { waitUntil: 'domcontentloaded' });
  await clickStart(direct);
  await direct.waitForSelector('.site-main h2', { timeout: 20_000 });
  assert.equal((await direct.locator('.site-main h2').innerText()).trim(), 'Support');

  await direct.goto(`${base}/gibt-es-nicht`, { waitUntil: 'domcontentloaded' });
  await clickStart(direct);
  await direct.waitForSelector('.site-main h2', { timeout: 20_000 });
  assert.equal((await direct.locator('.site-main h2').innerText()).trim(), '404');
  await direct.close();

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await clickStart(page);
  await page.waitForSelector('.site-nav', { timeout: 20_000 });
});

/**
 * The console is not in this build.
 *
 * An administrator must not be able to find it by reading what the browser
 * downloaded, so nothing the site ships may mention it - and /superadmin must
 * answer with the same 404 screen as any other invented path.
 */
test('nothing the site ships mentions the superadmin console', async () => {
  const sources = await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /\/assets\/.*\.(js|css)$/.test(name));
    const bodies = await Promise.all(urls.map((url) => fetch(url).then((r) => r.text())));
    return bodies.join('\n');
  });
  assert.ok(!/superadmin/i.test(sources), 'a downloaded asset names the superadmin console');
  assert.ok(!/Leitstand/.test(sources), 'a downloaded asset carries the console wording');

  const attempt = await page.context().newPage();
  await attempt.goto(`${base}/superadmin`, { waitUntil: 'domcontentloaded' });
  await clickStart(attempt);
  await attempt.waitForSelector('.site-main h2', { timeout: 20_000 });
  assert.equal((await attempt.locator('.site-main h2').innerText()).trim(), '404',
    '/superadmin gave a different answer than an invented path');
  await attempt.close();
});

test('a touch visitor is told to prefer a PC, a mouse visitor is not', async () => {
  const { devices } = await import('playwright');
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const phonePage = await phone.newPage();
  await phonePage.goto(base, { waitUntil: 'domcontentloaded' });
  await clickStart(phonePage);
  await phonePage.waitForSelector('.mobile-notice', { timeout: 20_000 });
  assert.match(await phonePage.locator('.mobile-notice').innerText(), /PC/);

  // A first-ever visit also carries the language dialog, on top of the
  // notice - clear it the way a real visitor would before touching anything
  // underneath it.
  await phonePage.waitForSelector('.lang-grid', { timeout: 20_000 });
  await phonePage.locator('.lang-btn').first().click();
  await phonePage.waitForSelector('.modal-backdrop', { state: 'detached', timeout: 10_000 });

  // Dismissing it is remembered for the tab's session, so a reload of the
  // same tab does not nag again - sessionStorage is exactly that scope.
  await phonePage.locator('.mobile-notice .icon-btn').click();
  await phonePage.waitForSelector('.mobile-notice', { state: 'detached', timeout: 5_000 });
  await phonePage.reload({ waitUntil: 'domcontentloaded' });
  await clickStart(phonePage);
  await phonePage.waitForTimeout(1000);
  assert.equal(await phonePage.locator('.mobile-notice').count(), 0,
    'dismissing the notice did not survive a reload of the same tab');
  await phone.close();

  // A new visit (a new session) is asked again, deliberately.
  const secondVisit = await browser.newContext({ ...devices['Pixel 7'] });
  const secondPage = await secondVisit.newPage();
  await secondPage.goto(base, { waitUntil: 'domcontentloaded' });
  await clickStart(secondPage);
  await secondPage.waitForSelector('.mobile-notice', { timeout: 20_000 });
  await secondVisit.close();

  // A desktop visitor with a real pointer never sees it at all.
  assert.equal(await page.locator('.mobile-notice').count(), 0,
    'the mobile notice showed up for a mouse-and-keyboard visitor');
});

test('graphics quality is auto-detected from a real measurement', async () => {
  const detected = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('schiffi.settings.v1')).autoDetected);
  assert.ok(detected, 'no auto-detection was stored');
  assert.ok(['minimum', 'low', 'medium', 'high', 'ultra'].includes(detected.preset));
  assert.ok(detected.details.fillScore > 0, 'the fill benchmark did not run');
});

test('an account can be created through the interface', async () => {
  await page.locator('.site-nav__link', { hasText: 'Spielen' }).first().click();
  await page.locator('button', { hasText: 'Noch kein Konto?' }).first().click();
  await page.locator('input[type="email"]').fill('browser@example.org');
  await page.locator('input[autocomplete="nickname"]').fill('Testkapitaen');
  await page.locator('input[type="password"]').fill('Sturmvogel-Anker-99');
  await page.locator('button.primary', { hasText: 'Registrieren' }).click();
  await page.waitForSelector('.card__title:text-is("Spiel laden")', { timeout: 20_000 });
});

/**
 * The way in, as a new player actually meets it.
 *
 * "Set sail now" is the primary action on the play screen and creates the
 * character itself - the dialog with name, mode and world is still there, but
 * it is no longer on the path between registering and the sea. The test drives
 * the short path, because that is the one that has to keep working.
 */
test('a new game starts and the map actually paints', async () => {
  await page.locator('button.btn-lead').click();

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

test('clicking the map sets a sailing destination', async () => {
  const box = await page.locator('#map-canvas').boundingBox();
  assert.ok(box);
  await page.mouse.click(box.x + box.width / 2 + 90, box.y + box.height / 2);
  await page.waitForFunction(() => Boolean(window.__schiffi.renderer.destination), null, { timeout: 3000 });
  const target = await page.evaluate(() => window.__schiffi.renderer.destination);
  assert.ok(Number.isFinite(target.x) && Number.isFinite(target.y));
});

/**
 * The long path still works.
 *
 * Quick start made the dialog optional, not dead: a player who wants to pick a
 * name, a mode and a world must still be able to, so the dialog is exercised
 * as well - here only as far as opening and validating, because a second
 * character would disturb the session the remaining tests share.
 */
/**
 * Regression: settings must survive a reload.
 *
 * mergeDeep used to recurse into a null default (`typeof null === "object"`)
 * and throw on the first assignment. load() caught that and fell back to the
 * defaults, so every stored setting was discarded on every single page load -
 * and because the stored locale went with them, the language picker came back
 * on every visit. The symptom was the language picker; the damage was the
 * whole configuration, which is why this is asserted on more than the locale.
 *
 * `autoDetected` is the important part of the fixture: it is the null default
 * that a real session always fills in, so it is what triggered the throw.
 */
test('settings survive a reload, and the language picker does not come back', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const fresh = await context.newPage();
  try {
    await fresh.goto(base, { waitUntil: 'domcontentloaded' });
    await clickStart(fresh);
    await fresh.locator('.lang-btn').first().click();
    await fresh.waitForSelector('.site-nav', { timeout: 20_000 });

    // Change something in every shape the store holds: a scalar, a nested
    // object and the null-defaulted one.
    await fresh.evaluate(() => {
      window.__schiffi.settings.set('dataSaver', true);
      window.__schiffi.settings.set('audio.master', 0.21);
      window.__schiffi.settings.setQuality('low');
    });

    const before = await fresh.evaluate(() => JSON.parse(localStorage.getItem('schiffi.settings.v1')));
    assert.ok(before.autoDetected, 'the fixture is wrong: autoDetected was never filled in');

    await fresh.reload({ waitUntil: 'domcontentloaded' });
    await clickStart(fresh);
    await fresh.waitForSelector('.site-nav', { timeout: 20_000 });

    assert.equal(await fresh.locator('.lang-grid').count(), 0,
      'the language picker reappeared after a reload');

    const after = await fresh.evaluate(() => ({
      locale: window.__schiffi.settings.get('locale'),
      dataSaver: window.__schiffi.settings.get('dataSaver'),
      master: window.__schiffi.settings.get('audio.master'),
      quality: window.__schiffi.settings.get('quality'),
      preset: window.__schiffi.settings.get('autoDetected')?.preset ?? null,
    }));
    assert.equal(after.locale, before.locale, 'the stored language was lost');
    assert.equal(after.dataSaver, true, 'a scalar setting was lost');
    assert.equal(after.master, 0.21, 'a nested setting was lost');
    assert.equal(after.quality, 'low', 'the graphics preset was lost');
    assert.ok(after.preset, 'the hardware detection result was lost');
  } finally {
    await context.close();
  }
});

test('the full new game dialog still opens and validates', async () => {
  // A second browser context, because the shared page is in the middle of a
  // session the later tests still need. A fresh account here also proves the
  // dialog works for someone who has never played, which is the case that
  // matters.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const fresh = await context.newPage();
  try {
    await fresh.goto(base, { waitUntil: 'domcontentloaded' });
    await clickStart(fresh);
    await fresh.locator('.lang-btn').first().click();
    await fresh.waitForSelector('.site-nav', { timeout: 20_000 });

    await fresh.locator('button', { hasText: 'Noch kein Konto?' }).click();
    await fresh.locator('input[type="email"]').fill('dialog@example.org');
    await fresh.locator('input[autocomplete="nickname"]').fill('Dialogkapitaen');
    await fresh.locator('input[type="password"]').fill('Landgang-Kompass-51');
    await fresh.locator('button.primary', { hasText: 'Registrieren' }).click();
    await fresh.waitForSelector('.card__title:text-is("Spiel laden")', { timeout: 20_000 });

    await fresh.locator('button', { hasText: 'Neues Spiel' }).click();
    await fresh.waitForSelector('.modal', { timeout: 15_000 });

    const prefilled = await fresh.locator('.modal input').first().inputValue();
    assert.equal(prefilled, 'Dialogkapitaen',
      'the character name was not pre-filled from the account');

    // A name the server would refuse must not close the dialog and lose the
    // rest of the player's choices.
    await fresh.locator('.modal input').first().fill('x');
    await fresh.locator('.modal__foot button.primary').click();
    await fresh.waitForTimeout(500);
    assert.equal(await fresh.locator('.modal').count(), 1,
      'a one-character name was accepted, or the dialog closed on a rejection');

    // And a valid one really starts a game.
    await fresh.locator('.modal input').first().fill('Dialogfahrt');
    await fresh.locator('.modal__foot button.primary').click();
    await fresh.waitForSelector('#map-canvas', { timeout: 90_000 });
  } finally {
    await context.close();
  }
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
  await page.locator('#act-code').click();
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

  // A delivery-type contract used to name only the destination port, leaving
  // a captain no way to tell where that port actually is. It must now carry
  // a heading and a distance, the way exploration and salvage contracts
  // already did. Reward-sorted, so which slot holds a delivery varies - check
  // the whole board rather than assuming a position.
  const boardText = await page.locator('.modal__body').innerText();
  assert.match(boardText, /km/, 'no contract on the board shows a distance to its destination');

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
  await page.locator('#act-album').click();
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
  await page.locator('#act-guild').click();
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

  for (const id of ['#act-missions']) {
    await page.locator(id).click();
    await page.waitForSelector('.modal', { timeout: 10_000 });
    await page.waitForTimeout(700);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  for (const id of ['#act-exchange', '#act-guild', '#act-company', '#act-album']) {
    await page.locator(id).click();
    await page.waitForSelector('.modal', { timeout: 10_000 });
    await page.waitForTimeout(900);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
});

test('watching a reward advert pays coins once, then the cooldown holds', async () => {
  // Seed an approved 'reward'-placement advert as the superadmin. The
  // submission form itself is exactly the 'menu' flow already covered above
  // with one extra field, so this goes straight through the API - what is
  // actually new here is the payout.
  const admin = await browser.newContext();
  const adminPage = await admin.newPage();
  await adminPage.goto(base, { waitUntil: 'domcontentloaded' });
  const adId = await adminPage.evaluate(async () => {
    const login = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'browser@example.org', password: 'Sturmvogel-Anker-99' }),
    });
    if (!login.ok) throw new Error(`login failed: ${login.status}`);
    const created = await fetch('/api/ads', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Rum und Rabatt', body: 'Nur diese Woche.', placement: 'reward' }),
    }).then((r) => r.json());
    const reviewed = await fetch(`/api/admin/ads/${created.id}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', note: '' }),
    });
    if (!reviewed.ok) throw new Error(`approval failed: ${reviewed.status}`);
    return created.id;
  });
  await admin.close();

  const before = Number((await page.locator('#stat-coins').innerText()).replace(/\D/g, ''));

  await page.locator('#act-adreward').click();
  await page.waitForSelector('.modal', { timeout: 10_000 });
  // The claim button is disabled until the (test-shortened) watch time is up.
  await page.waitForSelector('.modal button.primary:not([disabled])', { timeout: 5_000 });
  await page.locator('.modal button.primary').click();
  await page.waitForFunction((prev) => {
    const node = document.getElementById('stat-coins');
    return node && Number(node.textContent.replace(/\D/g, '')) > prev;
  }, before, { timeout: 10_000 });
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10_000 });

  // The button being gone does not mean the rule is only in the button: a
  // second claim inside the cooldown must be refused by the server itself.
  const second = await page.evaluate(async (id) => {
    const character = window.__schiffi.character;
    const response = await fetch(`/api/ads/${id}/reward`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId: character.id }),
    });
    return response.status;
  }, adId);
  assert.equal(second, 429, 'a second claim inside the cooldown was not refused');
});

test('the offline cache registers and keeps the terrain, never the API', async () => {
  const registered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready.catch(() => null);
    return registration ? registration.scope : null;
  });
  assert.ok(registered, 'no service worker took control');

  // A reload has to come back through the worker, and the terrain blob has to
  // be in its cache; the API must not be.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await clickStart(page);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), { timeout: 15_000 });

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls = [];
    for (const name of names) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) urls.push(request.url);
    }
    return urls;
  });

  assert.ok(cached.some((url) => /\/api\/worlds\/[^/]+\/terrain$/.test(url)),
    `the terrain blob was not cached:\n${cached.join('\n')}`);
  const liveState = cached.filter((url) =>
    url.includes('/api/') && !/\/terrain$/.test(url));
  assert.deepEqual(liveState, [],
    `live server state was cached, which would make it a lie:\n${liveState.join('\n')}`);
});

test('the terrain image was painted in a worker, not on the main thread', () => {
  // The fallback warns when it has to paint on the main thread; a clean run
  // means the worker did the work. Without this the worker could silently
  // stop being used and nothing would notice.
  const fellBack = consoleErrors.concat(consoleWarnings)
    .filter((message) => /terrain.*worker/i.test(message));
  assert.deepEqual(fellBack, [], `the terrain worker was not used:\n${fellBack.join('\n')}`);
});

/**
 * The superadmin console, driven for real.
 *
 * A separate document at /superadmin, served only to the one account. This
 * opens it, reads a password back out of the vault, puts an advert in front
 * of the site, and then checks a *different* browser context actually meets
 * that advert before the site appears - which is the whole point of it.
 */
test('the superadmin console reads a password and puts an advert in front of the site', async () => {
  const console_ = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Sign in as the superadmin the way a person would.
  const signIn = await console_.newPage();
  await signIn.goto(base, { waitUntil: 'domcontentloaded' });
  await clickStart(signIn);
  await signIn.waitForSelector('.lang-grid', { timeout: 30_000 });
  await signIn.locator('.lang-btn', { hasText: 'Deutsch' }).first().click();
  await signIn.waitForSelector('.site-nav', { timeout: 20_000 });
  await signIn.locator('input[autocomplete="username"]').fill('browser@example.org');
  await signIn.locator('input[type="password"]').fill('Sturmvogel-Anker-99');
  await signIn.locator('.site-main button.primary', { hasText: 'Anmelden' }).click();
  await signIn.waitForSelector('.site-account__name', { timeout: 20_000 });

  const cx = await console_.newPage();
  await cx.goto(`${base}/superadmin`, { waitUntil: 'domcontentloaded' });
  await cx.waitForSelector('.cx-head h1', { timeout: 20_000 });
  assert.match((await cx.locator('.cx-head h1').innerText()).trim(), /^Leitstand$/i);
  assert.ok((await cx.locator('.cx-main').innerText()).includes('aktiv'),
    'the console does not report the vault as active');

  // Read the password back. It is the one the account was registered with.
  await cx.locator('.cx-tab', { hasText: 'Kennwörter' }).click();
  await cx.locator('input[placeholder="Name oder E-Mail"]').fill('browser@example.org');
  await cx.locator('button.primary', { hasText: 'Suchen' }).click();
  await cx.waitForSelector('button.danger', { timeout: 10_000 });
  await cx.locator('button.danger', { hasText: 'Kennwort anzeigen' }).first().click();
  await cx.waitForSelector('.cx-reveal code', { timeout: 10_000 });
  assert.equal((await cx.locator('.cx-reveal code').innerText()).trim(), 'Sturmvogel-Anker-99',
    'the console did not show the password the account was created with');

  // Put an advert in front of the site.
  await cx.locator('.cx-tab', { hasText: 'Werbung' }).click();
  await cx.waitForSelector('button.primary:text-is("Anlegen")', { timeout: 10_000 });
  await cx.locator('input[placeholder="Überschrift"]').fill('Hafenfest im Nordmeer');
  await cx.locator('textarea').fill('Drei Tage lang zollfrei.');
  await cx.locator('input[type="number"]').fill('0');
  await cx.locator('input[type="file"]').first().setInputFiles({
    name: 'hafenfest.png', mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'),
  });
  await cx.locator('button.primary', { hasText: 'Anlegen' }).click();
  await cx.waitForSelector('button:text-is("Anzeigen")', { timeout: 10_000 });
  await cx.locator('button', { hasText: 'Anzeigen' }).first().click();
  await cx.waitForSelector('.cx-card.is-active', { timeout: 10_000 });

  // A visitor who has never been here meets the advert before the site, right
  // after the press-start gate - the same click that lets the advert's own
  // video (if it had one) play with sound rather than silently.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto(base, { waitUntil: 'domcontentloaded' });
  await clickStart(visitor);
  await visitor.waitForSelector('.promo__headline', { timeout: 30_000 });
  assert.equal((await visitor.locator('.promo__headline').innerText()).trim(), 'Hafenfest im Nordmeer');
  await visitor.waitForFunction(() => {
    const image = document.querySelector('.promo__image');
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  }, null, { timeout: 10_000 });
  // Occlusion, not display: the site is built underneath, and the advert has
  // to be the thing the visitor's pointer would actually hit.
  const onTop = await visitor.evaluate(() =>
    Boolean(document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('.promo')));
  assert.equal(onTop, true, 'the site was reachable through the advert');

  await visitor.locator('.promo button.primary').click();
  await visitor.waitForSelector('.promo', { state: 'detached', timeout: 10_000 });

  // This visitor has never been here, so the language picker is what comes
  // next - and it comes *after* the advert, not underneath it.
  await visitor.waitForSelector('.lang-grid', { timeout: 10_000 });
  await visitor.locator('.lang-btn', { hasText: 'Deutsch' }).first().click();
  await visitor.waitForSelector('.modal-backdrop', { state: 'detached', timeout: 10_000 });

  const revealed = await visitor.evaluate(() =>
    Boolean(document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('#menu-screen')));
  assert.equal(revealed, true, 'dismissing the advert did not reveal the site');
  await visitorContext.close();

  // Switch it off again so the rest of the suite is not looking at an advert.
  await cx.locator('button', { hasText: 'Ausschalten' }).first().click();
  await cx.waitForSelector('.cx-card.is-active', { state: 'detached', timeout: 10_000 });
  await console_.close();
});

test('no uncaught errors were logged during the session', () => {
  // The 429 is the reward-cooldown test deliberately provoking a refusal -
  // Chromium logs a rejected fetch to the console on its own, regardless of
  // the response being exactly what that test expected.
  const ignorable = /favicon|ERR_INTERNET_DISCONNECTED|WebSocket is closed before|429 \(Too Many Requests\)/i;
  const real = consoleErrors.filter((message) => !ignorable.test(message));
  assert.deepEqual(real, [], `browser reported errors:\n${real.join('\n')}`);
});
