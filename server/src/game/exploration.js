/**
 * Going ashore.
 *
 * The exploration loop is the Entdecker mode's reason to exist: sail to an
 * uncharted island, land at a beach, and bring something back. Everything here
 * is authoritative - which island you are at, what the terrain around the
 * landing actually is, what a search turns up and who charted it first.
 *
 * First discovery is claimed with a primary key on (world, island), so two
 * players arriving in the same second cannot both be first.
 */
import { getDatabase } from '../db/index.js';
import { HttpError } from '../http/respond.js';
import { Rng, hashCombine } from '@schiffi/shared/util/rng.js';
import { dist } from '@schiffi/shared/util/math.js';
import { CELL_SIZE, CELLS_X, CELLS_Y, T, IS_LAND } from '@schiffi/shared/world/constants.js';
import { goodByKey } from '@schiffi/shared/data/goods.js';
import { findingsFor, wildlifeFor, ACTIVITY_COST, ACTIVITIES, RARITY_CHANCE }
  from '@schiffi/shared/data/discoveries.js';
import { generateIslandName } from '@schiffi/shared/world/names.js';
import { addCargo, cargoUsage } from './characters.js';
import { audit } from '../services/audit.js';
import { awardXp } from './progression.js';

/** How close the ship must be to a landing beach. */
const LANDING_RANGE = CELL_SIZE * 4;
/** Cooldown per activity per island, so an island is not an infinite mine. */
const ACTIVITY_COOLDOWN_MS = 6 * 60_000;

const TERRAIN_NAME = Object.fromEntries(Object.entries(T).map(([name, value]) => [value, name]));

const fail = (code, message = code) => new HttpError(400, code, message);

/** The anchorage nearest to a position, if the ship is close enough to land. */
export function nearestAnchorage(instance, x, y) {
  let best = null;
  let bestDistance = Infinity;
  for (const anchorage of instance.world.anchorages) {
    const distance = dist(anchorage.x, anchorage.y, x, y);
    if (distance < bestDistance) { bestDistance = distance; best = anchorage; }
  }
  return best && bestDistance <= LANDING_RANGE ? { anchorage: best, distance: bestDistance } : null;
}

/**
 * Land at an uncharted island.
 *
 * Claims the first discovery if it is unclaimed, and returns what the shore
 * party can see: the terrain around the landing, whether there are ruins, and
 * which activities are therefore possible.
 */
export async function land({ instance, characterId, userId }) {
  const db = getDatabase();

  return db.tx(async (tx) => {
    const character = await tx.get(
      'SELECT * FROM characters WHERE id = ? AND deleted_at IS NULL', [characterId]);
    if (!character) throw new HttpError(404, 'error.notFound');
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');
    if (character.docked === 1) throw fail('error.validation', 'you are in a port, not at sea');

    const found = nearestAnchorage(instance, Number(character.x), Number(character.y));
    if (!found) throw fail('error.tooFar', 'no landing beach within reach');

    const island = instance.islandsById.get(found.anchorage.islandId);
    if (!island) throw fail('error.notFound');

    const survey = surveyIsland(instance, island);

    // Claim the first discovery. The primary key makes this race-proof: a
    // second claim simply finds the row already there.
    let firstDiscovery = false;
    let discovery = await tx.get(
      'SELECT * FROM island_discoveries WHERE world_id = ? AND island_id = ?',
      [instance.id, island.id]);

    if (!discovery && island.undiscovered) {
      await tx.insert('island_discoveries', {
        world_id: instance.id, island_id: island.id,
        user_id: character.user_id, character_id: characterId,
        player_name: character.name, discovered_at: Date.now(),
        name_status: 'none',
      });
      firstDiscovery = true;
      discovery = await tx.get(
        'SELECT * FROM island_discoveries WHERE world_id = ? AND island_id = ?',
        [instance.id, island.id]);

      await tx.run(
        'UPDATE player_stats SET islands_found = islands_found + 1, updated_at = ? WHERE character_id = ?',
        [Date.now(), characterId]);
      // A first landing lifts the whole crew.
      await tx.run(
        'UPDATE crew_members SET morale = MIN(100, morale + 20) WHERE ship_id = ?',
        [character.active_ship_id]);
      await audit({ userId: character.user_id }, 'explore.first_discovery', 'island',
        `${instance.id}:${island.id}`, { player: character.name }, { db: tx });
    }

    // Charting an island is worth experience whether or not you were first.
    const xp = firstDiscovery ? 400 : 25;
    await awardXp(tx, characterId, xp);

    return {
      islandId: island.id,
      name: discovery?.final_name ?? discovery?.proposed_name
        ?? (island.undiscovered ? null : island.name),
      uncharted: Boolean(island.undiscovered),
      firstDiscovery,
      firstDiscoveredBy: discovery ? {
        player: discovery.player_name,
        at: Number(discovery.discovered_at),
        yours: String(discovery.character_id) === String(characterId),
      } : null,
      canPropose: firstDiscovery && island.undiscovered,
      anchorage: { x: found.anchorage.x, y: found.anchorage.y },
      survey,
      activities: availableActivities(survey),
      xp,
    };
  });
}

