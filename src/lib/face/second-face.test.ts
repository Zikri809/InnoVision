import { describe, it, expect } from "vitest";
import { EMBEDDING_DIMS, DETECTION_SCORE_MIN, type InsightFaceFace } from "./embedding";
import {
  SECOND_FACE_AREA_RATIO_MIN,
  SECOND_FACE_CENTER_DISPLACEMENT_FACTOR,
  SECOND_FACE_MIN_FRAMES,
  countSecondFaceFrames,
  frameHasSecondFace,
  shouldReportSecondFace,
} from "./second-face";

function unitAt(index: number): number[] {
  const v = new Array(EMBEDDING_DIMS).fill(0);
  v[index % EMBEDDING_DIMS] = 1;
  return v;
}

function face(overrides: Partial<InsightFaceFace> = {}): InsightFaceFace {
  return {
    embedding: unitAt(0),
    yaw: 0,
    pitch: 0,
    roll: 0,
    det_score: 0.9,
    bbox: [100, 100, 300, 300], // 200×200 centered-ish subject
    ...overrides,
  };
}

describe("frameHasSecondFace", () => {
  it("false for a single face", () => {
    expect(frameHasSecondFace([face()])).toBe(false);
  });

  it("false for an empty frame or a frame with no qualifying primary", () => {
    expect(frameHasSecondFace([])).toBe(false);
    expect(frameHasSecondFace([face({ det_score: DETECTION_SCORE_MIN - 0.01 })])).toBe(false);
  });

  it("true for a large, distinct, real second face", () => {
    // Primary 200×200 at (100,100); second face same size, one span to the right.
    const second = face({ embedding: unitAt(1), bbox: [320, 100, 520, 300] });
    expect(frameHasSecondFace([face(), second])).toBe(true);
  });

  it("false when the extra face is below the det_score floor (weak detection)", () => {
    const second = face({ embedding: unitAt(1), bbox: [320, 100, 520, 300], det_score: 0.3 });
    expect(frameHasSecondFace([face(), second])).toBe(false);
  });

  it("false when the extra face is a small reflection (area < 15% of primary)", () => {
    const sliver = face({ embedding: unitAt(1), bbox: [340, 140, 385, 185] }); // 45×45 = ~5%
    expect(frameHasSecondFace([face(), sliver])).toBe(false);
  });

  it("true exactly at the area-ratio boundary (≥, not >)", () => {
    // 200×200 primary → boundary area = 0.15 * 40000 = 6000 → 100×60 box,
    // placed far enough that the center displacement ALSO clears one span.
    const boundary = face({ embedding: unitAt(1), bbox: [400, 100, 500, 160] });
    expect(100 * 60).toBeGreaterThanOrEqual(40000 * SECOND_FACE_AREA_RATIO_MIN);
    expect(frameHasSecondFace([face(), boundary])).toBe(true);
  });

  it("false when the extra face overlaps the primary (ghost/split detection, no displacement)", () => {
    // Same center as the primary, ≥15% area — a split-detection ghost.
    const ghost = face({ embedding: unitAt(1), bbox: [110, 110, 250, 250] });
    expect(frameHasSecondFace([face(), ghost])).toBe(false);
  });

  it("displacement gate is one primary-span (largest bbox dimension), not center-to-center luck", () => {
    // Span = 200. Center distance exactly 200 → qualifies (≥).
    const touching = face({ embedding: unitAt(1), bbox: [300, 100, 500, 300] });
    expect(SECOND_FACE_CENTER_DISPLACEMENT_FACTOR).toBe(1.0);
    expect(frameHasSecondFace([face(), touching])).toBe(true);
    // Center distance 190 < 200 → does not.
    const close = face({ embedding: unitAt(1), bbox: [290, 100, 490, 300] });
    expect(frameHasSecondFace([face(), close])).toBe(false);
  });

  it("primary selection is respected: the LARGER face is the subject — a dominating intruder makes the smaller face the 'extra'", () => {
    // Faces listed detector-order (small first) — primary must still be the
    // big one. NOTE the deliberate asymmetry: a 100×100 face (25% of the
    // 400×360 primary's area) qualifies as an extra even though a same-role
    // 45×45 sliver would not — the AREA gate compares the extra against the
    // primary, and here the roles flipped.
    const smallFace = face({ embedding: unitAt(1), bbox: [0, 160, 180, 340] }); // 180×180
    const bigOther = face({ embedding: unitAt(2), bbox: [250, 60, 550, 320] }); // 300×260 — dominant
    expect(frameHasSecondFace([smallFace, bigOther])).toBe(true);
    // ...and when the small face is TOO small relative to the dominant one
    // (a poster in a wide shot), no advisory — but the verify itself then
    // fails 1:1 against the intruder, which is the stronger signal.
    const tinyFace = face({ embedding: unitAt(1), bbox: [0, 160, 80, 240] }); // 80×80 ≈ 8% of the primary
    expect(frameHasSecondFace([tinyFace, bigOther])).toBe(false);
  });
});

describe("shouldReportSecondFace (2-of-N frames)", () => {
  it("needs at least SECOND_FACE_MIN_FRAMES qualifying frames", () => {
    expect(SECOND_FACE_MIN_FRAMES).toBe(2);
    const withSecond = [face(), face({ embedding: unitAt(1), bbox: [320, 100, 520, 300] })];
    const solo = [face()];
    expect(shouldReportSecondFace([withSecond, solo, solo])).toBe(false);
    expect(shouldReportSecondFace([withSecond, withSecond, solo])).toBe(true);
    expect(shouldReportSecondFace([withSecond, withSecond, withSecond])).toBe(true);
  });

  it("counts frames, not faces: two extras in ONE frame still cannot report alone", () => {
    const crowded = [
      face(),
      face({ embedding: unitAt(1), bbox: [320, 100, 520, 300] }),
      face({ embedding: unitAt(2), bbox: [0, 0, 90, 90] }),
    ];
    expect(countSecondFaceFrames([crowded])).toBe(1);
    expect(shouldReportSecondFace([crowded])).toBe(false);
  });
});
