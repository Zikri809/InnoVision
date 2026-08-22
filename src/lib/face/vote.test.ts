import { describe, it, expect } from "vitest";
import { evaluateFrameVotes } from "./vote";

/**
 * Vote-matrix pins for the multi-frame verify (mirror of record_face_check
 * v3 SQL — migration 0020). Strict majority over SUBMITTED frames.
 */
describe("evaluateFrameVotes (2-of-3 majority mirror)", () => {
  it("single frame behaves like the legacy single-shot check", () => {
    expect(evaluateFrameVotes([0.9]).matched).toBe(true);
    expect(evaluateFrameVotes([0.49]).matched).toBe(false);
  });

  it("exactly-at-threshold votes count as hits", () => {
    expect(evaluateFrameVotes([0.5, 0.5, 0.1]).matched).toBe(true);
    expect(evaluateFrameVotes([0.49, 0.5, 0.5]).matched).toBe(true);
  });

  it("2-of-3 passes even when one frame clearly failed", () => {
    const r = evaluateFrameVotes([0.95, 0.1, 0.6]);
    expect(r.matched).toBe(true);
    // Distance reflects the BEST frame.
    expect(r.distance).toBeCloseTo(0.05, 5);
  });

  it("1-of-3 never passes", () => {
    expect(evaluateFrameVotes([0.1, 0.9, 0.1]).matched).toBe(false);
  });

  it("2-frame submissions require BOTH", () => {
    expect(evaluateFrameVotes([0.9, 0.6]).matched).toBe(true);
    expect(evaluateFrameVotes([0.9, 0.1]).matched).toBe(false);
  });

  it("null entries are FAIL votes, never silently forgiven", () => {
    expect(evaluateFrameVotes([null, 0.9, 0.9]).matched).toBe(true);
    expect(evaluateFrameVotes([null, null, 0.9]).matched).toBe(false);
  });

  it("empty / all-null input → fail with null distance", () => {
    expect(evaluateFrameVotes([])).toEqual({ matched: false, distance: null });
    expect(evaluateFrameVotes([null, null])).toEqual({ matched: false, distance: null });
  });

  it("NaN similarities are treated as missing (fail vote)", () => {
    expect(evaluateFrameVotes([NaN, 0.9]).matched).toBe(false);
  });
});
