/**
 * Unit tests for the shared package.
 *
 * These guard the invariants the rest of the game assumes: the world is
 * reproducible from its seed, the catalogue really contains a thousand
 * distinct goods with a name in every language, and no locale is missing a key
 * that another one has.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildWorld } from '@schiffi/shared/world/index.js';
import { generateTerrain } from '@schiffi/shared/world/terrain.js';
import { CELLS_X, CELLS_Y, IS_LAND, NAVIGABLE, T, UNDISCOVERED_ISLAND_PROBABILITY }
  from '@schiffi/shared/world/constants.js';
import { allGoods, goodByKey, GOODS_COUNT, GOODS_LANGS } from '@schiffi/shared/data/goods.js';
import { effectiveStats, upgradeCost, shipClass } from '@schiffi/shared/data/ships.js';
import { aggregateCrewBonus, generateCrewMember, wageFor, specialisationsFor }
  from '@schiffi/shared/data/crew.js';
import { repTier, isContraband, tariffFor } from '@schiffi/shared/data/factions.js';
import { Translator, LOCALES, flatten, negotiateLocale } from '@schiffi/shared/i18n/index.js';
import { catalogues } from '@schiffi/shared/i18n/locales/index.js';
import { Rng, seedFromString } from '@schiffi/shared/util/rng.js';
import { normalize, clamp, angleDelta } from '@schiffi/shared/util/math.js';

// --- world -----------------------------------------------------------------

/** Cheap content hash over a whole grid: comparing slices is misleading,
 *  because the map edges are open ocean in every world. */
function gridDigest(cells) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < cells.length; i++) {
    hash = (hash ^ cells[i]) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

test('the same seed produces the same world', () => {
  const a = generateTerrain(4242);
  const b = generateTerrain(4242);
  assert.equal(gridDigest(a.terrain), gridDigest(b.terrain), 'same seed diverged');
  assert.deepEqual(Array.from(a.terrain.slice(0, 20_000)), Array.from(b.terrain.slice(0, 20_000)));

  const c = generateTerrain(4243);
  assert.notEqual(gridDigest(a.terrain), gridDigest(c.terrain), 'different seeds produced the same world');
});

test('a world is mostly water and has a usable land fraction', () => {
  const { terrain } = generateTerrain(987654);
  let land = 0;
  let navigable = 0;
  for (const value of terrain) {
    if (IS_LAND[value]) land++;
    if (NAVIGABLE[value]) navigable++;
  }
  const landFraction = land / terrain.length;
  assert.ok(landFraction > 0.18 && landFraction < 0.26, `land fraction ${landFraction.toFixed(3)}`);
  assert.ok(navigable / terrain.length > 0.7, 'not enough navigable water');
});

test('land is neither one mega-continent nor pixel noise', () => {
  const world = buildWorld(987654);
  const areas = world.islands.map((island) => island.area).sort((a, b) => b - a);
  const total = areas.reduce((sum, area) => sum + area, 0);

  assert.ok(world.islands.length > 80, `only ${world.islands.length} landmasses`);
  assert.ok(areas[0] / total < 0.35, 'one landmass dominates the map');
  const specks = areas.filter((area) => area < 4).length;
  assert.ok(specks / areas.length < 0.25, `${specks} of ${areas.length} landmasses are specks`);
});

test('every world has a reachable starting harbour with neighbours', () => {
  for (const seed of [1, 987654, 42424242, 777, 5]) {
    const world = buildWorld(seed);
    assert.ok(world.start.portId, `seed ${seed} produced no start port`);
    const near = world.ports.filter((port) =>
      Math.hypot(port.x - world.start.x, port.y - world.start.y) < 90 * 24).length;
    assert.ok(near >= 4, `seed ${seed}: only ${near} ports near the start`);
  }
});

test('uncharted islands stay near the specified probability', () => {
  let candidates = 0;
  let uncharted = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const world = buildWorld(seed);
    for (const island of world.islands) {
      if (island.area > 900) continue;   // big landmasses are always charted
      candidates++;
      if (island.undiscovered) uncharted++;
    }
  }
  const rate = uncharted / candidates;
  // Clustering makes the realised rate noisy; the target is 3.83 %.
  assert.ok(rate > 0.01 && rate < 0.09,
    `uncharted rate ${(rate * 100).toFixed(2)} % (target ${(UNDISCOVERED_ISLAND_PROBABILITY * 100).toFixed(2)} %)`);
});

