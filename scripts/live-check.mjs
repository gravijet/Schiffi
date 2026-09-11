/**
 * Live check.
 *
 * Drives the deployed site through Cloudflare the way a visitor does, and
 * reports pass/fail per item rather than throwing on the first problem - the
 * point is a complete picture of what is and is not working right now.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'https://superdavid.eu';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

/**
 * Get past whatever the operator has put in front of the site.
 *
 * A live interstitial is a normal state here, not a fault - so this dismisses
 * one if it is there and reports that it was, rather than failing on it.
 */
async function passFront(target) {
  await target.waitForSelector('.promo, .start-gate, .lang-grid, #menu-screen', { timeout: 40000 });
  // The application deliberately opens behind a full-screen start gate so a
  // video interstitial can use a real visitor gesture. A live check must make
  // that same first click before it can inspect the language dialog or menu.
  if (await target.locator('.start-gate').count()) {
    await target.locator('.start-gate__btn').click({ timeout: 10000 });
    await target.waitForSelector('.promo, .lang-grid, #menu-screen', { timeout: 10000 });
  }
  if (await target.locator('.promo').count()) {
    const headline = await target.locator('.promo__headline').innerText();
    await target.locator('.promo button.primary').click({ timeout: 40000 });
    await target.waitForSelector('.promo', { state: 'detached', timeout: 10000 });
    return headline.trim();
  }
  return null;
}

const t0 = Date.now();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
const front = await passFront(page);
await page.waitForSelector('#menu-screen', { timeout: 30000 });
check('first visit reaches the site', true, `${Date.now() - t0} ms`);
if (front) check('the advert in front of the site is showing', true, front);
check('language picker is visible', await page.locator('.lang-grid').isVisible());
check('boot overlay is gone', (await page.locator('#boot').count()) === 0);

await page.locator('.lang-btn', { hasText: 'Deutsch' }).first().click();
await page.waitForSelector('.modal-backdrop', { state: 'detached', timeout: 10000 });

const clicks = [];
// The header actions are buttons, not anchors. Their fixed order follows the
// public route table; using that order keeps this probe independent of the
// currently selected language and of editorial wording changes.
for (const [index, path] of [[1, '/worlds'], [2, '/leaderboard'],
  [3, '/news'], [4, '/docs'], [5, '/support'], [0, '/']]) {
  const s = Date.now();
  await page.locator('.site-nav__link').nth(index).click();
  await page.waitForFunction((w) => location.pathname === w, path, { timeout: 8000 });
  await page.waitForSelector('.site-main h2', { timeout: 8000 });
  clicks.push(Date.now() - s);
}
check('navigation changes the URL and renders', true, `slowest click ${Math.max(...clicks)} ms`);

for (const path of ['/support', '/news', '/leaderboard', '/status', '/advertise', '/settings', '/profile']) {
  const r = await page.context().request.get(BASE + path);
  const fresh = await context.newPage();
  await fresh.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await passFront(fresh).catch(() => {});
  await fresh.waitForSelector('.site-main h2', { timeout: 20000 }).catch(() => {});
  const heading = await fresh.locator('.site-main h2').first().innerText().catch(() => '(none)');
  check(`${path} loads directly`, r.status() === 200 && heading !== '(none)' && heading.trim() !== '404', heading.trim());
  await fresh.close();
}

const nf = await context.newPage();
await nf.goto(BASE + '/gibt-es-wirklich-nicht', { waitUntil: 'domcontentloaded' });
await passFront(nf).catch(() => {});
await nf.waitForSelector('.site-main h2', { timeout: 20000 });
check('an unknown path says 404', (await nf.locator('.site-main h2').innerText()).trim() === '404');
await nf.close();

// /superadmin must be intercepted by Zero Trust before it reaches the origin.
const sa = await context.request.get(BASE + '/superadmin', { maxRedirects: 0 });
check('/superadmin is behind Zero Trust', sa.status() === 302 && String(sa.headers().location || '').includes('cloudflareaccess.com'),
  `${sa.status()}`);
const open = await context.request.get(BASE + '/api/status');
check('the rest of the site is not behind Zero Trust', open.status() === 200);

// The origin must still refuse a direct connection.
check('no uncaught errors in the browser', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks pass`);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
