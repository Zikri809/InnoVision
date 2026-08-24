import { EYE_CLOSED_MIN, EYE_OPEN_MAX } from "./constants";

/**
 * Pure blink detector (Phase 7 liveness).
 *
 * A blink is a transition from "both eyes open" to "both eyes closed" (the
 * blendshape values `eyeBlinkLeft`/`eyeBlinkRight` go from <= EYE_OPEN_MAX to
 * >= EYE_CLOSED_MIN). The detector is a small state machine:
 *  - `pending` → no blink observed yet (or reset).
 *  - `passed` → an open→closed transition was observed.
 *  - `failed` → a closed→open transition happened without a prior open→closed
 *    (e.g. the camera saw the user already mid-blink); the caller re-arms.
 *
 * Pure and synchronous — `nowMs` is injected for testability; the real tracker
 * drives it from its rAF loop, the E2E fake from scripted blendshapes.
 */
export type BlinkState = "pending" | "passed" | "failed";

export class BlinkDetector {
  private state: BlinkState = "pending";
  /**
   * Was the previous sample "eyes open"? Initialized FALSE (no open sample
   * observed yet) — a camera that starts with the eyes already closed must NOT
   * register a false pass; only a genuine open→closed transition passes.
   */
  private wasOpen = false;

  constructor(
    private readonly eyeOpenMax: number = EYE_OPEN_MAX,
    private readonly eyeClosedMin: number = EYE_CLOSED_MIN,
  ) {}

  /**
   * Feed one liveness sample. `left`/`right` are the blendshape values
   * (0..1). Returns the current state after the update.
   */
  update(left: number, right: number): BlinkState {
    if (this.state !== "pending") return this.state;

    // CLOSED is evaluated FIRST: the single-eye rule overlaps the open
    // fallbacks (e.g. left=0.62/right=0.18 averages to "open"), and a strong
    // closure must always win the tie — otherwise turned-pose blinks read as
    // permanently open.
    const isClosed =
      (left >= this.eyeClosedMin && right >= this.eyeClosedMin) ||
      // Dominant single-eye closure also counts: at a turned pose the FAR eye
      // is geometrically occluded and its blendshape stays low even mid-blink
      // — requiring both eyes stranded blinks at the exact angles the guided
      // enrollment asks for. A strong one-eye close is still a voluntary
      // live-motion transition (a photo can never produce it).
      Math.max(left, right) >= this.eyeClosedMin;
    const isOpen =
      (left <= this.eyeOpenMax && right <= this.eyeOpenMax) ||
      (Math.min(left, right) <= this.eyeOpenMax && (left + right) / 2 <= 0.48);

    if (isClosed) {
      if (this.wasOpen) {
        // Open→closed transition → genuine blink observed.
        this.state = "passed";
        return this.state;
      }
      // Closed but no open sample yet (camera started mid-blink) — wait.
      return this.state;
    }
    if (isOpen) {
      this.wasOpen = true;
      return this.state;
    }

    // Ambiguous (between thresholds). If we never saw an open sample, this is
    // an unverifiable mid-blink start → fail so the caller re-arms rather than
    // letting a stale "closed" sample pass later.
    if (!this.wasOpen) {
      this.state = "failed";
    }
    return this.state;
  }

  get stateValue(): BlinkState {
    return this.state;
  }

  /** Reset to pending (re-arm after a failure or before a new wait). */
  reset(): void {
    this.state = "pending";
    this.wasOpen = false;
  }
}
