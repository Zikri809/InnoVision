/**
 * Pure FLAT sliding-window face-check evaluation (Phase 7).
 *
 * MIRROR-NOT-ENFORCEMENT: the authoritative window lives inside
 * `record_face_check` (migration `0009_face.sql`, FLAT last-5 with ordering
 * `checked_at DESC, id DESC`). This module is the JS mirror powering unit
 * tests (U-F6/U-F7c) and keeping the client's status expectations honest.
 *
 * Semantics (PLAN_PHASE7 §2):
 *  - FLAT last-5: combine the current check with the most recent 4, take the
 *    last 5 FLAT (no pass truncation). `F,P,F,P,F` → flagged.
 *  - A pass NEVER flags the current check (`currentMatch=true` → `active`,
 *    streak 0).
 *  - A fail with >= 3 fails in the 5-window → `flagged` (streak = fail count);
 *    otherwise → `paused` (blink-recoverable).
 *  - Continuous V/−V alternation hard-flags at the 6th check (the window
 *    reaches `F,P,F,P,F`).
 *  - A post-unlock pass returns `active` for that check but does not clear
 *    standing fails (integrity-conservative) — a subsequent fail re-flags.
 */
export type FaceCheckEvaluation = {
  status: "active" | "paused" | "flagged";
  streak: number;
};

export function evaluateFaceCheck(
  recentChecks: boolean[],
  currentMatch: boolean,
): FaceCheckEvaluation {
  // FLAT last-5: current check + the 4 most recent (most-recent-last order).
  const window = [...recentChecks.slice(-4), currentMatch].slice(-5);

  if (currentMatch) {
    // A pass never flags the current check.
    return { status: "active", streak: 0 };
  }

  let fails = 0;
  for (const m of window) {
    if (!m) fails++;
  }

  if (fails >= 3) {
    return { status: "flagged", streak: fails };
  }
  return { status: "paused", streak: fails };
}
