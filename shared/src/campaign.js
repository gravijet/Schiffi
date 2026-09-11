/**
 * Rules for the shared territorial campaign.
 *
 * Kept outside `data/`: game data is intentionally generated/ignored in this
 * repository, while these are protocol-level rules that client and server
 * must version together.
 */
import { CELL_SIZE } from './world/constants.js';

/** A captain must be this close to contest a rival island. */
export const OUTPOST_CAPTURE_RANGE = CELL_SIZE * 5;
/** Capturing a defenceless outpost still takes a prepared landing party. */
export const OUTPOST_CAPTURE_BASE_AMMO = 2;
/** A claim cannot immediately be flipped back by the ship that just lost it. */
export const OUTPOST_CAPTURE_COOLDOWN_MS = 10 * 60_000;

/**
 * What an assault needs. Defence is deliberately valuable without making an
 * island impossible to retake: every two defence levels demand one more gun
 * and each level consumes two more rounds during the landing.
 */
export function outpostCaptureRequirements(defenceLevel = 0) {
  const defence = Math.max(0, Math.floor(Number(defenceLevel) || 0));
  return {
    defence,
    cannons: 1 + Math.ceil(defence / 2),
    ammunition: OUTPOST_CAPTURE_BASE_AMMO + defence * 2,
  };
}
