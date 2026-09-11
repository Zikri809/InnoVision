/**
 * Pure server-side second-face detection (Feature B, integrity hardening).
 *
 * The verify route receives ALL faces per frame from the sidecar's `/extract`
 * but `selectPrimaryFace` collapses each frame to one face — every other face
 * is discarded today. This module re-examines the discarded faces so the
 * SERVER (not the student's own browser) records the `second_face` advisory:
 * a tampered client can silence its own attention monitor, but it cannot
 * suppress what the server sees in the frames it receives.
 *
 * Noise gates (design critique 2026-09): a bare "any extra detection" rule
 * spams the lecturer chip with passers-by, posters, and reflections. A frame
 * counts ONLY when an extra face is:
 *   1. real enough — det_score ≥ DETECTION_SCORE_MIN (the same 0.6 floor the
 *      primary uses), AND
 *   2. substantial — bbox area ≥ 15% of the primary's (kills reflections and
 *      edge slivers), AND
 *   3. a distinct head — bbox center at least one primary-span away (kills
 *      ghost/split detections overlapping the subject).
 * A check reports only when ≥2 of the submitted frames qualify (kills
 * single-frame split-detection blips). The 55s RPC throttle + upsert dedupe
 * bound the row/occurrence rate on top.
 */

import { DETECTION_SCORE_MIN, selectPrimaryFace, type InsightFaceFace } from "./embedding";

/** Extra-face bbox area must be ≥ this fraction of the primary's. */
export const SECOND_FACE_AREA_RATIO_MIN = 0.15;

/**
 * Extra-face center must sit at least this multiple of the primary's largest
 * bbox dimension away from the primary's center.
 */
export const SECOND_FACE_CENTER_DISPLACEMENT_FACTOR = 1.0;

/** Qualifying frames (out of the ≤3 submitted) needed to report. */
export const SECOND_FACE_MIN_FRAMES = 2;

function bboxArea(f: InsightFaceFace): number {
  const [x1, y1, x2, y2] = f.bbox;
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

/** One frame carries a qualifying extra face (primary excluded by identity). */
export function frameHasSecondFace(faces: InsightFaceFace[]): boolean {
  const primary = selectPrimaryFace(faces);
  if (!primary) return false;
  const primaryArea = bboxArea(primary);
  if (primaryArea <= 0) return false;
  const [px1, py1, px2, py2] = primary.bbox;
  const primarySpan = Math.max(px2 - px1, py2 - py1);
  const pcx = (px1 + px2) / 2;
  const pcy = (py1 + py2) / 2;

  for (const f of faces) {
    if (f === primary) continue;
    if (f.det_score < DETECTION_SCORE_MIN) continue;
    if (bboxArea(f) / primaryArea < SECOND_FACE_AREA_RATIO_MIN) continue;
    const [x1, y1, x2, y2] = f.bbox;
    const dist = Math.hypot((x1 + x2) / 2 - pcx, (y1 + y2) / 2 - pcy);
    if (dist >= primarySpan * SECOND_FACE_CENTER_DISPLACEMENT_FACTOR) return true;
  }
  return false;
}

/** Number of submitted frames carrying a qualifying extra face. */
export function countSecondFaceFrames(frames: InsightFaceFace[][]): number {
  let n = 0;
  for (const faces of frames) {
    if (frameHasSecondFace(faces)) n += 1;
  }
  return n;
}

/** Report gate for one verify call: enough frames carry a second face. */
export function shouldReportSecondFace(frames: InsightFaceFace[][]): boolean {
  return countSecondFaceFrames(frames) >= SECOND_FACE_MIN_FRAMES;
}
