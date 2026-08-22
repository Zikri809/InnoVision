/**
 * Pure attention-monitor for integrity advisories.
 *
 * Consumes per-frame pose samples (from the MediaPipe tracker's rAF loop) and
 * emits two LECTURER-VISIBLE advisory events — never status changes:
 *
 *  - `second_face`: ≥2 faces tracked continuously for SECOND_FACE_SUSTAIN_MS
 *    within a sample gap tolerance. A roommate walking past is a review hint,
 *    not an accusation.
 *  - `looked_away`: face present but off-axis/off-center accumulated for
 *    LOOK_AWAY_ACCUMULATE_MS inside a rolling LOOK_AWAY_WINDOW_MS. Eyes do
 *    most of the work when glancing at a second screen; this is deliberately
 *    a soft signal.
 *
 * PURE and injectable-clock (`nowMs` on every feed) so it is Node-unit-tested;
 * the pipeline hook owns throttling + reporting.
 */

export type AdvisoryType = "second_face" | "looked_away" | "voice_activity" | "headset_active";

export type AttentionSample = {
  yaw: number;
  centered: boolean;
  faceDetected: boolean;
  /** Number of faces the tracker saw in this frame (1 when absent). */
  facesSeen?: number;
};

export type AttentionEvent = { type: AdvisoryType; atMs: number };

import {
  LOOK_AWAY_ACCUMULATE_MS,
  LOOK_AWAY_WINDOW_MS,
  LOOK_AWAY_YAW_DEG,
  SECOND_FACE_SUSTAIN_MS,
} from "./constants";

/** Max gap between consecutive samples before accumulation resets (ms). */
const SAMPLE_GAP_RESET_MS = 2000;

export class AttentionMonitor {
  private secondFaceSinceMs: number | null = null;
  private lastSampleMs: number | null = null;
  // Off-axis EPISODES — endMs advances only across CONSECUTIVE away samples,
  // so centered glances back are never counted as away time.
  private episodes: { startMs: number; endMs: number }[] = [];
  private prevSampleAway = false;

  /**
   * Feed one pose sample. Returns advisory events fired by THIS sample
   * (at most one per type; throttling is the caller's job).
   */
  feed(sample: AttentionSample, nowMs: number): AttentionEvent[] {
    const events: AttentionEvent[] = [];

    // A large gap means the loop stalled (hidden tab, boot) — reset state.
    if (this.lastSampleMs !== null && nowMs - this.lastSampleMs > SAMPLE_GAP_RESET_MS) {
      this.secondFaceSinceMs = null;
      this.episodes = [];
      this.prevSampleAway = false;
    }
    this.lastSampleMs = nowMs;

    // ── Second face ────────────────────────────────────────────────
    const multi = (sample.facesSeen ?? 1) >= 2;
    if (!multi) {
      this.secondFaceSinceMs = null;
    } else if (this.secondFaceSinceMs === null) {
      this.secondFaceSinceMs = nowMs;
    } else if (nowMs - this.secondFaceSinceMs >= SECOND_FACE_SUSTAIN_MS) {
      events.push({ type: "second_face", atMs: nowMs });
      // Re-arm from now so sustained presence re-fires only after another
      // full sustain window.
      this.secondFaceSinceMs = nowMs;
    }

    // ── Looked away ────────────────────────────────────────────────
    const lookingAway =
      sample.faceDetected && (!sample.centered || Math.abs(sample.yaw) > LOOK_AWAY_YAW_DEG);
    if (lookingAway) {
      const last = this.episodes[this.episodes.length - 1];
      if (last && this.prevSampleAway) {
        // Consecutive away sample → extend the episode (exact away time).
        last.endMs = nowMs;
      } else {
        this.episodes.push({ startMs: nowMs, endMs: nowMs });
      }
    }
    this.prevSampleAway = lookingAway;

    // Prune outside the rolling window.
    this.episodes = this.episodes.filter((s) => nowMs - s.startMs <= LOOK_AWAY_WINDOW_MS);
    let accumulated = 0;
    for (const s of this.episodes) {
      accumulated += Math.max(0, s.endMs - s.startMs);
    }
    if (accumulated >= LOOK_AWAY_ACCUMULATE_MS) {
      events.push({ type: "looked_away", atMs: nowMs });
      // Reset accumulation so the next event needs fresh sustained looking.
      this.episodes = [];
      this.prevSampleAway = false;
    }

    return events;
  }

  /** Drop all state (status left ready / unmount). */
  reset(): void {
    this.secondFaceSinceMs = null;
    this.episodes = [];
    this.prevSampleAway = false;
    this.lastSampleMs = null;
  }
}
