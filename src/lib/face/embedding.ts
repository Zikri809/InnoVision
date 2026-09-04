/**
 * Pure embedding math for the InsightFace pipeline (no `process.env`, no I/O,
 * no Node built-ins — import-safe from any bundle).
 *
 * Lives OUTSIDE the server-only client so route code, the fake-Supabase test
 * harness, and unit tests share ONE implementation of the vector math the
 * SQL RPCs model (cosine similarity = dot product over L2-normalized
 * embeddings — ArcFace embeddings are unit-normalized by the sidecar).
 */

/** Dimension of ArcFace `buffalo_l` (w600k_r50) embeddings. */
export const EMBEDDING_DIMS = 512;

/**
 * Detection-score floor for picking the primary face in a multi-face frame.
 * SCRFD `det_score` runs ~0-1; 0.6 keeps legitimate webcam faces while
 * dropping weak detections. NOT integrity-critical: a face below the floor
 * yields a 0-vote (a FAIL), never a pass.
 */
export const DETECTION_SCORE_MIN = 0.6;

/** One detected face from the sidecar's `/extract` response. */
export type InsightFaceFace = {
  embedding: number[];
  yaw: number;
  pitch: number;
  roll: number;
  det_score: number;
  bbox: [number, number, number, number];
};

/** L2-normalize; a zero vector returns all zeros. */
export function l2Normalize(v: number[]): number[] {
  let sq = 0;
  for (const x of v) sq += x * x;
  if (sq === 0) return v.map(() => 0);
  const norm = Math.sqrt(sq);
  return v.map((x) => x / norm);
}

/**
 * Cosine similarity of two vectors. For unit vectors this is the plain dot
 * product. Zero-norm input → 0 (mirrors the SQL RPC's NaN guard).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Pick the ONE face a frame's similarity is computed from.
 *
 * Multi-face frames (student + passer-by) must resolve to a single
 * deterministic embedding: taking the MAX over faces would let a second
 * person's face drag the score UP past the verify gate (the exact
 * upward-contamination the CompreFace 1:1-by-lookup design engineered away),
 * while faces[0] is detector-order and nondeterministic in practice.
 *
 * Rule (total order → same frame always picks the same face):
 *   1. det_score ≥ DETECTION_SCORE_MIN
 *   2. largest bbox area
 *   3. bbox center nearest the frame center
 *   4. original index (closes measure-zero float ties)
 * No qualifying face → null → the frame votes 0 (a FAIL, integrity-safe).
 */
export function selectPrimaryFace(
  faces: InsightFaceFace[],
  frameWidth = 640,
  frameHeight = 480,
): InsightFaceFace | null {
  let best: InsightFaceFace | null = null;
  let bestArea = -1;
  let bestCenterDist = Infinity;
  let bestIndex = -1;
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    if (f.det_score < DETECTION_SCORE_MIN) continue;
    const [x1, y1, x2, y2] = f.bbox;
    const area = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const centerDist = (cx - frameWidth / 2) ** 2 + (cy - frameHeight / 2) ** 2;
    if (
      area > bestArea ||
      (area === bestArea &&
        (centerDist < bestCenterDist ||
          (centerDist === bestCenterDist && bestIndex !== -1 && i < bestIndex)))
    ) {
      best = f;
      bestArea = area;
      bestCenterDist = centerDist;
      bestIndex = i;
    }
  }
  return best;
}