// --- goods -----------------------------------------------------------------

test('the catalogue holds exactly 1000 distinct goods', () => {
  const goods = allGoods();
  assert.equal(goods.length, GOODS_COUNT);
  assert.equal(new Set(goods.map((g) => g.key)).size, GOODS_COUNT);
  assert.equal(new Set(goods.map((g) => g.id)).size, GOODS_COUNT);
});

test('every good has a real name in all nine language variants', () => {
  const goods = allGoods();
  for (const lang of GOODS_LANGS) {
    const broken = goods.filter((good) => {
      const name = good.names[lang];
      if (!name || name.includes('{') || name.includes('undefined')) return true;
      // A single Han character is a complete word ("牛" is cattle), so the
      // minimum length depends on the script, not on a fixed number.
      const minimum = /[\u4e00-\u9fff]/.test(name) ? 1 : 2;
      return name.trim().length < minimum;
    });
    assert.equal(broken.length, 0, `${lang}: ${broken.slice(0, 3).map((g) => g.key).join(', ')}`);
    // Names must also be distinct, or the market list becomes ambiguous.
    const unique = new Set(goods.map((good) => good.names[lang])).size;
    assert.ok(unique >= GOODS_COUNT - 2, `${lang} has ${GOODS_COUNT - unique} duplicate names`);
  }
});

test('goods have sane economic attributes', () => {
  for (const good of allGoods()) {
    assert.ok(good.price >= 1, `${good.key} costs ${good.price}`);
    assert.ok(good.weight >= 1);
    assert.ok(good.vol >= 1);
    assert.ok(good.perish >= 0 && good.perish <= 3);
    assert.ok(good.rare >= 0 && good.rare <= 4);
    assert.ok(good.spread > 0 && good.spread < 0.3);
  }
});

test('Italian, French and Russian qualifiers agree with the noun', () => {
  const polished = goodByKey('diamonds.polished');
  assert.ok(polished, 'expected diamonds.polished in the catalogue');
  assert.equal(polished.names.it, 'Diamanti levigati');
  assert.equal(polished.names.fr, 'Diamants polis');
  assert.equal(polished.names.ru, 'Алмазы шлифованные');
});

// --- ships and crew ---------------------------------------------------------

test('upgrades and crew both change effective ship stats', () => {
  const base = effectiveStats('merchant_ship');
  const upgraded = effectiveStats('merchant_ship', { larger_hold: 4, better_sails: 4 });
  assert.ok(upgraded.cargo > base.cargo);
  assert.ok(upgraded.speed > base.speed);

  const crew = Array.from({ length: 6 }, (_, i) => generateCrewMember(1, 'p1', i, 3));
  for (const member of crew) { member.morale = 95; member.health = 95; }
  const happy = aggregateCrewBonus(crew);
  for (const member of crew) { member.morale = 10; member.health = 20; }
  const miserable = aggregateCrewBonus(crew);
  assert.ok((happy.speed ?? 1) > (miserable.speed ?? 1), 'morale does not affect performance');
});

test('upgrade cost rises and stops at the maximum level', () => {
  assert.ok(upgradeCost('better_sails', 0) < upgradeCost('better_sails', 3));
  assert.equal(upgradeCost('better_sails', shipClass ? 4 : 4), null);
});

test('crew specialisations are role-appropriate', () => {
  for (const member of Array.from({ length: 60 }, (_, i) => generateCrewMember(7, 'p9', i, 4))) {
    const allowed = specialisationsFor(member.role).map((spec) => spec.key);
    assert.ok(allowed.includes(member.spec), `${member.role} cannot be ${member.spec}`);
    assert.ok(wageFor(member) > 0);
  }
});

// --- factions ---------------------------------------------------------------

