import { describe, it, expect } from "vitest";
import { FingerStabilizer, FINGER_STABILIZER_RUN } from "./finger-stabilizer";

describe("FingerStabilizer — single-frame spike suppression", () => {
  it("seeds the first present frame immediately", () => {
    const s = new FingerStabilizer();
    expect(s.update(3, true)).toBe(3);
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
    for (let i = 0; i < 10; i++) {
      expect(s.update(i % 2 === 0 ? 4 : 5, true)).toBe(3);
    }
  });

  it("passes absence through raw and re-seeds on re-entry", () => {
    const s = new FingerStabilizer();
    s.update(3, true);
    s.update(3, true);
    expect(s.update(3, false)).toBe(0);
    expect(s.update(4, true)).toBe(4); // fresh seed, no stale 3
  });

  it("debounces counts after a fist frame (0 is a real committed count)", () => {
    const s = new FingerStabilizer();
    expect(s.update(0, true)).toBe(0); // fist seeds
    expect(s.update(3, true)).toBe(0); // differs — debounce holds
    expect(s.update(3, true)).toBe(3);
  });

  it("reset clears state", () => {
    const s = new FingerStabilizer();
    s.update(3, true);
    s.reset();
    expect(s.update(2, true)).toBe(2);
  });

  it("exports the required run length", () => {
    expect(FINGER_STABILIZER_RUN).toBe(2);
  });
});
