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
const MIDDLE_TIP = 12;
const MIDDLE_PIP = 10;
const RING_TIP = 16;
const RING_PIP = 14;
const PINKY_TIP = 20;
const PINKY_PIP = 18;
const THUMB_TIP = 4;
const THUMB_MCP = 3;

/** Is the finger at `tip` extended past its `pip` joint (y-axis)? */
export function isFingerExtended(
  landmarks: Landmark[],
  tip: number,
  pip: number,
): boolean {
  const t = landmarks[tip];
  const p = landmarks[pip];
  if (!t || !p) return false;
  return t.y < p.y;
}

/** Is the thumb extended (x-axis, handedness-aware)? */
export function isThumbExtended(
  landmarks: Landmark[],
  handedness?: Handedness,
): boolean {
  if (handedness !== "Left" && handedness !== "Right") return false;
  const tip = landmarks[THUMB_TIP];
  const mcp = landmarks[THUMB_MCP];
  if (!tip || !mcp) return false;
  // Raw (non-mirrored) frame: a right hand's thumb points left (-x).
  return handedness === "Right" ? tip.x < mcp.x : tip.x > mcp.x;
}

/** Count extended fingers (0–5), including the handedness-aware thumb. */
export function countExtendedFingers(
  landmarks: Landmark[],
  handedness?: Handedness,
): number {
  let count = 0;
  if (isFingerExtended(landmarks, INDEX_TIP, INDEX_PIP)) count++;
  if (isFingerExtended(landmarks, MIDDLE_TIP, MIDDLE_PIP)) count++;
  if (isFingerExtended(landmarks, RING_TIP, RING_PIP)) count++;
  if (isFingerExtended(landmarks, PINKY_TIP, PINKY_PIP)) count++;
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
