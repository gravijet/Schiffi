/**
 * Original name generation for islands, ports, regions and NPC crews.
 *
 * Every syllable table here is written for Schiffi.  Names are assembled from
 * culture-specific onsets/nuclei/codas plus a small set of suffixes, so a
 * Nordmark port sounds different from a Sonnenmeer port without any of them
 * being taken from a real place list.
 */
import { Rng, hashCombine } from '../util/rng.js';

/** Culture keys map to factions; each has its own phonetic feel. */
export const CULTURES = ['nord', 'sued', 'ost', 'insel', 'frei'];

const SYLLABLES = {
  nord: {
    onset: ['br', 'dr', 'fj', 'gr', 'hv', 'kl', 'sk', 'sn', 'st', 'sv', 'th', 'tr', 'v', 'h', 'b', 'k', 'd'],
    nucleus: ['a', 'o', 'u', 'ei', 'y', 'aa', 'au', 'ie'],
    coda: ['rd', 'lm', 'ng', 'rk', 'st', 'ff', 'nn', 'vik', 'holm', 'fjord', 'bar'],
    suffix: ['heim', 'vik', 'holm', 'strand', 'nes', 'øy', 'fjell', 'hamn'],
  },
  sued: {
    onset: ['b', 'c', 'l', 'm', 'p', 'r', 's', 't', 'v', 'br', 'tr', 'pl', 'fl'],
    nucleus: ['a', 'e', 'i', 'o', 'ia', 'ea', 'au', 'oa'],
    coda: ['ll', 'nt', 'rr', 'nz', 'mb', 'sc', 'nd'],
    suffix: ['ora', 'ina', 'ella', 'anto', 'mare', 'porto', 'costa', 'isola'],
  },
  ost: {
    onset: ['zh', 'kr', 'v', 'm', 'n', 's', 'ch', 'g', 'd', 'sl', 'br', 'tv'],
    nucleus: ['a', 'o', 'e', 'i', 'ya', 'yo', 'ou', 'u'],
    coda: ['sk', 'vn', 'rd', 'zh', 'ny', 'tsk', 'gor'],
    suffix: ['grad', 'sk', 'ovo', 'insk', 'mor', 'bereg', 'ostrov'],
  },
  insel: {
    onset: ['k', 'l', 'm', 'n', 'p', 't', 'h', 'w', 'r', 'mb', 'nd'],
    nucleus: ['a', 'i', 'u', 'ai', 'oa', 'ua', 'e'],
    coda: ['na', 'ka', 'li', 'mu', 'wa', 'ri', 'hi'],
    suffix: ['tui', 'lani', 'moa', 'kai', 'rangi', 'atoll', 'motu'],
  },
  frei: {
    onset: ['b', 'g', 'j', 'kn', 'schw', 'st', 'w', 'z', 'f', 'h', 'r'],
    nucleus: ['a', 'e', 'o', 'ei', 'au', 'u', 'ie'],
    coda: ['ck', 'rt', 'ls', 'mm', 'nk', 'rf'],
    suffix: ['bucht', 'riff', 'anker', 'sund', 'kai', 'reede', 'werft', 'hafen'],
  },
};

/** Descriptive prefixes used sparingly to give some names a story. */
const EPITHETS = {
  nord: ['Alt', 'Neu', 'Hoch', 'Grimm', 'Frost'],
  sued: ['Bella', 'Alta', 'Porto', 'Santa', 'Monte'],
  ost: ['Novo', 'Staro', 'Bely', 'Cherno', 'Verkh'],
  insel: ['Te', 'Ma', 'Nui', 'Iti', 'Roa'],
  frei: ['Frei', 'Neu', 'Klein', 'Gross', 'Ober'],
};

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/** Build one place name for a culture from a deterministic seed. */
export function generatePlaceName(seed, culture = 'frei', kind = 'port') {
  const rng = new Rng(hashCombine(seed, culture.length * 7919, kind.length * 104729));
  const s = SYLLABLES[culture] || SYLLABLES.frei;

  // Two syllables read best; one is punchy, three is the rare long name.
  const syllables = rng.pickWeighted([1, 2, 3], [0.28, 0.56, 0.16]);
  let stem = '';
  for (let i = 0; i < syllables; i++) {
    stem += rng.pick(s.onset) + rng.pick(s.nucleus);
    if (i < syllables - 1 && rng.chance(0.35)) stem += rng.pick(s.coda);
  }
  // Only short stems can carry a suffix, otherwise names become unpronounceable.
  if (stem.length <= 7 && rng.chance(0.6)) stem += rng.pick(s.suffix);
  else stem += rng.pick(s.coda);

  stem = cap(stem.replace(/(.)\1\1+/g, '$1$1'));
  if (stem.length <= 8 && rng.chance(0.16)) {
    stem = rng.pick(EPITHETS[culture] || EPITHETS.frei) + '-' + stem;
  }
  return stem;
}

