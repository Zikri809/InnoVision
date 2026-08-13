import { describe, it, expect } from "vitest";
import {
  countExtendedFingers,
  isFingerExtended,
  isThumbExtended,
  landmarksToHandFrame,
  mapFingersToOption,
} from "./finger-count";
import type { Landmark } from "./types";

/**
 * Build a synthetic 21-point landmark array. Fingers whose `extended` flag is
 * true get `tip.y = 0.3` (raised) vs `pip.y = 0.5` (base); folded get
 * `tip.y = 0.6`. The thumb is driven by x: `thumbRight` uses the "Right"
 * handedness heuristic (tip.x < mcp.x), `thumbLeft` the "Left" one.
 */
function buildLandmarks(opts: {
  index?: boolean;
  middle?: boolean;
  ring?: boolean;
  pinky?: boolean;
  thumbRight?: boolean;
  thumbLeft?: boolean;
}): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const tips = [8, 12, 16, 20];
  const pips = [6, 10, 14, 18];
  const flags = [opts.index, opts.middle, opts.ring, opts.pinky];
  for (let i = 0; i < 4; i++) {
    lm[tips[i]] = { x: 0.5, y: flags[i] ? 0.3 : 0.6, z: 0 };
    lm[pips[i]] = { x: 0.5, y: 0.5, z: 0 };
  }
  // Thumb: MCP at x=0.5; tip to the left for "Right" heuristic, right for "Left".
  lm[3] = { x: 0.5, y: 0.5, z: 0 };
  if (opts.thumbRight) lm[4] = { x: 0.4, y: 0.5, z: 0 }; // tip.x < mcp.x
  else if (opts.thumbLeft) lm[4] = { x: 0.6, y: 0.5, z: 0 }; // tip.x > mcp.x
  else lm[4] = { x: 0.5, y: 0.5, z: 0 };
  return lm;
}

describe("U-G1 — countExtendedFingers counts 1..5 (incl. thumb + handedness)", () => {
  it("counts 0 for a fist", () => {
    expect(countExtendedFingers(buildLandmarks({}), "Right")).toBe(0);
  });

  it("counts 1 for index only", () => {
    expect(countExtendedFingers(buildLandmarks({ index: true }), "Right")).toBe(1);
  });

  it("counts 2 for index + middle", () => {
    expect(countExtendedFingers(buildLandmarks({ index: true, middle: true }), "Right")).toBe(2);
  });

  it("counts 3 for index + middle + ring", () => {
    expect(
      countExtendedFingers(buildLandmarks({ index: true, middle: true, ring: true }), "Right"),
    ).toBe(3);
  });

  it("counts 4 for index..pinky", () => {
    expect(
      countExtendedFingers(
        buildLandmarks({ index: true, middle: true, ring: true, pinky: true }),
        "Right",
      ),
    ).toBe(4);
  });

  it("counts 5 including a Right-hand thumb (tip.x < mcp.x)", () => {
    expect(
      countExtendedFingers(
        buildLandmarks({ index: true, middle: true, ring: true, pinky: true, thumbRight: true }),
        "Right",
      ),
    ).toBe(5);
  });

  it("counts 5 including a Left-hand thumb (tip.x > mcp.x)", () => {
    expect(
      countExtendedFingers(
        buildLandmarks({ index: true, middle: true, ring: true, pinky: true, thumbLeft: true }),
        "Left",
      ),
    ).toBe(5);
  });

  it("does NOT count the thumb when handedness is absent (conservative)", () => {
    expect(
      countExtendedFingers(
        buildLandmarks({ index: true, middle: true, ring: true, pinky: true, thumbRight: true }),
        undefined,
      ),
    ).toBe(4);
  });

  it("does NOT count a thumb with the wrong-handedness x relation", () => {
    // "Right" heuristic expects tip.x < mcp.x; a right-leaning thumb fails it.
    expect(
      countExtendedFingers(buildLandmarks({ thumbLeft: true }), "Right"),
    ).toBe(0);
    // "Left" heuristic expects tip.x > mcp.x; a left-leaning thumb fails it.
    expect(
      countExtendedFingers(buildLandmarks({ thumbRight: true }), "Left"),
    ).toBe(0);
  });

  it("guards missing landmark indices (does not throw)", () => {
    expect(countExtendedFingers([], "Right")).toBe(0);
    expect(countExtendedFingers([{ x: 0, y: 0, z: 0 }], "Right")).toBe(0);
  });
});

describe("isFingerExtended / isThumbExtended guards", () => {
  it("returns false for missing landmarks", () => {
    expect(isFingerExtended([], 8, 6)).toBe(false);
    expect(isThumbExtended([], "Right")).toBe(false);
    expect(isThumbExtended([{ x: 0, y: 0, z: 0 }], undefined)).toBe(false);
  });
});

describe("U-G2 — mapFingersToOption clamps 0 and >optionCount", () => {
  it("returns null for 0 and >5 fingers", () => {
    expect(mapFingersToOption(0, 4)).toBeNull();
    expect(mapFingersToOption(6, 5)).toBeNull();
  });

  it("full corner table", () => {
    expect(mapFingersToOption(0, 5)).toBeNull();
    expect(mapFingersToOption(1, 1)).toBe(0);
    expect(mapFingersToOption(4, 4)).toBe(3);
    expect(mapFingersToOption(5, 5)).toBe(4);
    expect(mapFingersToOption(5, 3)).toBeNull(); // > option count
    expect(mapFingersToOption(6, 5)).toBeNull();
    expect(mapFingersToOption(4, 2)).toBeNull(); // 4 fingers on a true/false
    expect(mapFingersToOption(3, 3)).toBe(2);
    expect(mapFingersToOption(2, 4)).toBe(1);
  });

  it("returns null for a non-positive option count", () => {
    expect(mapFingersToOption(1, 0)).toBeNull();
    expect(mapFingersToOption(1, -1)).toBeNull();
  });

  it("returns null for a non-integer finger count (clamp is the single authority)", () => {
    expect(mapFingersToOption(2.5, 4)).toBeNull();
    expect(mapFingersToOption(Number.NaN, 4)).toBeNull();
  });
});

describe("landmarksToHandFrame — MediaPipe result → HandFrame (pure, testable)", () => {
  it("returns handPresent:false when landmarks are absent or < 21 points", () => {
    expect(landmarksToHandFrame({})).toEqual({ handPresent: false, fingerCount: 0 });
    expect(
      landmarksToHandFrame({ landmarks: [buildLandmarks({ index: true }).slice(0, 5)] }),
    ).toEqual({ handPresent: false, fingerCount: 0 });
  });

  it("counts extended fingers and normalizes handedness", () => {
    const lm = buildLandmarks({ index: true, middle: true, thumbRight: true });
    const frame = landmarksToHandFrame({
      landmarks: [lm],
      handedness: [[{ categoryName: "Right" }]],
    });
    expect(frame).toEqual({ handPresent: true, fingerCount: 3, handedness: "Right" });
  });

  it("normalizes unknown handedness to undefined", () => {
    const frame = landmarksToHandFrame({
      landmarks: [buildLandmarks({})],
      handedness: [[{ categoryName: "Scissors" }]],
    });
    expect(frame.handPresent).toBe(true);
    expect(frame.handedness).toBeUndefined();
  });

  it("handles missing handedness arrays", () => {
    const frame = landmarksToHandFrame({ landmarks: [buildLandmarks({ index: true })] });
    expect(frame.handPresent).toBe(true);
    expect(frame.fingerCount).toBe(1);
    expect(frame.handedness).toBeUndefined();
  });
});
