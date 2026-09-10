/**
 * Renderer palette.
 *
 * The terrain colours themselves live in shared/, because the server draws the
 * same world for the menu backdrop and the two must not drift apart. What is
 * left here is client-only: faction, hazard and HUD colours.
 */
export { TERRAIN_COLOURS, TERRAIN_COLOURS_LIGHT } from '@schiffi/shared/world/palette.js';

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
  wreck: 'rgba(214, 184, 140, 0.75)',
  storm: 'rgba(120, 140, 168, 0.35)',
  stormRing: 'rgba(180, 200, 230, 0.55)',
  fog: 'rgba(6, 12, 18, 0.86)',
  text: '#ece3d2',
};