/**
 * What is around a landing: terrain mix, whether ruins are present, and the
 * island's climate. Derived from the seed, so it is the same for everyone.
 */
export function surveyIsland(instance, island) {
  const terrain = instance.world.terrain;
  const counts = {};
  let samples = 0;

  for (let y = island.minY; y <= island.maxY; y++) {
    for (let x = island.minX; x <= island.maxX; x++) {
      const index = y * CELLS_X + x;
      if (instance.world.labels[index] !== island.id) continue;
      const name = TERRAIN_NAME[terrain[index]];
      counts[name] = (counts[name] ?? 0) + 1;
      samples++;
    }
  }

  const climateIndex = instance.world.climate[
    Math.min(instance.world.climate.length - 1,
      Math.floor(island.cy) * CELLS_X + Math.floor(island.cx))];
  const climate = ['tropical', 'subtropical', 'temperate', 'boreal', 'polar'][climateIndex] ?? 'temperate';

  // Ruins are a property of the island, decided once by the seed. Bigger and
  // older-feeling islands (hills, mountains) are likelier to hold them.
  const rng = new Rng(hashCombine(instance.seed, island.id, 0x2117));
  const ruinChance = Math.min(0.55, 0.08 + Math.sqrt(island.area) / 220
    + ((counts.MOUNTAIN ?? 0) + (counts.HILL ?? 0)) / Math.max(1, samples) * 0.3);
  const hasRuins = rng.chance(ruinChance);
  const hasTreasure = rng.chance(0.22);

  return {
    area: island.area,
    climate,
    terrain: counts,
    dominant: Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'PLAIN',
    hasRuins,
    hasTreasure,
    culture: island.culture,
  };
}

function availableActivities(survey) {
  const out = [];
  const has = (name) => (survey.terrain[name] ?? 0) > 0;

  if (has('FOREST')) out.push('fell_trees');
  if (has('FOREST') || has('PLAIN')) out.push('gather_fruit', 'collect_plants');
  if (has('HILL') || has('MOUNTAIN') || has('BEACH') || has('VOLCANO')) out.push('gather_resources');
  if (survey.hasRuins) out.push('search_ruins');
  if (survey.hasTreasure) out.push('dig_treasure');
  out.push('observe_wildlife');
  return out;
}

/**
 * Perform a shore activity.
 *
 * The outcome is rolled server-side from the island's actual terrain, capped
 * by the ship's free cargo space, and rate-limited per island so a beach is
 * not an infinite resource.
 */
