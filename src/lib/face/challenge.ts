/**
 * Pure anti-replay head-turn challenge (integrity hardening).
 *
 * A blink is replayable: any pre-recorded video of the enrolled student
 * blinking passes `waitForBlink` AND the 1:1 face match. This challenge
 * requires a head turn in a RANDOMLY CHOSEN direction — a live response that
 * a recording cannot contain (the recording's turn direction can't match a
 * coin flip made after the recording was made).
 *
 * PURE and injectable-clock (`nowMs` on every feed) so it is Node-unit-tested
 * — the house precedent is `attention.ts` / `liveness.ts`. The tracker owns
 * the wiring (`waitForHeadTurn` mirrors `waitForBlink`'s resolver pattern);
 * the pipeline owns the random side choice and failure landings.
 *
 * Turn completion: |yaw| ≥ HEAD_TURN_YAW_MIN in the REQUIRED direction
 * (positive yaw = the student turns toward THEIR OWN left — the tracker's
 * signed convention), SUSTAINED for HEAD_TURN_SUSTAIN_MS so a fast wobble
 * crossing the threshold in passing does not resolve the challenge.
 */

import {
  HEAD_TURN_SUSTAIN_MS,
  HEAD_TURN_YAW_MIN,
} from "./constants";

/** The direction the student must turn toward. Positive yaw = their left. */
export type TurnSide = "left" | "right";

export type ChallengeSample = {
  yaw: number;
  faceDetected: boolean;
};

export class HeadTurnChallenge {
  private readonly side: TurnSide;
  /** Timestamp the turn FIRST crossed the required threshold (null = not yet). */
  private crossedSinceMs: number | null = null;
  private passed = false;

  constructor(side: TurnSide) {
    this.side = side;
  }

  get turnSide(): TurnSide {
    return this.side;
  }

  /**
   * The yaw value the required direction demands (positive = left, matching
   * the tracker's signed convention).
   */
  private requiredYaw(): number {
    return this.side === "left" ? HEAD_TURN_YAW_MIN : -HEAD_TURN_YAW_MIN;
  }

  /**
   * Feed one pose sample. Returns true ONCE, on the sample that completes
   * the sustained turn. A large face-absent gap resets the sustain window
   * (tracking loss mid-challenge restarts it).
   */
  feed(sample: ChallengeSample, nowMs: number, prevSampleMs: number | null): boolean {
    if (this.passed) return false;
    const inDirection =
      sample.faceDetected &&
      (this.side === "left" ? sample.yaw >= this.requiredYaw() : sample.yaw <= this.requiredYaw());
    if (!inDirection) {
      this.crossedSinceMs = null;
      return false;
    }
    // Sustain: the threshold must hold CONTINUOUSLY. A tracking gap longer
    // than the sustain window means the "turn" evidence is not continuous —
    // restart from now.
    if (
      this.crossedSinceMs !== null &&
      prevSampleMs !== null &&
      nowMs - prevSampleMs > HEAD_TURN_SUSTAIN_MS
    ) {
      this.crossedSinceMs = nowMs;
      return false;
    }
    if (this.crossedSinceMs === null) {
      this.crossedSinceMs = nowMs;
      return false;
    }
    if (nowMs - this.crossedSinceMs >= HEAD_TURN_SUSTAIN_MS) {
      this.passed = true;
      return true;
    }
    return false;
  }

  reset(): void {
    this.crossedSinceMs = null;
    this.passed = false;
  }
}

/** Pick the challenge side uniformly at random. */
export function randomTurnSide(rng: () => number = Math.random): TurnSide {
  return rng() < 0.5 ? "left" : "right";
}