/** Region names get a slightly grander shape than ports. */
const REGION_HEADS = [
  'Meer', 'See', 'Bucht', 'Sund', 'Straße', 'Riff', 'Becken', 'Golf', 'Passage', 'Untiefe',
];
const REGION_ADJ = [
  'Stilles', 'Wildes', 'Graues', 'Goldenes', 'Schwarzes', 'Weites', 'Kaltes', 'Warmes',
  'Tiefes', 'Gebrochenes', 'Nebliges', 'Rotes', 'Blaues', 'Ewiges', 'Verlorenes',
];

export function generateRegionName(seed, culture = 'frei') {
  const rng = new Rng(hashCombine(seed, 0x5eed));
  if (rng.chance(0.5)) {
    const head = rng.pick(REGION_HEADS);
    const adj = rng.pick(REGION_ADJ);
    // German adjective agreement: "Bucht"/"See"/"Straße" are feminine.
    const fem = ['Bucht', 'See', 'Straße', 'Passage', 'Untiefe'].includes(head);
    return `${fem ? adj.replace(/es$/, 'e') : adj} ${head}`;
  }
  return `${generatePlaceName(hashCombine(seed, 77), culture, 'region')}${rng.chance(0.5) ? '-' : ''}${rng.pick(REGION_HEADS).toLowerCase()}`;
}

/** Island names for procedurally charted (already known) islands. */
export function generateIslandName(seed, culture = 'insel') {
  const rng = new Rng(hashCombine(seed, 0x151a));
  const base = generatePlaceName(hashCombine(seed, 991), culture, 'island');
  if (rng.chance(0.25)) return `${base}-Eiland`;
  if (rng.chance(0.2)) return `${base}inseln`;
  return base;
}

const FIRST_NAMES = [
  'Alma', 'Bendt', 'Cora', 'Dorn', 'Edda', 'Fenn', 'Gilda', 'Harm', 'Ilva', 'Jorn',
  'Kaja', 'Loer', 'Maren', 'Nils', 'Odda', 'Pjotr', 'Quilla', 'Rurik', 'Silja', 'Torv',
  'Ulla', 'Vidar', 'Wenna', 'Yrsa', 'Zeno', 'Benno', 'Carla', 'Dima', 'Elsa', 'Falk',
  'Greta', 'Hauke', 'Inka', 'Janne', 'Kolja', 'Lene', 'Mattis', 'Nele', 'Osmo', 'Pia',
  'Rune', 'Sanna', 'Tomm', 'Ute', 'Veit', 'Wilma', 'Yann', 'Zora', 'Anka', 'Brix',
];
const LAST_NAMES = [
  'Halvorsen', 'Kettner', 'Marlow', 'Osterbrink', 'Perro', 'Quandt', 'Rask', 'Sturmhold',
  'Tjaden', 'Ulvsen', 'Varga', 'Wedde', 'Zangl', 'Brandt', 'Cordes', 'Duvel', 'Ehlert',
  'Fahrenkrog', 'Gorm', 'Hjelm', 'Ivers', 'Jarl', 'Kaltenbach', 'Lindqvist', 'Mordt',
  'Nagel', 'Obermeer', 'Prahl', 'Rothsee', 'Salzmann', 'Tiefenbach', 'Urbach', 'Vossberg',
];

export function generatePersonName(seed) {
  const rng = new Rng(hashCombine(seed, 0xbeef));
  return `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
}

const SHIP_ADJ = ['Kühne', 'Stille', 'Rote', 'Weiße', 'Schnelle', 'Alte', 'Freie', 'Wilde', 'Graue', 'Letzte'];
const SHIP_NOUN = ['Möwe', 'Nadel', 'Krone', 'Schwalbe', 'Klinge', 'Laterne', 'Welle', 'Brise', 'Fracht', 'Boje', 'Sturmhaube', 'Seekuh'];

export function generateShipName(seed) {
  const rng = new Rng(hashCombine(seed, 0xf00d));
  return `${rng.pick(SHIP_ADJ)} ${rng.pick(SHIP_NOUN)}`;
}
