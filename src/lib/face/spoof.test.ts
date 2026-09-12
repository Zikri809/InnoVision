import { describe, it, expect } from "vitest";
import { spoofGateDecision, FACE_SPOOF_MAJORITY_REAL_SCORE } from "./spoof";

/**
 * audit-2 C-01 — the photo/replay gate decision rule. The verify route
 * forces a FAIL vote iff `forcedFail`; every branch here is the documented
 * contract (spoof.ts header).
 */
describe("spoofGateDecision", () => {
  it("passes when every verdict is real", () => {
    const d = spoofGateDecision([{ real: true, score: 0.98 }, { real: true, score: 0.9 }]);
    expect(d).toMatchObject({ fakeCount: 0, realCount: 2, unknownCount: 0, forcedFail: false });
  });

  it("forces a FAIL when the spoofed frames are the majority", () => {
    const d = spoofGateDecision([
      { real: false, score: 0.02 },
      { real: false, score: 0.1 },
      { real: true, score: 0.97 },
    ]);
    expect(d).toMatchObject({ fakeCount: 2, realCount: 1, forcedFail: true });
  });

  it("forces a FAIL on a single spoofed frame (1-frame honest poll path included)", () => {
    const d = spoofGateDecision([{ real: false, score: 0.03 }]);
    expect(d).toMatchObject({ fakeCount: 1, realCount: 0, forcedFail: true });
  });

  it("does NOT fail when fakes are a minority (one mis-classified frame under bad lighting)", () => {
    const d = spoofGateDecision([
      { real: false, score: 0.4 },
      { real: true, score: 0.93 },
      { real: true, score: 0.88 },
    ]);
    expect(d).toMatchObject({ fakeCount: 1, realCount: 2, forcedFail: false });
  });

  it("treats missing/unknown verdicts as inert (old sidecar, weights absent, no face)", () => {
    const d = spoofGateDecision([null, undefined, { real: true, score: 0.99 }]);
    expect(d).toMatchObject({ fakeCount: 0, realCount: 1, unknownCount: 2, forcedFail: false });
  });

  it("never fails on unknown-only verdict sets (pre-C-01 sidecar degrades to record-only)", () => {
    const d = spoofGateDecision([null, undefined]);
    expect(d.forcedFail).toBe(false);
    expect(d.unknownCount).toBe(2);
  });

  it("rejects non-finite scores as unknown, not fake", () => {
    const d = spoofGateDecision([{ real: false, score: Number.NaN } as never]);
    expect(d).toMatchObject({ unknownCount: 1, forcedFail: false });
  });

  it("mirrors the model argmax boundary at 0.5", () => {
    expect(FACE_SPOOF_MAJORITY_REAL_SCORE).toBe(0.5);
    const d = spoofGateDecision([{ real: false, score: 0.5 }]);
    // 0.5 exactly = real side of the boundary (>= comparison).
    expect(d).toMatchObject({ realCount: 1, fakeCount: 0, forcedFail: false });
  });
});
