import { describe, it, expect } from "vitest";
import {
  EMBEDDING_DIMS,
  DETECTION_SCORE_MIN,
  cosineSimilarity,
  l2Normalize,
  selectPrimaryFace,
  type InsightFaceFace,
} from "./embedding";

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
    bbox: [100, 100, 300, 300],
    ...overrides,
  };
}

describe("cosineSimilarity", () => {
  it("identical unit vectors → 1", () => {
    const v = unitAt(3);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 9);
  });

  it("orthogonal unit vectors → 0", () => {
    expect(cosineSimilarity(unitAt(0), unitAt(1))).toBeCloseTo(0, 9);
  });

  it("opposite vectors → -1", () => {
    const v = unitAt(2);
    expect(cosineSimilarity(v, v.map((x) => -x))).toBeCloseTo(-1, 9);
  });

  it("zero-norm input → 0 (NaN guard, mirrors the SQL RPC)", () => {
    expect(cosineSimilarity(new Array(EMBEDDING_DIMS).fill(0), unitAt(0))).toBe(0);
  });

  it("unnormalized inputs are cosine, not raw dot", () => {
    const a = unitAt(0).map((x) => x * 5);
    const b = unitAt(0).map((x) => x * 0.2);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 9);
  });
});

describe("l2Normalize", () => {
  it("scales to unit norm", () => {
    const v = l2Normalize([3, 4, ...new Array(EMBEDDING_DIMS - 2).fill(0)]);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 9);
  });

  it("zero vector stays zero (no NaN)", () => {
    expect(l2Normalize(new Array(EMBEDDING_DIMS).fill(0))).toEqual(new Array(EMBEDDING_DIMS).fill(0));
  });
});

describe("selectPrimaryFace", () => {
  it("null when there are no faces", () => {
    expect(selectPrimaryFace([])).toBeNull();
  });

  it("null when every face is below the det_score floor", () => {
    expect(selectPrimaryFace([face({ det_score: DETECTION_SCORE_MIN - 0.01 })])).toBeNull();
  });

  it("picks the largest-bbox face", () => {
    const small = face({ embedding: unitAt(1), bbox: [200, 200, 300, 300] });
    const large = face({ embedding: unitAt(2), bbox: [0, 0, 640, 480] });
    expect(selectPrimaryFace([small, large])?.embedding).toEqual(unitAt(2));
  });

  it("total order: equal areas resolve by center distance to frame center", () => {
    // Same-size boxes: one centered, one in the corner.
    const centered = face({ embedding: unitAt(1), bbox: [220, 165, 420, 315] });
    const corner = face({ embedding: unitAt(2), bbox: [0, 0, 200, 150] });
    expect(selectPrimaryFace([corner, centered])?.embedding).toEqual(unitAt(1));
  });

  it("is deterministic for the same input (same frame → same face)", () => {
    const faces = [
      face({ embedding: unitAt(5), bbox: [0, 0, 100, 400] }),
      face({ embedding: unitAt(6), bbox: [50, 0, 160, 400] }),
      face({ embedding: unitAt(7), bbox: [10, 10, 620, 470] }),
    ];
    const first = selectPrimaryFace(faces);
    for (let i = 0; i < 5; i++) {
      expect(selectPrimaryFace([...faces].reverse())).toEqual(first);
    }
  });

  it("ignores faces below the floor but keeps qualifying ones", () => {
    const weak = face({ embedding: unitAt(1), bbox: [0, 0, 640, 480], det_score: 0.2 });
    const strong = face({ embedding: unitAt(2), bbox: [10, 10, 200, 200], det_score: 0.8 });
    expect(selectPrimaryFace([weak, strong])?.embedding).toEqual(unitAt(2));
  });
});
