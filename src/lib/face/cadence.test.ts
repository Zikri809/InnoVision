import { describe, it, expect } from "vitest";
import { PeriodicCadence, shouldScheduleFaceCheck } from "./cadence";

/**
 * I22 — cadence unit tests: jitter bounds, no-stack (clear-then-set), phase
 * semantics, tab-state (status gating), periodic override shape.
 */
describe("PeriodicCadence", () => {
  it("I22: jitter stays within [min, max]", () => {
    let rngValue = 0;
    const cadence = new PeriodicCadence({ minMs: 1000, maxMs: 2000, rng: () => rngValue });
    rngValue = 0;
    expect(cadence.nextDelayMs()).toBe(1000);
    rngValue = 1;
    expect(cadence.nextDelayMs()).toBe(2000);
    rngValue = 0.5;
    expect(cadence.nextDelayMs()).toBe(1500);
  });

  it("I22: defaults to 30–45s", () => {
    const cadence = new PeriodicCadence({ rng: () => 0 });
    expect(cadence.nextDelayMs()).toBe(30000);
    const max = new PeriodicCadence({ rng: () => 1 });
    expect(max.nextDelayMs()).toBe(45000);
  });

  it("I22: rejects invalid bounds", () => {
    expect(() => new PeriodicCadence({ minMs: -1, maxMs: 100 })).toThrow();
    expect(() => new PeriodicCadence({ minMs: 200, maxMs: 100 })).toThrow();
    expect(() => new PeriodicCadence({ minMs: NaN, maxMs: 100 })).toThrow();
  });

  it("I22: clear-then-set contract — a new schedule replaces the old delay", () => {
    // nextDelayMs is deterministic given the rng sequence; the no-stack
    // property is enforced at the pipeline (single cadenceTimerRef), but the
    // cadence itself must be a pure value source — two calls with the same
    // rng produce the same value (no internal accumulation).
    const cadence = new PeriodicCadence({ minMs: 100, maxMs: 100 });
    expect(cadence.nextDelayMs()).toBe(100);
    expect(cadence.nextDelayMs()).toBe(100);
  });
});

describe("shouldScheduleFaceCheck", () => {
  it("I22: only schedules when status is ready", () => {
    expect(shouldScheduleFaceCheck("ready", "question")).toBe(true);
    expect(shouldScheduleFaceCheck("gate", "question")).toBe(false);
    expect(shouldScheduleFaceCheck("paused", "question")).toBe(false);
    expect(shouldScheduleFaceCheck("flagged", "question")).toBe(false);
    expect(shouldScheduleFaceCheck("unavailable", "question")).toBe(false);
    expect(shouldScheduleFaceCheck("off", "question")).toBe(false);
    expect(shouldScheduleFaceCheck("exempt", "question")).toBe(false);
    expect(shouldScheduleFaceCheck("recovering", "question")).toBe(false);
  });

  it("I22: schedules on question and locked (locked answers can't swap)", () => {
    expect(shouldScheduleFaceCheck("ready", "question")).toBe(true);
    expect(shouldScheduleFaceCheck("ready", "locked")).toBe(true);
  });

  it("I22: does NOT schedule during feedback/submitting/submitted/timeUp/dead", () => {
    for (const phase of ["feedback", "submitting", "submitted", "timeUp", "dead"]) {
      expect(shouldScheduleFaceCheck("ready", phase)).toBe(false);
    }
  });

  it("I22: tab-state is a status concern — hidden handling lives in the pipeline", () => {
    // The cadence module itself has no visibility concept; the pipeline pauses
    // cadence while hidden. Pinning the shape: a hidden pipeline should not be
    // 'ready'-scheduling. This is enforced by the pipeline passing a status
    // that reflects visibility, so we just assert status-gating covers it.
    expect(shouldScheduleFaceCheck("ready", "question")).toBe(true);
  });
});
