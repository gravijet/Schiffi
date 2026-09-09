/**
 * Stylised German variants: Altdeutsch, Tirolerisch, Piratensprache.
 *
 * These three are *styles of German*, not separate languages, so they are
 * produced from the German string by rule based transformation plus explicit
 * overrides.  UI strings that carry real flavour are hand written in the
 * locale files and never touch this module; these rules exist so that the
 * ~1000 procedurally combined trade good names are never left untranslated.
 *
 * The rules are deliberately conservative - orthography and a small closed
 * lexicon - because an aggressive phonetic rewrite turns nouns into noise.
 */

/** Apply an ordered list of [RegExp, replacement] rules. */
function applyRules(text, rules) {
  let out = text;
  for (const [re, rep] of rules) out = out.replace(re, rep);
  return out;
}

// ---------------------------------------------------------------------------
// Altdeutsch: an antiquated *spelling* of modern German. Readable on sight.
// ---------------------------------------------------------------------------

const ALT_LEXICON = new Map(Object.entries({
  'Gold': 'Goldt', 'Silber': 'Silber', 'Eisen': 'Eysen', 'Salz': 'Saltz',
  'Wein': 'Wein', 'Bier': 'Bier', 'Brot': 'Brodt', 'Fleisch': 'Fleysch',
  'Schiff': 'Schiff', 'Hafen': 'Haafen', 'Meer': 'Meer', 'See': 'See',
  'Kaufmann': 'Kauffmann', 'Handel': 'Handell', 'Ware': 'Waare',
  'Waren': 'Waaren', 'Preis': 'Preyß', 'Geld': 'Geldt', 'Münze': 'Müntze',
  'Münzen': 'Müntzen', 'Zeit': 'Zeyt', 'Weizen': 'Weytzen', 'Reis': 'Reyß',
  'Fisch': 'Fisch', 'Käse': 'Kääse', 'Holz': 'Holtz', 'Kupfer': 'Kupffer',
  'Zinn': 'Zinn', 'Blei': 'Bley', 'Seide': 'Seyde', 'Leinen': 'Leynen',
  'Papier': 'Papyr', 'Pfeffer': 'Pfeffer', 'Zucker': 'Zucker',
  'Kaufen': 'Kauffen', 'Verkaufen': 'Verkauffen',
}));

// JavaScript's \b is defined over [A-Za-z0-9_], so it fires *inside* words
// right before an umlaut ("Kapit|än").  Every end-of-word rule below therefore
// uses an explicit "no German letter follows" lookahead instead.
const END = '(?![a-zäöüßA-ZÄÖÜ])';

const ALT_RULES = [
  [/(?<=[a-zäöü])z(?=[aeiouäöü])/g, 'tz'],
  [/ei/g, 'ey'],
  [/Ei/g, 'Ey'],
  [/(?<=[aeiouäöü])f(?=[aeiouäöü])/g, 'ff'],
  [new RegExp('uf' + END, 'g'), 'uff'],
  [new RegExp('([aeiouäöü])h?t' + END, 'g'), '$1dt'],
  [/(?<=[a-zäöü])k(?=[aeiouäöü])/g, 'ck'],
  [/\bK(?=[aeiouäöü])/g, 'C'],
  [/cck/g, 'ck'],
  [/tztz/g, 'tz'],
];

export function toAltdeutsch(text) {
  return transformWords(text, (word) => {
    const hit = ALT_LEXICON.get(word);
    if (hit) return hit;
    return applyRules(word, ALT_RULES);
  });
}

// ---------------------------------------------------------------------------
// Tirolerisch: Tyrolean dialect, kept clearly readable.
// ---------------------------------------------------------------------------

