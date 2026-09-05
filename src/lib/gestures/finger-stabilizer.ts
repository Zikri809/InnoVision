/**
 * Temporal debouncer for per-frame finger counts.
 *
 * MediaPipe occasionally flickers a wrong count for a single frame (e.g. a
 * folded pinky's tip crossing its PIP joint while the hand tilts). Downstream
 * that is doubly punishing: the hold UI flashes the wrong finger AND
 * `HoldConfirm` resets its accumulator on ANY finger change, so one spurious
 * frame restarts the 1.2s hold from zero.
 *
 * The filter COMMITS a count and only switches after `FINGER_STABILIZER_RUN`
 * consecutive frames of a different count — a single-frame spike can never
 * surface, and a genuine pose change lands within ~2 frames (~66ms at the
 * 30fps cap, negligible against HOLD_MS).
 *
 * `handPresent` passes through RAW (never smoothed): the hand-loss monitor
 * owns presence latency. Absence resets the filter; the first present frame
 * after re-entry seeds fresh so no stale count leaks across an episode.
 *
 * Frame-count based (one update per tracker frame), pure synchronous state —
 * mirrors the HoldConfirm/HandLossMonitor precedent in this directory.
 */

/** Consecutive differing frames required before the committed count switches. */
export const FINGER_STABILIZER_RUN = 2;

export class FingerStabilizer {
  private seeded = false;
  private committed = 0;
  private candidate = 0;
  private candidateRun = 0;

  /**
   * Feed one tracker frame. Returns the stabilized count (0 when the hand is
   * absent).
   */
  update(fingerCount: number, handPresent: boolean): number {
    if (!handPresent) {
      this.reset();
      return 0;
    }
    if (!this.seeded) {
      this.seeded = true;
      this.committed = fingerCount;
      this.candidate = 0;
      this.candidateRun = 0;
      return this.committed;
    }
    if (fingerCount === this.committed) {
      this.candidateRun = 0;
      return this.committed;
    }
    if (fingerCount === this.candidate) {
      this.candidateRun++;
    } else {
      this.candidate = fingerCount;
      this.candidateRun = 1;
    }
    if (this.candidateRun >= FINGER_STABILIZER_RUN) {
      this.committed = this.candidate;
      this.candidateRun = 0;
    }
    return this.committed;
  }

  /** Clear all state (tracker stop / hand-loss episode). */
  reset(): void {
    this.seeded = false;
    this.committed = 0;
    this.candidate = 0;
    this.candidateRun = 0;
  }
}