export async function gather({ instance, characterId, userId, payload }) {
  const activity = String(payload.activity ?? '');
  if (!ACTIVITIES.includes(activity)) throw fail('error.validation', 'unknown activity');

  const db = getDatabase();
  return db.tx(async (tx) => {
    const character = await tx.get(
      'SELECT * FROM characters WHERE id = ? AND deleted_at IS NULL', [characterId]);
    if (!character) throw new HttpError(404, 'error.notFound');
    if (userId && String(character.user_id) !== String(userId)) throw new HttpError(403, 'error.forbidden');

    const found = nearestAnchorage(instance, Number(character.x), Number(character.y));
    if (!found) throw fail('error.tooFar', 'no landing beach within reach');
    const island = instance.islandsById.get(found.anchorage.islandId);
    const survey = surveyIsland(instance, island);
    if (!availableActivities(survey).includes(activity)) {
      throw fail('error.validation', 'that cannot be done on this island');
    }

    // Cooldown, tracked in the album table as a lightweight activity log.
    const recent = await tx.get(
      'SELECT found_at FROM discovery_album WHERE character_id = ? AND kind = ? AND entry_key = ? ' +
      'ORDER BY found_at DESC LIMIT 1',
      [characterId, 'activity', `${island.id}:${activity}`]);
    if (recent && Date.now() - Number(recent.found_at) < ACTIVITY_COOLDOWN_MS) {
      const waitMs = ACTIVITY_COOLDOWN_MS - (Date.now() - Number(recent.found_at));
      throw new HttpError(429, 'error.rateLimited',
        `this spot needs ${Math.ceil(waitMs / 60000)} more minutes`, { waitMs });
    }

    const ship = await tx.get('SELECT * FROM ships WHERE id = ?', [character.active_ship_id]);
    const crew = await tx.all('SELECT * FROM crew_members WHERE ship_id = ?', [ship.id]);
    if (crew.length === 0) throw fail('crew.understaffed', 'nobody to send ashore');

    const rng = new Rng(hashCombine(instance.seed, island.id, Date.now() & 0xffff, characterId | 0));

    if (activity === 'observe_wildlife') {
      return observeWildlife(tx, { instance, character, island, survey, rng });
    }

    // A bigger, better-rested shore party brings back more.
    const partySize = Math.min(8, crew.length);
    const condition = crew.reduce((sum, member) =>
      sum + (Number(member.morale) * 0.5 + Number(member.health) * 0.5) / 100, 0) / crew.length;
    const effort = 0.5 + partySize * 0.12 + condition * 0.5;

    const pool = findingsFor(activity, survey.dominant, survey.climate)
      .concat(findingsFor(activity, 'BEACH', survey.climate))
      .filter((finding, index, list) => list.findIndex((f) => f.good === finding.good) === index);
    if (pool.length === 0) throw fail('error.validation', 'nothing to find here');

    const draws = Math.max(1, Math.round(rng.range(1, 2.6) * effort));
    const { used } = await cargoUsage(ship.id, tx);
    const capacity = shipCapacity(ship, crew);
    let free = Math.max(0, capacity - used);

    const gained = [];
    for (let i = 0; i < draws; i++) {
      const finding = rng.pickWeighted(pool, pool.map((entry) => entry.weight));
      const good = goodByKey(finding.good);
      if (!good) continue;
      let qty = rng.int(finding.qty[0], finding.qty[1] + 1);
      const slots = good.vol * qty;
      if (slots > free) qty = Math.floor(free / good.vol);
      if (qty <= 0) continue;

      await addCargo(tx, ship.id, good.id, qty, Math.round(good.price * 0.35), 1);
      free -= good.vol * qty;
      gained.push({ goodId: good.id, key: good.key, qty });

      if (finding.album) {
        await recordAlbum(tx, characterId, finding.album, finding.good, { islandId: island.id });
      }
    }

    const cost = ACTIVITY_COST[activity];
    if (cost?.morale) {
      await tx.run('UPDATE crew_members SET morale = MAX(0, MIN(100, morale + ?)) WHERE ship_id = ?',
        [cost.morale, ship.id]);
    }
    await tx.insert('discovery_album', {
      character_id: characterId, kind: 'activity',
      entry_key: `${island.id}:${activity}`, found_at: Date.now(),
      data: JSON.stringify({ gained: gained.length }),
    });

    const xp = 10 + gained.reduce((sum, entry) => sum + entry.qty, 0) * 2;
    await awardXp(tx, characterId, xp);

    return {
      activity,
      islandId: island.id,
      gained,
      cargoFull: free <= 0,
      xp,
      cooldownMs: ACTIVITY_COOLDOWN_MS,
    };
  });
}

async function observeWildlife(tx, { instance, character, island, survey, rng }) {
  const where = rng.chance(0.5) ? 'land' : 'sea';
  const pool = wildlifeFor(where, survey.climate);
  if (pool.length === 0) return { activity: 'observe_wildlife', sightings: [] };

  const sightings = [];
  const attempts = rng.int(1, 4);
  for (let i = 0; i < attempts; i++) {
    const animal = rng.pick(pool);
    // Rarity gates whether the sighting happens at all.
    if (!rng.chance(RARITY_CHANCE[animal.rarity] ?? 0.2)) continue;
    const isNew = await recordAlbum(tx, character.id, 'animal', animal.key, { islandId: island.id });
    sightings.push({ key: animal.key, rarity: animal.rarity, isNew });
  }

  const xp = sightings.reduce((sum, sighting) => sum + (sighting.isNew ? 40 : 5), 0);
  if (xp) await awardXp(tx, character.id, xp);
  await tx.insert('discovery_album', {
    character_id: character.id, kind: 'activity',
    entry_key: `${island.id}:observe_wildlife`, found_at: Date.now(),
    data: JSON.stringify({ sightings: sightings.length }),
  });

  return { activity: 'observe_wildlife', islandId: island.id, sightings, xp };
}

/** Add an album entry; returns true when it is new to this character. */
async function recordAlbum(tx, characterId, kind, key, data = {}) {
  const existing = await tx.get(
    'SELECT id FROM discovery_album WHERE character_id = ? AND kind = ? AND entry_key = ?',
    [characterId, kind, key]);
  if (existing) return false;
  await tx.insert('discovery_album', {
    character_id: characterId, kind, entry_key: key,
    found_at: Date.now(), data: JSON.stringify(data),
  });
  return true;
}