const TIROL_LEXICON = new Map(Object.entries({
  'nicht': 'net', 'nichts': 'nix', 'ist': 'isch', 'ein': 'a', 'eine': 'a',
  'einen': 'an', 'kein': 'koa', 'keine': 'koa', 'klein': 'kloa',
  'Stein': 'Stoa', 'Bein': 'Boa', 'heim': 'hoam', 'Heim': 'Hoam',
  'zwei': 'zwoa', 'Fleisch': 'Floasch', 'heiß': 'hoaß', 'weiß': 'woaß',
  'Haus': 'Haus', 'auch': 'a', 'jetzt': 'jetz', 'etwas': 'epps',
  'sehr': 'gonz', 'sind': 'sein', 'haben': 'hobn', 'hat': 'hot',
  'machen': 'mochn', 'gemacht': 'gmocht', 'gut': 'guat', 'Gut': 'Guat',
  'Geld': 'Göld', 'Wasser': 'Wossa', 'Kartoffeln': 'Erdäpfl',
  'Brot': 'Brot', 'Butter': 'Buttr', 'Milch': 'Müch', 'Käse': 'Kaas',
  'Schiff': 'Schiff', 'Hafen': 'Hofn', 'Meer': 'Meer', 'kaufen': 'kafn',
  'verkaufen': 'vakafn', 'Waren': 'Woarn', 'Ware': 'Woar',
  'Salz': 'Solz', 'Speck': 'Speck', 'Wein': 'Wein', 'Apfel': 'Apfl',
  'Äpfel': 'Äpfl', 'Wetter': 'Wetta', 'Wasserfass': 'Wossafassl',
}));

const TIROL_RULES = [
  [/^st/g, 'scht'],
  [/^St/g, 'Scht'],
  [new RegExp('(?<=[aeiouäöü])st' + END, 'g'), 'scht'],
  [new RegExp('chen' + END, 'g'), 'le'],
  [new RegExp('lein' + END, 'g'), 'le'],
  [new RegExp('er' + END, 'g'), 'a'],   // Wetter -> Wetta
  [new RegExp('en' + END, 'g'), 'n'],   // Weizen -> Weizn
  [/^ge(?=[a-zäöü])/g, 'g'],
];

export function toTirolerisch(text) {
  return transformWords(text, (word) => {
    const hit = TIROL_LEXICON.get(word) ?? TIROL_LEXICON.get(word.toLowerCase());
    if (hit) return matchCase(word, hit);
    return applyRules(word, TIROL_RULES);
  });
}

// ---------------------------------------------------------------------------
// Piratensprache: humorous but always understandable.  Mostly a lexicon swap;
// the real flavour lives in the hand written UI strings.
// ---------------------------------------------------------------------------

const PIRATE_LEXICON = new Map(Object.entries({
  // Only substitutions that preserve grammatical gender *and* number are safe
  // here: "Schiff" (neuter) -> "Kahn" (masculine) would produce "das Kahn",
  // and "Waren" (plural) -> "Beute" (singular) would produce "3 Beute".
  // The real pirate flavour lives in the hand written locale strings.
  'kaufen': 'erstehen', 'verkaufen': 'verscherbeln', 'erwerben': 'erbeuten',
  'Kapitän': 'Käpt\'n', 'Arzt': 'Feldscher', 'Koch': 'Smutje',
  'Matrose': 'Maat', 'Matrosen': 'Maaten', 'Besatzung': 'Mannschaft',
  'Freund': 'Kumpan', 'Freunde': 'Kumpane', 'Spieler': 'Seebär',
  'Münze': 'Dublone', 'Münzen': 'Dublonen', 'Nachricht': 'Flaschenpost',
  'Nachrichten': 'Flaschenposten', 'Karte': 'Seekarte', 'Karten': 'Seekarten',
  'Krankheit': 'Seuche', 'Krankheiten': 'Seuchen', 'Frachtraum': 'Laderaum',
  'Gewinn': 'Beutegewinn', 'Wasser': 'Süßwasser', 'Vorrat': 'Proviant',
  'Vorräte': 'Proviant', 'Sturm': 'Blaster', 'Gegner': 'Widersacher',
}));

export function toPiratisch(text) {
  return transformWords(text, (word) => {
    const hit = PIRATE_LEXICON.get(word) ?? PIRATE_LEXICON.get(word.toLowerCase());
    return hit ? matchCase(word, hit) : word;
  });
}

// ---------------------------------------------------------------------------

/** Run a per-word transform while preserving punctuation and placeholders. */
function transformWords(text, fn) {
  // {placeholders} and <tags> must survive untouched.
  return text.replace(/\{[^}]*\}|<[^>]*>|[A-Za-zÄÖÜäöüß]+/g, (token) => {
    if (token.startsWith('{') || token.startsWith('<')) return token;
    return fn(token);
  });
}

/** Keep the original capitalisation when substituting from the lexicon. */
function matchCase(original, replacement) {
  if (original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

export const STYLIZERS = {
  'de-alt': toAltdeutsch,
  'de-tirol': toTirolerisch,
  'pirate': toPiratisch,
};
