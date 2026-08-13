import { describe, it, expect } from "vitest";
import { HandLossMonitor } from "./hand-loss";

describe("U-G6 — warning at 3s, pause at 10s (assessment), once per episode", () => {
  it("fires warn at 3000 and pause at 10000, then stays silent", () => {
    const m = new HandLossMonitor({ warnAfterMs: 3000, pauseAfterMs: 10000 });
    expect(m.update(false, 0)).toEqual({ warn: false, pause: false });
    expect(m.update(false, 2999)).toEqual({ warn: false, pause: false });
    expect(m.update(false, 3000)).toEqual({ warn: true, pause: false });
    expect(m.update(false, 9999)).toEqual({ warn: false, pause: false });
    expect(m.update(false, 10000)).toEqual({ warn: false, pause: true });
    expect(m.update(false, 10001)).toEqual({ warn: false, pause: false }); // once per episode
  });

  it("re-arms for a second absence episode after the hand returns", () => {
    const m = new HandLossMonitor({ warnAfterMs: 3000, pauseAfterMs: 10000 });
    m.update(false, 0);
    expect(m.update(false, 15000)).toEqual({ warn: true, pause: true });

    // Hand present at 16000 → episode reset (and re-armed).
    expect(m.update(true, 16000)).toEqual({ warn: false, pause: false });
    expect(m.update(false, 20000)).toEqual({ warn: false, pause: false });
    // Second episode: warn at 23000 (20000 + 3000), pause at 30000 (20000 + 10000).
    expect(m.update(false, 23000)).toEqual({ warn: true, pause: false });
    expect(m.update(false, 30000)).toEqual({ warn: false, pause: true });
  });

  it("practice (pauseAfterMs null) warns but never pauses", () => {
    const m = new HandLossMonitor({ warnAfterMs: 3000, pauseAfterMs: null });
    m.update(false, 0);
    expect(m.update(false, 15000)).toEqual({ warn: true, pause: false });
  });

  it("reset() clears the episode and re-arms both triggers", () => {
    const m = new HandLossMonitor({ warnAfterMs: 3000, pauseAfterMs: 10000 });
    m.update(false, 0);
    m.update(false, 15000);
    m.reset();
    expect(m.update(false, 16000)).toEqual({ warn: false, pause: false });
    expect(m.update(false, 19000)).toEqual({ warn: true, pause: false });
    expect(m.update(false, 26000)).toEqual({ warn: false, pause: true });
  });

  it("a single present frame mid-absence resets the episode (flicker)", () => {
    const m = new HandLossMonitor({ warnAfterMs: 3000, pauseAfterMs: 10000 });
    m.update(false, 0);
    expect(m.update(false, 2999)).toEqual({ warn: false, pause: false });
    // A brief present frame at 2999 resets the absent clock.
    expect(m.update(true, 3000)).toEqual({ warn: false, pause: false });
    expect(m.update(false, 4000)).toEqual({ warn: false, pause: false });
    expect(m.update(false, 7000)).toEqual({ warn: true, pause: false });
  });
});

describe("HandLossMonitor constructor guards", () => {
  it("rejects negative or non-finite thresholds", () => {
    expect(() => new HandLossMonitor({ warnAfterMs: -1 })).toThrow();
    expect(() => new HandLossMonitor({ warnAfterMs: Number.NaN })).toThrow();
    expect(() => new HandLossMonitor({ pauseAfterMs: -5 })).toThrow();
    expect(() => new HandLossMonitor({ pauseAfterMs: Number.POSITIVE_INFINITY })).toThrow();
  });
});
