/**
 * Pure hand-loss monitor (Phase 6).
 *
 * `update(handPresent, nowMs)` returns `{ warn, pause }` — each fires ONCE per
 * absence episode (a `warn` at `warnAfterMs`, a `pause` at `pauseAfterMs`);
 * `handPresent` true resets the episode and re-arms both for the next one.
 * `pauseAfterMs: null` (practice) → never pauses.
 *
 * Pure and synchronous (injected `nowMs`), mirroring `lib/sessions/timer.ts`.
 */
export type HandLossMonitorOptions = {
  warnAfterMs?: number;
  pauseAfterMs?: number | null;
};

export class HandLossMonitor {
  private readonly warnAfterMs: number;
  private readonly pauseAfterMs: number | null;
  private absentSinceMs: number | null = null;
  private warned = false;
  private paused = false;

  constructor(opts: HandLossMonitorOptions = {}) {
    const warnAfterMs = opts.warnAfterMs ?? 3000;
    // Distinguish `undefined` (default 10s) from explicit `null` (never pause):
    // `?? 10000` would collapse `null` into 10000, breaking practice mode.
    const pauseAfterMs =
      opts.pauseAfterMs === undefined ? 10000 : opts.pauseAfterMs;
    if (!Number.isFinite(warnAfterMs) || warnAfterMs < 0) {
      throw new Error("warnAfterMs must be a non-negative finite number");
    }
    if (pauseAfterMs !== null && (!Number.isFinite(pauseAfterMs) || pauseAfterMs < 0)) {
      throw new Error("pauseAfterMs must be null or a non-negative finite number");
    }
    this.warnAfterMs = warnAfterMs;
    this.pauseAfterMs = pauseAfterMs;
  }

  update(handPresent: boolean, nowMs: number): { warn: boolean; pause: boolean } {
    if (handPresent) {
      // Hand visible → reset the episode and re-arm both triggers.
      this.absentSinceMs = null;
      this.warned = false;
      this.paused = false;
      return { warn: false, pause: false };
    }

    if (this.absentSinceMs === null) {
      this.absentSinceMs = nowMs;
      return { warn: false, pause: false };
    }

    const elapsed = nowMs - this.absentSinceMs;
    const warn = !this.warned && elapsed >= this.warnAfterMs;
    if (warn) this.warned = true;

    let pause = false;
    if (this.pauseAfterMs !== null && !this.paused && elapsed >= this.pauseAfterMs) {
      pause = true;
      this.paused = true;
    }
    return { warn, pause };
  }

  /** Clear the current episode (also re-arms both triggers). */
  reset(): void {
    this.absentSinceMs = null;
    this.warned = false;
    this.paused = false;
  }
}
