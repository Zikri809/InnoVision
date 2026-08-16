/**
 * Pure periodic-verify cadence (Phase 7).
 *
 * `PeriodicCadence.nextDelayMs()` computes the next verify delay with jitter
 * inside `[minMs, maxMs]` (default 30–45s). The CLEAR-THEN-SET contract (a new
 * schedule always replaces any prior timer — no stacking) is enforced by the
 * PIPELINE via a single `cadenceTimerRef`; this class is a pure value source.
 *
 * PURE and env-free: `rng` is injected (defaults to `Math.random`) and the E2E
 * seam (`FakeFaceControl.setFacePeriodic`) is read by the PIPELINE at cadence
 * construction, NOT here — so this module stays trivially unit-testable and
 * never touches `globalThis`. Key names `minMs`/`maxMs` match
 * `FakeFaceControl.setFacePeriodic` exactly (PLAN_PHASE7 §2).
 */
export type PeriodicCadenceOptions = {
  minMs?: number;
  maxMs?: number;
  /** Injectable RNG (0..1) — deterministic in unit tests. */
  rng?: () => number;
};

export class PeriodicCadence {
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly rng: () => number;

  constructor(opts: PeriodicCadenceOptions = {}) {
    const min = opts.minMs ?? 30000;
    const max = opts.maxMs ?? 45000;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
      throw new Error("PeriodicCadence: minMs/maxMs must be finite with max >= min >= 0");
    }
    this.minMs = min;
    this.maxMs = max;
    this.rng = opts.rng ?? Math.random;
  }

  /** Next delay within [min, max] (inclusive), jittered by the injected RNG. */
  nextDelayMs(): number {
    const span = this.maxMs - this.minMs;
    return Math.round(this.minMs + this.rng() * span);
  }
}

/**
 * Should a periodic (or Q-transition) face check run in the given state?
 *  - `status` is the face pipeline status (gate/ready/recovering/…).
 *  - `phase` is the PlayClient phase (`'question'` | `'locked'` | …).
 *
 * `questionVisible` semantics (I22): feedback dwell is NOT separately
 * verified — a locked answer can't be swapped, so verifying during feedback is
 * waste. The pipeline verifies on Q-transition (entering `'question'`) and on
 * the periodic timer.
 */
export function shouldScheduleFaceCheck(
  status: string,
  phase: string,
): boolean {
  if (status !== "ready") return false;
  return phase === "question" || phase === "locked";
}
