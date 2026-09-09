/**
 * Terrain palette.
 *
 * Schiffi's own colour scheme: cold desaturated blues for water so that ships
 * and ports (warm brass) read instantly against it, and muted naturalistic
 * land so a coastline is legible at any zoom without becoming decorative.
 * Each terrain class has a base colour and a slightly shifted variant, blended
 * per cell by a hash, which stops large areas looking like flat paint.
 */
import { T } from '@schiffi/shared/world/constants.js';

const rgb = (r, g, b) => ({ r, g, b });

export const TERRAIN_COLOURS = {
  [T.DEEP_OCEAN]: [rgb(9, 26, 44), rgb(13, 34, 56)],
  [T.OCEAN]:      [rgb(18, 48, 74), rgb(24, 60, 90)],
  [T.SHALLOW]:    [rgb(38, 92, 118), rgb(48, 110, 136)],
  [T.REEF]:       [rgb(58, 122, 128), rgb(76, 142, 140)],
  [T.BEACH]:      [rgb(198, 180, 132), rgb(210, 194, 148)],
  [T.PLAIN]:      [rgb(112, 132, 82), rgb(126, 146, 92)],
  [T.FOREST]:     [rgb(62, 96, 62), rgb(74, 110, 70)],
  [T.HILL]:       [rgb(112, 110, 78), rgb(126, 122, 88)],
  [T.MOUNTAIN]:   [rgb(122, 118, 112), rgb(140, 136, 130)],
  [T.SNOW]:       [rgb(226, 230, 236), rgb(240, 244, 248)],
  [T.DESERT]:     [rgb(198, 172, 116), rgb(212, 188, 132)],
  [T.SWAMP]:      [rgb(76, 92, 68), rgb(88, 104, 76)],
  [T.VOLCANO]:    [rgb(84, 62, 58), rgb(104, 74, 66)],
  [T.ICE]:        [rgb(198, 216, 228), rgb(214, 230, 240)],
};

/** Light theme: the same hues, lifted and desaturated for a paper look. */
export const TERRAIN_COLOURS_LIGHT = {
  [T.DEEP_OCEAN]: [rgb(150, 176, 196), rgb(160, 186, 206)],
  [T.OCEAN]:      [rgb(168, 194, 212), rgb(180, 204, 220)],
  [T.SHALLOW]:    [rgb(196, 218, 228), rgb(206, 226, 234)],
  [T.REEF]:       [rgb(178, 210, 204), rgb(190, 218, 212)],
  [T.BEACH]:      [rgb(232, 218, 178), rgb(238, 226, 190)],
  [T.PLAIN]:      [rgb(190, 198, 156), rgb(200, 208, 166)],
  [T.FOREST]:     [rgb(154, 176, 146), rgb(164, 186, 154)],
  [T.HILL]:       [rgb(196, 190, 158), rgb(204, 198, 168)],
  [T.MOUNTAIN]:   [rgb(196, 192, 186), rgb(206, 202, 196)],
  [T.SNOW]:       [rgb(246, 248, 250), rgb(252, 253, 255)],
  [T.DESERT]:     [rgb(232, 214, 168), rgb(238, 222, 180)],
  [T.SWAMP]:      [rgb(168, 180, 156), rgb(178, 188, 166)],
  [T.VOLCANO]:    [rgb(178, 158, 152), rgb(188, 170, 162)],
  [T.ICE]:        [rgb(230, 240, 246), rgb(240, 246, 250)],
};

export const FACTION_COLOURS = {
  nordmark: '#4a7fb5',
  sonnenbund: '#c8863c',
  ostkrone: '#8f5aa8',
  inselraete: '#3fa38a',
  freihandel: '#b8b03c',
  schwarzflagge: '#3b3b44',
};

export const HAZARD_COLOURS = {
  calm: 'rgba(87, 184, 119, 0.16)',
  normal: 'rgba(79, 157, 209, 0.10)',
  stormy: 'rgba(217, 154, 43, 0.18)',
  pirate: 'rgba(211, 89, 63, 0.20)',
  deepRisk: 'rgba(160, 48, 48, 0.26)',
  ice: 'rgba(198, 216, 228, 0.20)',
};

export const UI = {
  self: '#f0d478',
  selfDark: '#8a6f18',
  player: '#57b877',
  npcMerchant: '#9fb8c9',
  npcPirate: '#d3593f',
  npcNavy: '#4f9dd1',
  npcFisher: '#8fa88f',
  port: '#c9a227',
  portRing: 'rgba(201, 162, 39, 0.5)',
  anchorage: '#7fd4c0',
  storm: 'rgba(120, 140, 168, 0.35)',
  stormRing: 'rgba(180, 200, 230, 0.55)',
  fog: 'rgba(6, 12, 18, 0.86)',
  text: '#ece3d2',
};
