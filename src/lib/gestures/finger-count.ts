import type { Landmark, Handedness, HandFrame } from "./types";

/**
 * Pure finger-counting logic (Phase 6).
 *
 * This module is a testable mirror of the browser/MediaPipe glue in
 * `hand-tracker.ts` — it is NOT an enforcement point; the tracker calls it on
 * raw (non-mirrored) landmark frames. Ported from the reference implementation
 * (`Sample Code/index.html`) with the thumb added:
 *
 *  - index/middle/ring/pinky: `tip.y < pip.y` (indices 8<6, 12<10, 16<14, 20<18)
 *  - thumb: x-comparison `l4.x < l3.x` for "Right", `l4.x > l3.x` for "Left"
 *    (raw frame, non-mirrored); NOT counted when handedness is absent
 *    (conservative — the thumb is the only finger that needs handedness).
 */

const INDEX_TIP = 8;
const INDEX_PIP = 6;
const INDEX_MCP = 5;

const MIDDLE_TIP = 12;
const MIDDLE_PIP = 10;
const MIDDLE_MCP = 9;

const RING_TIP = 16;
const RING_PIP = 14;
const RING_MCP = 13;

const PINKY_TIP = 20;
const PINKY_PIP = 18;
const PINKY_MCP = 17;

const THUMB_TIP = 4;
const THUMB_MCP = 3;

function distSq(a: Landmark, b: Landmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Is the finger at `tip` extended past its `pip` and `mcp` joints? */
export function isFingerExtended(
  landmarks: Landmark[],
  tip: number,
  pip: number,
  mcp?: number,
): boolean {
  const t = landmarks[tip];
  const p = landmarks[pip];
  if (!t || !p) return false;

  // Basic 2D height condition: tip must be higher on the screen (lower y) than PIP
  if (t.y >= p.y) return false;

  // Geometric uncurl check against MCP knuckle and wrist:
  // When a finger is curled into the palm (e.g. pinky when showing 3 fingers),
  // the tip curls back toward the knuckle/wrist, making dist(tip, mcp) <= dist(pip, mcp).
  // When straight/extended (e.g. showing 4 fingers), dist(tip, mcp) > dist(pip, mcp).
  if (mcp !== undefined) {
    const m = landmarks[mcp];
    if (m && (m.x !== p.x || m.y !== p.y)) {
      const distTipMcp = distSq(t, m);
      const distPipMcp = distSq(p, m);
      if (distTipMcp <= distPipMcp * 1.1) {
        return false;
      }
    }
  }

  const wrist = landmarks[0];
  if (wrist && (wrist.x !== p.x || wrist.y !== p.y)) {
    const distTipWrist = distSq(t, wrist);
    const distPipWrist = distSq(p, wrist);
    if (distTipWrist <= distPipWrist * 1.05) {
      return false;
    }
  }

  return true;
}

/** Is the thumb extended (geometric check against palm/pinky + handedness fallback)? */
export function isThumbExtended(
  landmarks: Landmark[],
  handedness?: Handedness,
): boolean {
  const tip = landmarks[THUMB_TIP];
  const ip = landmarks[THUMB_MCP];
  const pinkyMcp = landmarks[17];
  if (!tip || !ip) return false;

  // 1. Geometric distance check against pinky base (landmark 17):
  //    When thumb is folded across palm, tip (4) is closer to pinky MCP (17) than IP joint (3).
  //    When thumb is extended outwards/open, tip (4) is further from pinky MCP (17) than IP joint (3).
  if (pinkyMcp && (pinkyMcp.x !== ip.x || pinkyMcp.y !== ip.y)) {
    const distTipToPinky = distSq(tip, pinkyMcp);
    const distIpToPinky = distSq(ip, pinkyMcp);
    return distTipToPinky > distIpToPinky * 1.08;
  }

  // 2. Handedness fallback (also supports synthetic landmark fixtures)
  if (handedness === "Right") return tip.x < ip.x;
  if (handedness === "Left") return tip.x > ip.x;
  return false;
}

/** Count extended fingers (0–5), including the handedness-aware thumb. */
export function countExtendedFingers(
  landmarks: Landmark[],
  handedness?: Handedness,
): number {
  let count = 0;
  if (isFingerExtended(landmarks, INDEX_TIP, INDEX_PIP, INDEX_MCP)) count++;
  if (isFingerExtended(landmarks, MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP)) count++;
  if (isFingerExtended(landmarks, RING_TIP, RING_PIP, RING_MCP)) count++;
  if (isFingerExtended(landmarks, PINKY_TIP, PINKY_PIP, PINKY_MCP)) count++;
  if (isThumbExtended(landmarks, handedness)) count++;
  return count;
}

/**
 * Map a 1-based finger count to a 0-based option index. The single owner of
 * the clamp: returns `null` when `fingerCount` is outside `1..optionCount`
 * (covers 0 fingers, >5 fingers, and finger-count > option-count such as 4
 * fingers on a true/false question). Non-integer counts are rejected (the
 * tracker only ever produces integers, but the clamp is the single authority).
 */
export function mapFingersToOption(
  fingerCount: number,
  optionCount: number,
): number | null {
  if (optionCount <= 0) return null;
  if (!Number.isInteger(fingerCount) || fingerCount < 1 || fingerCount > optionCount) {
    return null;
  }
  return fingerCount - 1;
}

/**
 * Convert a MediaPipe detection result into a `HandFrame`. Pure and testable —
 * the browser glue (`hand-tracker.ts`) calls this; it has no DOM dependency.
 *
 * - No landmarks (or < 21 points) → `{ handPresent: false, fingerCount: 0 }`.
 * - Otherwise counts extended fingers with the handedness reported by
 *   MediaPipe (normalized to `"Left" | "Right" | undefined`).
 */
export function landmarksToHandFrame(results: {
  landmarks?: Landmark[][];
  handedness?: { categoryName?: string }[][];
}): HandFrame {
  const landmarks = results.landmarks?.[0];
  if (!landmarks || landmarks.length < 21) {
    return { handPresent: false, fingerCount: 0 };
  }
  const handednessName = results.handedness?.[0]?.[0]?.categoryName;
  const handedness =
    handednessName === "Left" || handednessName === "Right" ? handednessName : undefined;
  return {
    handPresent: true,
    fingerCount: countExtendedFingers(landmarks, handedness),
    handedness,
  };
}
