/**
 * A small, hand-drawn icon set for the bottom action bar and the docs
 * sidebar. Every icon shares one 16x16 pixel grid, flat fills and hard
 * (non-antialiased) edges rather than smooth glyph-font curves, so the set
 * reads as part of the game's flat pixel-art language instead of a generic
 * icon-font import.
 */
import { h } from './dom.js';

const PATHS = {
  // A single ship's ship-in-port action: dock and anchor.
  port: '<path d="M8 1v7M8 8l-2 2M8 8l2 2" stroke="currentColor" stroke-width="1.6" fill="none"/>'
    + '<circle cx="8" cy="11.5" r="2.3" stroke="currentColor" stroke-width="1.6" fill="none"/>'
    + '<path d="M5.8 11.5a2.2 2.2 0 0 0 4.4 0" stroke="currentColor" stroke-width="1.3" fill="none"/>',
  market: '<path d="M2 5h12l-1 3H3z" fill="currentColor"/>'
    + '<path d="M2 5V3h12v2" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<rect x="4" y="8" width="2" height="5" fill="currentColor"/>'
    + '<rect x="10" y="8" width="2" height="5" fill="currentColor"/>'
    + '<rect x="3" y="13" width="10" height="1.4" fill="currentColor"/>',
  explore: '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<path d="M10.5 5.5 9 9l-3.5 1.5L7 7z" fill="currentColor"/>',
  missions: '<path d="M4 1.5h6.5L13 4v10.5H4z" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<path d="M10.2 1.5V4H13" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<path d="M6 7h5M6 9.3h5M6 11.6h3.2" stroke="currentColor" stroke-width="1.2"/>',
  fleet: '<path d="M2 9.5 4 7l3 1-1 3z" fill="currentColor"/>'
    + '<path d="M8 8.5 10.5 5l3.5 1.5-1.5 4z" fill="currentColor" opacity="0.55"/>'
    + '<path d="M2 12.5h12" stroke="currentColor" stroke-width="1.4"/>',
  ship: '<path d="M4 9V3h5l2 3" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<path d="M2.5 9h11l-1.5 4h-8z" fill="currentColor"/>'
    + '<path d="M8 3V1" stroke="currentColor" stroke-width="1.4"/>',
  exchange: '<path d="M3 5.5h8M11 5.5 8.5 3M11 5.5 8.5 8" stroke="currentColor" stroke-width="1.5" fill="none"/>'
    + '<path d="M13 10.5H5M5 10.5 7.5 8M5 10.5 7.5 13" stroke="currentColor" stroke-width="1.5" fill="none"/>',
  combat: '<path d="M2 2l5 5M14 2l-5 5M2 2l1-1M14 2l-1-1" stroke="currentColor" stroke-width="1.6" fill="none"/>'
    + '<path d="M2 14l5-5M14 14l-5-5M2 14l1 1M14 14l-1 1" stroke="currentColor" stroke-width="1.6" fill="none"/>'
    + '<circle cx="8" cy="8" r="1.3" fill="currentColor"/>',
  trade: '<rect x="1.5" y="3" width="5" height="4" stroke="currentColor" stroke-width="1.3" fill="none"/>'
    + '<rect x="9.5" y="9" width="5" height="4" stroke="currentColor" stroke-width="1.3" fill="none"/>'
    + '<path d="M6.5 5h4M8.5 3.3 10.5 5 8.5 6.7" stroke="currentColor" stroke-width="1.3" fill="none"/>'
    + '<path d="M9.5 11h-4M7.5 12.7 5.5 11 7.5 9.3" stroke="currentColor" stroke-width="1.3" fill="none"/>',
  chat: '<path d="M1.5 2.5h13v8h-8L3 13v-2.5H1.5z" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<path d="M4 5.5h8M4 8h5" stroke="currentColor" stroke-width="1.2"/>',
  friends: '<circle cx="5.5" cy="5" r="2.2" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<circle cx="10.5" cy="6.5" r="1.8" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<path d="M1.5 14c0-2.5 1.8-4 4-4s4 1.5 4 4" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<path d="M9 14c0-1.8 1.2-3 2.8-3S14.5 12.2 14.5 14" stroke="currentColor" stroke-width="1.2" fill="none"/>',
  guild: '<path d="M4 1.5h8v9l-4 3-4-3z" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<path d="M6 4.5h4M6 7h4" stroke="currentColor" stroke-width="1.2"/>',
  company: '<rect x="2" y="6" width="5" height="8" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<rect x="8" y="2" width="6" height="12" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<path d="M10 5h2M10 8h2M10 11h2M3.5 9h2" stroke="currentColor" stroke-width="1.1"/>',
  warehouse: '<path d="M1.5 6 8 2l6.5 4" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<rect x="3" y="6" width="10" height="8" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<path d="M3 9h10M6.3 6v8" stroke="currentColor" stroke-width="1"/>',
  album: '<rect x="1.5" y="2.5" width="5.5" height="5.5" stroke="currentColor" stroke-width="1.3" fill="none"/>'
    + '<rect x="9" y="2.5" width="5.5" height="5.5" stroke="currentColor" stroke-width="1.3" fill="none"/>'
    + '<rect x="1.5" y="8" width="5.5" height="5.5" stroke="currentColor" stroke-width="1.3" fill="none"/>'
    + '<rect x="9" y="8" width="5.5" height="5.5" stroke="currentColor" stroke-width="1.3" fill="currentColor" opacity="0.5"/>',
  adreward: '<rect x="2" y="6.5" width="12" height="7" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<path d="M2 6.5h12v3H2z" fill="currentColor" opacity="0.4"/>'
    + '<path d="M8 6.5v7" stroke="currentColor" stroke-width="1.2"/>'
    + '<path d="M8 6.5c-1.5-3-4.5-2.5-4.5-.7C3.5 6.9 5.5 6.5 8 6.5s4.5.4 4.5-.7C12.5 4 9.5 3.5 8 6.5" stroke="currentColor" stroke-width="1.1" fill="none"/>',
  tutorial: '<circle cx="8" cy="6.5" r="4" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<path d="M6.5 9.5h3v2h-3z" fill="currentColor"/>'
    + '<path d="M6.5 13h3" stroke="currentColor" stroke-width="1.2"/>'
    + '<path d="M8 4v3" stroke="currentColor" stroke-width="1.2"/>',
  code: '<path d="M2 8 5 3h4l3 5-3 5H5z" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<circle cx="8" cy="8" r="1.2" fill="currentColor"/>',
  settings: '<circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"'
    + ' stroke="currentColor" stroke-width="1.4"/>',
  docs: '<path d="M3 1.5h10v13H3z" stroke="currentColor" stroke-width="1.3" fill="none"/>'
    + '<path d="M5.2 4.5h5.6M5.2 7h5.6M5.2 9.5h3.6" stroke="currentColor" stroke-width="1.1"/>',
  close: '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6"/>',
  exit: '<path d="M6.5 2.5H3v11h3.5" stroke="currentColor" stroke-width="1.4" fill="none"/>'
    + '<path d="M6 8h7.5M10.8 5l2.7 3-2.7 3" stroke="currentColor" stroke-width="1.4" fill="none"/>',
};

/**
 * One flat, hard-edged 16x16 SVG icon. `name` must be a key in PATHS.
 *
 * `h()` builds elements with `document.createElement`, which cannot produce a
 * real (rendering) `<svg>` node - it would come out as an inert
 * HTMLUnknownElement. Setting `innerHTML` on a plain wrapper is the standard
 * way around that: the HTML parser's foreign-content handling makes the
 * nested `<svg>` a proper, correctly-namespaced SVG element.
 */
export function icon(name, { size = 16, className } = {}) {
  const markup = PATHS[name];
  if (!markup) throw new Error(`unknown icon: ${name}`);
  return h(`span.icon${className ? `.${className}` : ''}`, {
    html: `<svg viewBox="0 0 16 16" width="${size}" height="${size}" `
      + `shape-rendering="crispEdges" aria-hidden="true">${markup}</svg>`,
  });
}

export const ICON_NAMES = Object.keys(PATHS);
