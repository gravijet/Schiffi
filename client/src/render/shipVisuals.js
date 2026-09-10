/**
 * How a ship's silhouette varies, for the flat pixel-art hull `drawShip()`
 * draws in renderer.js.
 *
 * Deliberately client-only and separate from `shared/src/data/ships.js`:
 * that file is the server-shared economy model (price, cargo, combat stats)
 * and has no business knowing what a hull looks like. It is also the reason
 * this can only be exact for the player's own ship - the network snapshot
 * for every *other* entity carries `kind`/`npcKind`/`faction` (see
 * `client/src/net/socket.js`), never the real ship class, so a remote
 * merchantman and a remote heavy cargo ship are indistinguishable over the
 * wire today. Rather than widen the snapshot protocol for a paint job,
 * other ships get a role-based silhouette from the fields already sent -
 * still visibly different shapes per NPC role/player, just not a literal
 * 1:1 read of their real class tier.
 */

/** By the real ship class key - used for the one ship whose class is known client-side: your own. */
const BY_CLASS = {
  small_boat: { lengthMul: 0.8, beamMul: 0.85, masts: 1 },
  fishing_vessel: { lengthMul: 0.85, beamMul: 0.95, masts: 1 },
  fast_courier: { lengthMul: 1.05, beamMul: 0.75, masts: 1 },
  merchant_ship: { lengthMul: 1, beamMul: 1, masts: 2 },
  explorer_ship: { lengthMul: 1.05, beamMul: 0.9, masts: 2 },
  fast_clipper: { lengthMul: 1.2, beamMul: 0.8, masts: 2 },
  armored_trader: { lengthMul: 1.05, beamMul: 1.1, masts: 2 },
  heavy_merchant: { lengthMul: 1.1, beamMul: 1.2, masts: 2 },
  luxury_passenger: { lengthMul: 1.15, beamMul: 1.15, masts: 2 },
  large_cargo: { lengthMul: 1.25, beamMul: 1.3, masts: 2 },
};

/** By role, for remote entities - see file comment for why class isn't available there. */
const BY_ROLE = {
  player: { lengthMul: 1, beamMul: 1, masts: 2 },
  pirate: { lengthMul: 1.15, beamMul: 0.85, masts: 1 },
  navy: { lengthMul: 1.05, beamMul: 1.15, masts: 2 },
  fisher: { lengthMul: 0.8, beamMul: 0.85, masts: 1 },
  merchant: { lengthMul: 1, beamMul: 1.05, masts: 2 },
};

const DEFAULT_VISUAL = BY_ROLE.merchant;

export function visualForClass(classKey) {
  return BY_CLASS[classKey] ?? DEFAULT_VISUAL;
}

/** `entity` is the decoded network snapshot shape from `client/src/net/socket.js`. */
export function visualForEntity(entity) {
  if (entity?.kind === 1) return BY_ROLE.player;
  return BY_ROLE[entity?.npcKind] ?? DEFAULT_VISUAL;
}
