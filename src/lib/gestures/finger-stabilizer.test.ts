import { describe, it, expect } from "vitest";
import { FingerStabilizer, FINGER_STABILIZER_RUN } from "./finger-stabilizer";

describe("FingerStabilizer — spike suppression & episode boundary hardening", () => {
  it("does not commit a non-zero count on the first present frame (suppresses entry spike)", () => {
    const s = new FingerStabilizer();
    expect(s.update(3, true)).toBe(0); // first frame does not commit non-zero count
    expect(s.update(3, true)).toBe(3); // second matching frame commits after FINGER_STABILIZER_RUN
  });

  it("suppresses a single-frame spike immediately following an absence episode", () => {
    const s = new FingerStabilizer();
    // Hand absent initially
    expect(s.update(0, false)).toBe(0);
    // Single-frame spike of 4 fingers
    expect(s.update(4, true)).toBe(0); // must NOT commit or emit 4
    // Hand gone again
    expect(s.update(0, false)).toBe(0);
    // Stable re-entry with 2 fingers
    expect(s.update(2, true)).toBe(0);
    expect(s.update(2, true)).toBe(2);
  });

  it("suppresses a single-frame spike between stable counts", () => {
    const s = new FingerStabilizer();
    s.update(3, true);
    s.update(3, true);
    expect(s.update(4, true)).toBe(3); // spike frame
    expect(s.update(3, true)).toBe(3);
  });

  it("switches after two consecutive differing frames", () => {
    const s = new FingerStabilizer();
    s.update(3, true);
    s.update(3, true);
    expect(s.update(4, true)).toBe(3);
    expect(s.update(4, true)).toBe(4); // run complete
  });

  it("never switches on alternating flicker", () => {
    const s = new FingerStabilizer();
    s.update(3, true);
    s.update(3, true);
    for (let i = 0; i < 10; i++) {
      expect(s.update(i % 2 === 0 ? 4 : 5, true)).toBe(3);
    }
  });

  it("passes absence through raw and requires stable run before committing on re-entry", () => {
    const s = new FingerStabilizer();
    s.update(3, true);
    s.update(3, true);
    expect(s.update(3, false)).toBe(0);
    expect(s.update(4, true)).toBe(0); // single frame does not commit 4
    expect(s.update(4, true)).toBe(4); // second frame commits 4
  });

  it("debounces counts after a fist frame (0 is a real committed count)", () => {
    const s = new FingerStabilizer();
    expect(s.update(0, true)).toBe(0); // fist seeds 0 immediately
    expect(s.update(3, true)).toBe(0); // differs — debounce holds
    expect(s.update(3, true)).toBe(3);
  });

  it("reset clears state and suppresses post-reset entry spike", () => {
    const s = new FingerStabilizer();
    s.update(3, true);
    s.update(3, true);
    s.reset();
    expect(s.update(2, true)).toBe(0); // entry frame suppressed
    expect(s.update(2, true)).toBe(2); // confirmed after run
  });

  it("sanitizes non-finite, negative, non-integer, or out-of-range (>5) fingerCount safely", () => {
    const s = new FingerStabilizer();
    expect(s.update(Number.NaN, true)).toBe(0);
    expect(s.update(-1, true)).toBe(0);
    expect(s.update(Number.POSITIVE_INFINITY, true)).toBe(0);
    expect(s.update(2.5, true)).toBe(0);
    expect(s.update(6, true)).toBe(0);
    expect(s.update(10, true)).toBe(0);
    // After invalid values, valid count can commit normally
    expect(s.update(3, true)).toBe(0);
    expect(s.update(3, true)).toBe(3);
  });

  it("exports the required run length", () => {
    expect(FINGER_STABILIZER_RUN).toBe(2);
  });
});