function shipCapacity(ship, crew) {
  // Kept simple and local: exploration only needs the hold size.
  const upgrades = typeof ship.upgrades === 'string' ? JSON.parse(ship.upgrades || '{}') : (ship.upgrades ?? {});
  const extra = Number(upgrades.larger_hold ?? 0) * 8;
  const base = { small_boat: 8, fishing_vessel: 20, fast_courier: 14, merchant_ship: 48,
    explorer_ship: 34, fast_clipper: 40, armored_trader: 56, heavy_merchant: 96,
    luxury_passenger: 44, large_cargo: 160 }[ship.class_key] ?? 8;
  return base + extra;
}

/**
 * Propose a name for an island you charted first.
 *
 * The name is held for moderation rather than published immediately: this is
 * player-authored text that everyone else will see.
 */
export async function proposeName({ instance, characterId, userId, payload }) {
  const name = String(payload.name ?? '').trim();
  const problem = validateIslandName(name);
  if (problem) throw fail(problem);

  const db = getDatabase();
  return db.tx(async (tx) => {
    const discovery = await tx.get(
      'SELECT * FROM island_discoveries WHERE world_id = ? AND island_id = ?',
      [instance.id, payload.islandId]);
    if (!discovery) throw new HttpError(404, 'error.notFound', 'this island has not been charted');
    if (String(discovery.character_id) !== String(characterId)) {
      throw new HttpError(403, 'error.forbidden', 'only the first discoverer may name it');
    }
    if (discovery.name_status === 'approved') {
      throw new HttpError(409, 'error.conflict', 'this island already has a name');
    }

    // An obviously clean name is published at once; anything the filter is
    // unsure about waits for a moderator.
    const status = looksClean(name) ? 'approved' : 'pending';
    await tx.run(
      'UPDATE island_discoveries SET proposed_name = ?, name_status = ?, final_name = ? ' +
      'WHERE world_id = ? AND island_id = ?',
      [name, status, status === 'approved' ? name : null, instance.id, payload.islandId]);

    await audit({ userId }, 'explore.name_proposed', 'island', `${instance.id}:${payload.islandId}`,
      { name, status }, { db: tx });

    return { islandId: payload.islandId, name, status };
  });
}

const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} '\-]{2,31}$/u;

export function validateIslandName(name) {
  if (!NAME_PATTERN.test(name)) return 'error.validation';
  if (/(.)\1{3,}/.test(name)) return 'error.validation';
  return null;
}

/**
 * A deliberately small, conservative filter. It decides between "publish now"
 * and "a human should look at this" - it is not the moderation system, the
 * moderation queue is.
 */
const SUSPICIOUS = /\b(admin|moderator|server|http|www|\.com|\.de|discord|t\.me)\b/i;

function looksClean(name) {
  if (SUSPICIOUS.test(name)) return false;
  if (/[0-9]{4,}/.test(name)) return false;
  const letters = (name.match(/\p{L}/gu) ?? []).length;
  return letters >= name.length * 0.6;
}

/** Moderation queue and decisions. */
export async function pendingNames(worldId) {
  const db = getDatabase();
  return db.all(
    'SELECT * FROM island_discoveries WHERE world_id = ? AND name_status = ? ORDER BY discovered_at',
    [worldId, 'pending']);
}

export async function moderateName({ worldId, islandId, decision, replacement, actor }) {
  const db = getDatabase();
  const status = decision === 'approve' ? 'approved' : decision === 'rename' ? 'approved' : 'rejected';
  const finalName = decision === 'rename' ? String(replacement ?? '').trim() : null;
  if (decision === 'rename' && validateIslandName(finalName)) throw fail('error.validation');

  const row = await db.get(
    'SELECT * FROM island_discoveries WHERE world_id = ? AND island_id = ?', [worldId, islandId]);
  if (!row) throw new HttpError(404, 'error.notFound');

  await db.run(
    'UPDATE island_discoveries SET name_status = ?, final_name = ?, moderated_by = ?, moderated_at = ? ' +
    'WHERE world_id = ? AND island_id = ?',
    [status, decision === 'approve' ? row.proposed_name : finalName,
      actor?.userId ?? null, Date.now(), worldId, islandId]);

  await audit(actor, 'explore.name_moderated', 'island', `${worldId}:${islandId}`,
    { decision, finalName });
  return { islandId, status, finalName: decision === 'approve' ? row.proposed_name : finalName };
}

/** A character's album, grouped by kind. */
export async function album(characterId) {
  const db = getDatabase();
  const rows = await db.all(
    "SELECT kind, entry_key, found_at, data FROM discovery_album WHERE character_id = ? AND kind <> 'activity' " +
    'ORDER BY found_at DESC', [characterId]);
  const grouped = {};
  for (const row of rows) {
    (grouped[row.kind] ??= []).push({
      key: row.entry_key, at: Number(row.found_at), data: JSON.parse(row.data || '{}'),
    });
  }
  return grouped;
}
