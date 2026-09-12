/**
 * audit-2 C-01 — photo/replay spoof gate policy (PURE, env-free mirror).
 *
 * The sidecar's MiniFASNet ensemble (docker/insightface/app/spoof.py)
 * returns one verdict per frame: `score` = averaged P(real face) in [0, 1].
 * This module owns the ROUTE's policy for turning per-frame verdicts into a
 * single decision, so the thresholds are unit-testable and documented in one
 * place (mirror-not-enforcement: the route reads FACE_SPOOF_ENFORCE and
 * applies this decision; the sidecar never enforces).
 *
 * Decision rule — fail the check only when the SPOOFED frames are the
 * majority among frames that produced a verdict:
 *   - fake  := score < FACE_SPOOF_MAJORITY_REAL_SCORE (model's own argmax
 *     boundary, 0.5 — Silent-Face is trained/calibrated to sit well clear of
 *     it for live faces);
 *   - real  := score >= the boundary;
 *   - unknown := verdict missing (old sidecar, no detectable face, model
 *     weights absent) — never counts toward a fail, because a no-face frame
 *     is ALREADY an independent FAIL vote at the similarity stage and a
 *     missing ensemble must degrade to the pre-C-01 behavior.
 * A single fake verdict among several real ones does NOT force the fail —
 * it is recorded for the lecturer audit instead (one mis-classified frame
 * under bad lighting must not flag an honest student).
 *
 * The verify route attaches every raw score to face_checks.frame_poses so a
 * lecturer can see borderline frames even when the gate passes them.
 */

/**
 * P(real) at or above which a frame's verdict counts as "real". 0.5 is the
 * ensemble's argmax boundary — the model itself decides, we do not
 * second-guess it toward fake (an FP flags honest students; an FN here is
 * still caught by similarity + streak machinery).
 */
export const FACE_SPOOF_MAJORITY_REAL_SCORE = 0.5;

export type SpoofFrameVerdict = { real: boolean; score: number } | null | undefined;

export type SpoofDecision = {
  /** Verdict-bearing frames classified fake. */
  fakeCount: number;
  /** Verdict-bearing frames classified real. */
  realCount: number;
  /** Frames without a verdict (no face, old sidecar, weights missing). */
  unknownCount: number;
  /** True when the fake frames are the majority of verdicts — a spoof. */
  forcedFail: boolean;
};

export function spoofGateDecision(verdicts: SpoofFrameVerdict[]): SpoofDecision {
  let fakeCount = 0;
  let realCount = 0;
  let unknownCount = 0;
  for (const v of verdicts) {
    if (!v || typeof v.score !== "number" || !Number.isFinite(v.score)) {
      unknownCount++;
      continue;
    }
    if (v.score >= FACE_SPOOF_MAJORITY_REAL_SCORE) realCount++;
    else fakeCount++;
  }
  return {
    fakeCount,
    realCount,
    unknownCount,
    forcedFail: fakeCount > 0 && fakeCount > realCount,
  };
}