test('reputation tiers move prices in the right direction', () => {
  assert.ok(repTier(-100).priceMul > repTier(0).priceMul);
  assert.ok(repTier(95).priceMul < repTier(0).priceMul);
  assert.equal(repTier(-100).navyHostile, true);
  assert.equal(repTier(50).navyHostile, false);
});

test('contraband and tariffs depend on the faction', () => {
  const opium = goodByKey('opium');
  assert.equal(isContraband('ostkrone', opium), true);
  assert.equal(isContraband('freihandel', opium), false);
  assert.ok(tariffFor('freihandel', opium, 0) < tariffFor('ostkrone', opium, 0));
});

// --- i18n -------------------------------------------------------------------

test('every locale covers every key of the reference locale', () => {
  const all = catalogues();
  const reference = all.de;
  for (const [code, catalogue] of Object.entries(all)) {
    const missing = Object.keys(reference).filter((key) => {
      if (catalogue[key] !== undefined) return false;
      // Chinese has no singular category, so `.one` variants are not required.
      if (code === 'zh' && key.endsWith('.one')) return false;
      return true;
    });
    assert.deepEqual(missing, [], `${code} is missing ${missing.length} keys`);
  }
});

test('plural categories resolve for every locale', () => {
  const all = catalogues();
  for (const locale of LOCALES) {
    const translator = new Translator(all, locale.code);
    for (const count of [0, 1, 2, 5, 21, 100]) {
      const text = translator.t('cargo.spoiled', { count, good: 'Salz' });
      assert.ok(!text.startsWith('cargo.spoiled'), `${locale.code} has no plural for ${count}`);
      assert.ok(!text.includes('{count}'), `${locale.code} did not interpolate for ${count}`);
    }
  }
});

test('the stylised German variants differ from plain German', () => {
  const all = catalogues();
  const german = new Translator(all, 'de');
  const tyrolean = new Translator(all, 'de-tirol');
  const old = new Translator(all, 'de-alt');
  const pirate = new Translator(all, 'pirate');

  assert.notEqual(tyrolean.t('trade.buy'), german.t('trade.buy'));
  assert.notEqual(old.t('trade.buy'), german.t('trade.buy'));
  assert.notEqual(pirate.t('trade.buy'), german.t('trade.buy'));
  // …and they must still say something, not fall back to the key.
  for (const translator of [tyrolean, old, pirate]) {
    assert.ok(translator.t('menu.play').length > 2);
  }
});

test('locale negotiation prefers an exact match then the primary tag', () => {
  assert.equal(negotiateLocale('de-DE,de;q=0.9,en;q=0.8'), 'de');
  assert.equal(negotiateLocale('zh-Hans-CN'), 'zh');
  assert.equal(negotiateLocale('pirate'), 'pirate');
  assert.equal(negotiateLocale('xx-YY'), 'en');
});

// --- utilities --------------------------------------------------------------

test('the random generator is deterministic and well distributed', () => {
  const a = new Rng(seedFromString('schiffi'));
  const b = new Rng(seedFromString('schiffi'));
  for (let i = 0; i < 100; i++) assert.equal(a.float(), b.float());

  const rng = new Rng(1);
  let sum = 0;
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 100_000; i++) {
    const value = rng.float();
    sum += value;
    buckets[Math.floor(value * 10)]++;
  }
  assert.ok(Math.abs(sum / 100_000 - 0.5) < 0.01, 'mean is off');
  for (const bucket of buckets) {
    assert.ok(Math.abs(bucket - 10_000) < 700, `uneven distribution: ${buckets.join(',')}`);
  }
});

test('vector normalisation makes diagonals no faster than cardinals', () => {
  const [x, y] = normalize(1, 1);
  assert.ok(Math.abs(Math.hypot(x, y) - 1) < 1e-9);
  assert.deepEqual(normalize(0, 0), [0, 0]);
  assert.equal(clamp(5, 0, 1), 1);
  assert.ok(Math.abs(angleDelta(0.1, Math.PI * 2 - 0.1) + 0.2) < 1e-9);
});
