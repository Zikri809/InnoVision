/**
 * Pure multi-frame vote evaluation for one face check.
 *
 * MIRROR-NOT-ENFORCEMENT: the authoritative verdict lives inside
 * `record_face_check` (migration `0020_integrity_suite.sql`): matched =
 * strict majority of per-frame similarities ≥ FACE_SIMILARITY_MIN, over the
 * frames the client actually submitted (1 frame → that frame must match;
 * 2 frames → both; 3 frames → 2-of-3). This module is the JS mirror powering
 * unit tests and keeping the route's expectations honest — a disagreeing
 * client simply fails/succeeds per the server's verdict.
 *
 * Distance semantics: `1 − max(similarity)` — the best frame's reading is
 * what the lecturer timeline shows (the most favorable LEGITIMATE reading;
 * voting already handles the unfavorable case).
 */

export type FrameVoteEvaluation = {
  /** Strict majority of submitted frames met the similarity floor. */
  matched: boolean;
  /** `1 − max(similarity)`, or null when no similarities were provided. */
  distance: number | null;
};

import { FACE_SIMILARITY_MIN } from "./constants";

/**
 * Evaluate one check's votes. Null/undefined entries count as FAIL votes
 * (a frame CompreFace could not read is never silently forgiven); empty
 * arrays are a total capture failure → fail with null distance (mirrors the
 * sentinel path).
 */
export function evaluateFrameVotes(
  similarities: (number | null)[],
  threshold: number = FACE_SIMILARITY_MIN,
): FrameVoteEvaluation {
  const valid = similarities.filter(
    (s): s is number => typeof s === "number" && Number.isFinite(s),
  );
  if (valid.length === 0 || similarities.length === 0) {
    return { matched: false, distance: null };
  }
  let hits = 0;
  for (const s of valid) {
    if (s >= threshold) hits++;
  }
  // Strict majority over SUBMITTED frames: hits*2 > n.
  const matched = hits * 2 > similarities.length && hits > 0;
  return { matched, distance: 1 - Math.max(...valid) };
}
