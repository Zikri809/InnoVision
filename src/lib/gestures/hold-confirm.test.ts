import { describe, it, expect } from "vitest";
import { HoldConfirm } from "./hold-confirm";
import { MAX_ANSWER_FINGERS } from "./constants";

const HOLD_MS = 800;

describe("U-G3 — steady hold emits exactly one latch", () => {
  it("progress 0 at t=0, partial before the boundary, no latch until 800", () => {
    const hc = new HoldConfirm(HOLD_MS);
    expect(hc.update(2, 0)).toEqual({ progress: 0 });
    const mid = hc.update(2, 799);
    expect(mid.progress).toBeCloseTo(799 / 800, 5);
    expect("latched" in mid).toBe(false);
  });

  it("latches at exactly 800ms", () => {
    const hc = new HoldConfirm(HOLD_MS);
    hc.update(2, 0);
    const res = hc.update(2, 800);
    expect(res.progress).toBe(1);
    expect(res.latched).toBe(2);
  });

  it("does NOT re-latch on subsequent same-finger updates (once per hold)", () => {
    const hc = new HoldConfirm(HOLD_MS);
    hc.update(2, 0);
    expect(hc.update(2, 800)).toEqual({ progress: 1, latched: 2 });
    expect(hc.update(2, 900)).toEqual({ progress: 1 }); // no latched key
    expect(hc.update(2, 5000)).toEqual({ progress: 1 });
  });

  it("holds different fingers independently until a change resets", () => {
    const hc = new HoldConfirm(HOLD_MS);
    hc.update(1, 0);
    expect(hc.update(1, 800)).toEqual({ progress: 1, latched: 1 });
    // A different finger while latched → full reset, fresh accumulator.
    expect(hc.update(3, 850)).toEqual({ progress: 0 });
    expect(hc.update(3, 1650)).toEqual({ progress: 1, latched: 3 });
  });
});

describe("U-G4 — finger change mid-hold resets the accumulator", () => {
  it("resets progress on a finger change, then a fresh hold latches", () => {
    const hc = new HoldConfirm(HOLD_MS);
    hc.update(2, 0);
    expect(hc.update(2, 400).progress).toBeCloseTo(0.5, 5);
    expect(hc.update(3, 450)).toEqual({ progress: 0 }); // change → reset
    expect(hc.update(3, 1250)).toEqual({ progress: 1, latched: 3 }); // fresh hold
  });
});

describe("U-G5 — hand lost mid-hold resets (fingers === 0)", () => {
  it("resets on 0 fingers and restarts from 0 on return", () => {
    const hc = new HoldConfirm(HOLD_MS);
    hc.update(2, 0);
    expect(hc.update(2, 400).progress).toBeCloseTo(0.5, 5);
    expect(hc.update(0, 500)).toEqual({ progress: 0 }); // lost hand → reset
    expect(hc.update(2, 600)).toEqual({ progress: 0 }); // returns → restarts
    expect(hc.update(2, 1400)).toEqual({ progress: 1, latched: 2 });
  });
});

describe("U-G2/U-G7 — out-of-range input resets; reset() releases the latch", () => {
  it("update with 6 (> MAX_ANSWER_FINGERS) fully resets, no latch", () => {
    const hc = new HoldConfirm(HOLD_MS);
    hc.update(2, 0);
    expect(hc.update(2, 800).latched).toBe(2);
    expect(hc.update(MAX_ANSWER_FINGERS + 1, 900)).toEqual({ progress: 0 });
    expect(hc.update(MAX_ANSWER_FINGERS + 1, 1700).latched).toBeUndefined();
  });

  it("update with a negative or non-integer finger resets", () => {
    const hc = new HoldConfirm(HOLD_MS);
    hc.update(2, 0);
    expect(hc.update(-1, 800)).toEqual({ progress: 0 });
    hc.update(2, 0);
    expect(hc.update(2.5, 800)).toEqual({ progress: 0 });
  });

  it("reset() releases the latch so a re-hold latches again (U-G7)", () => {
    const hc = new HoldConfirm(HOLD_MS);
    hc.update(2, 0);
    expect(hc.update(2, 800).latched).toBe(2);
    hc.reset();
    expect(hc.update(2, 900)).toEqual({ progress: 0 });
    expect(hc.update(2, 1700)).toEqual({ progress: 1, latched: 2 });
  });

  it("guards against a clock going backwards", () => {
    const hc = new HoldConfirm(HOLD_MS);
    hc.update(2, 1000);
    expect(hc.update(2, 500)).toEqual({ progress: 0 }); // restarts, no spurious latch
  });
});

describe("HoldConfirm constructor guards", () => {
  it("rejects non-positive or non-finite holdMs", () => {
    expect(() => new HoldConfirm(0)).toThrow();
    expect(() => new HoldConfirm(-1)).toThrow();
    expect(() => new HoldConfirm(Number.NaN)).toThrow();
    expect(() => new HoldConfirm(Number.POSITIVE_INFINITY)).toThrow();
  });
});
