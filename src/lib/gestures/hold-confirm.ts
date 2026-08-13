import { MAX_ANSWER_FINGERS } from "./constants";

/**
 * Pure, latched hold-to-confirm state machine (Phase 6).
 *
 * `update(fingers, nowMs)` returns `{ progress, latched? }` where `latched` is
 * the 1-based finger that completed a hold, present EXACTLY once per stable
 * hold. Further `update`s with the same finger return `{ progress: 1 }`
 * without `latched` until `reset()`. A finger change, `fingers === 0`, or an
 * out-of-range finger resets the accumulator.
 *
 * The state machine returns the FINGER (not a pre-mapped option index) — the
 * caller maps through `mapFingersToOption`, so that module stays the single
 * finger→index authority.
 *
 * Pure and synchronous (injected `nowMs`), mirroring `lib/sessions/timer.ts`.
 */
export class HoldConfirm {
  private readonly holdMs: number;
  private activeFinger = 0;
  private holdStartMs = 0;
  private latched = false;

  constructor(holdMs: number) {
    if (!Number.isFinite(holdMs) || holdMs <= 0) {
      throw new Error("holdMs must be a positive finite number");
    }
    this.holdMs = holdMs;
  }

  /**
   * Advance the machine with the current 1-based finger count and timestamp.
   * Returns the 0..1 progress for the active finger and, exactly once per
   * stable hold, `latched` = the 1-based finger that completed it.
   */
  update(
    fingers: number,
    nowMs: number,
  ): { progress: number; latched?: number } {
    // Out-of-range (0, negative, > MAX) → full reset (U-G2/U-G7).
    if (fingers < 1 || fingers > MAX_ANSWER_FINGERS || !Number.isInteger(fingers)) {
      this.reset();
      return { progress: 0 };
    }

    // Latch released only by reset() — same finger after a latch stays at 1.
    if (this.latched) {
      if (this.activeFinger === fingers) {
        return { progress: 1 };
      }
      // A different finger while latched is a full reset (fresh hold).
      this.reset();
    }

    // Finger change mid-hold → restart the accumulator (U-G4).
    if (fingers !== this.activeFinger) {
      this.activeFinger = fingers;
      this.holdStartMs = nowMs;
      return { progress: 0 };
    }

    const elapsed = nowMs - this.holdStartMs;
    if (elapsed < 0) {
      // Clock went backwards — restart rather than emit a spurious progress.
      this.holdStartMs = nowMs;
      return { progress: 0 };
    }
    const progress = Math.min(1, elapsed / this.holdMs);

    if (progress >= 1) {
      this.latched = true;
      return { progress: 1, latched: fingers };
    }
    return { progress };
  }

  /** Clear the latch + accumulator. */
  reset(): void {
    this.activeFinger = 0;
    this.holdStartMs = 0;
    this.latched = false;
  }
}
