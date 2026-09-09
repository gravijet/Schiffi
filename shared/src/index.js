/** Public surface of the shared package (used by both server and client). */
export * from './util/rng.js';
export * from './util/math.js';
export * as noise from './util/noise.js';

export * from './world/constants.js';
export { buildWorld, terrainAt, isNavigable } from './world/index.js';
export { HAZARD, HAZARD_NAMES, regionAt } from './world/regions.js';
export * from './world/names.js';

export * from './data/goods.js';
export * from './data/ships.js';
export * from './data/crew.js';
export * from './data/factions.js';

export { Translator, LOCALES, LOCALE_CODES, DEFAULT_LOCALE, negotiateLocale, isValidLocale, flatten } from './i18n/index.js';
export { catalogues, catalogueFor, SOURCE_MESSAGES } from './i18n/locales/index.js';
export { PROTOCOL_VERSION, MSG } from './net/protocol.js';
