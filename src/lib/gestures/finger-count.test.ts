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
 * Build a synthetic 21-point landmark array (upright hand). Fingers whose
 * `extended` flag is true get `tip.y = 0.3` (raised) vs `pip.y = 0.5` (base);
 * folded get `tip.y = 0.6` (curled toward the wrist at y = 0.7). The wrist is
 * NON-degenerate (distinct from the PIPs) — the wrist-distance extension test
 * needs a real wrist→PIP baseline. The thumb is driven by x: `thumbRight` uses
 * the "Right" handedness heuristic (tip.x < mcp.x), `thumbLeft` the "Left" one.
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
  lm[0] = { x: 0.5, y: 0.7, z: 0 }; // wrist — below the PIPs
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

describe("tilted-hand regression — folded finger must not read as extended (3→4 misfire)", () => {
  /**
   * A hand tilted ~53° (pointing up-right along (0.6, -0.8)): index, middle,
   * and ring extended along the axis; the pinky FOLDED (tip curled toward the
   * palm) yet its tip is HIGHER ON SCREEN than its PIP — exactly the pose
   * where the old `tip.y < pip.y` check counted a folded finger and reported
   * 4 instead of 3. All points are rotated together; the wrist-distance test
   * must reject the folded pinky at any tilt.
   */
  function buildTiltedHand(): Landmark[] {
    const lm: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    lm[0] = { x: 0.3, y: 0.7, z: 0 }; // wrist
    // Shared knuckle/PIP positions on the hand axis (wrist + t·(0.6, -0.8)).
    const mcps = [5, 9, 13, 17];
    const pips = [6, 10, 14, 18];
    for (const i of mcps) lm[i] = { x: 0.36, y: 0.62, z: 0 }; // wrist + 0.10u
    for (const i of pips) lm[i] = { x: 0.42, y: 0.54, z: 0 }; // wrist + 0.20u
    // Extended tips (index 8, middle 12, ring 16): wrist + ~0.35u.
    lm[8] = { x: 0.51, y: 0.42, z: 0 };
    lm[12] = { x: 0.51, y: 0.42, z: 0 };
    lm[16] = { x: 0.51, y: 0.42, z: 0 };
    // Folded pinky tip: curled toward the palm but ABOVE its PIP on screen
    // (y 0.50 < pip 0.54) — the old screen-y check counted it.
    lm[20] = { x: 0.38, y: 0.5, z: 0 };
    // Folded thumb (tip right of the IP joint → fails the "Right" heuristic).
    lm[3] = { x: 0.36, y: 0.62, z: 0 };
    lm[4] = { x: 0.45, y: 0.6, z: 0 };
    return lm;
  }

  it("counts exactly 3 on a tilted hand (old logic would count 4)", () => {
    expect(countExtendedFingers(buildTiltedHand(), "Right")).toBe(3);
  });

  it("still counts 3 without handedness (thumb conservative)", () => {
    expect(countExtendedFingers(buildTiltedHand(), undefined)).toBe(3);
  });

  it("extension test is rotation-invariant: extended fingers pass at any tilt", () => {
    const lm = buildTiltedHand();
    // Index extended along the tilted axis: tip distance from the wrist
    // (0.35) far exceeds the PIP baseline (0.20) — no screen-y involved.
    expect(isFingerExtended(lm, 8, 6, 5)).toBe(true);
    expect(isFingerExtended(lm, 12, 10, 9)).toBe(true);
    expect(isFingerExtended(lm, 16, 14, 13)).toBe(true);
    expect(isFingerExtended(lm, 20, 18, 17)).toBe(false);
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
