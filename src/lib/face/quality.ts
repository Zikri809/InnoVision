/**
 * Pure photometric luminance and ROI geometry utilities for face & hand tracking.
 *
 * All functions are pure, node-safe, and deterministic so they can be unit-tested
 * extensively against all edge cases.
 */

export const IDEAL_LIGHTING_MIN = 80;
export const IDEAL_LIGHTING_MAX = 195;
export const GENERAL_LIGHTING_MIN = 65;
export const GENERAL_LIGHTING_MAX = 215;

/** Standard ITU-R BT.601 perceived photometric luminance. */
export function calculatePhotometricLuminance(r: number, g: number, b: number): number {
  const safeR = Number.isFinite(r) ? Math.max(0, Math.min(255, r)) : 0;
  const safeG = Number.isFinite(g) ? Math.max(0, Math.min(255, g)) : 0;
  const safeB = Number.isFinite(b) ? Math.max(0, Math.min(255, b)) : 0;
  return 0.299 * safeR + 0.587 * safeG + 0.114 * safeB;
}

/** Classify luminance into good, too_dark, or too_bright. */
export function classifyLighting(
  luminance: number,
  mode: "general" | "ideal" = "general",
): "good" | "too_dark" | "too_bright" {
  if (!Number.isFinite(luminance)) return "good";
  const min = mode === "ideal" ? IDEAL_LIGHTING_MIN : GENERAL_LIGHTING_MIN;
  const max = mode === "ideal" ? IDEAL_LIGHTING_MAX : GENERAL_LIGHTING_MAX;

  if (luminance < min) return "too_dark";
  if (luminance > max) return "too_bright";
  return "good";
}

export type Point = { x: number; y: number; z?: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** Extract face skin region of interest (ROI) from key T-zone & cheek landmarks. */
export function getFacialSkinRegion(
  w: number,
  h: number,
  landmarks?: Point[] | null,
): Rect {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  // Fallback centered box if landmarks are missing
  let fx = Math.round(0.3 * w);
  let fy = Math.round(0.25 * h);
  let fw = Math.round(0.4 * w);
  let fh = Math.round(0.5 * h);

  if (landmarks && Array.isArray(landmarks) && landmarks.length > 0) {
    let minX = 1;
    let maxX = 0;
    let minY = 1;
    let maxY = 0;
    let found = 0;

    // Landmarks: 1 (nose), 10 (forehead), 152 (chin), 234 (left cheek), 454 (right cheek), 168 (between eyes)
    const sampleIndices = [1, 10, 152, 234, 454, 168, 6, 197, 195, 5, 4, 19, 94, 2];
    for (const idx of sampleIndices) {
      const lm = landmarks[idx];
      if (lm && Number.isFinite(lm.x) && Number.isFinite(lm.y)) {
        if (lm.x < minX) minX = lm.x;
        if (lm.x > maxX) maxX = lm.x;
        if (lm.y < minY) minY = lm.y;
        if (lm.y > maxY) maxY = lm.y;
        found++;
      }
    }

    if (found >= 3 && maxX > minX && maxY > minY) {
      // 15% inner padding to isolate pure skin
      const padX = (maxX - minX) * 0.15;
      const padY = (maxY - minY) * 0.15;
      const rawX = (minX + padX) * w;
      const rawY = (minY + padY) * h;
      const rawW = (maxX - minX - 2 * padX) * w;
      const rawH = (maxY - minY - 2 * padY) * h;

      fx = Math.max(0, Math.min(w - 1, Math.round(rawX)));
      fy = Math.max(0, Math.min(h - 1, Math.round(rawY)));
      fw = Math.max(1, Math.min(w - fx, Math.round(rawW)));
      fh = Math.max(1, Math.min(h - fy, Math.round(rawH)));
    }
  }

  return { x: fx, y: fy, width: fw, height: fh };
}

/** Extract palm region of interest (ROI) from hand landmarks. */
export function getHandPalmRegion(
  w: number,
  h: number,
  landmarks?: Point[] | null,
): Rect {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let hx = Math.round(0.3 * w);
  let hy = Math.round(0.3 * h);
  let hw = Math.round(0.4 * w);
  let hh = Math.round(0.4 * h);

  if (landmarks && Array.isArray(landmarks) && landmarks.length > 0) {
    let minX = 1;
    let maxX = 0;
    let minY = 1;
    let maxY = 0;
    let found = 0;

    // Palm and finger base landmarks: 0 (wrist), 1 (thumb cmc), 2 (thumb mcp), 5 (index mcp), 9 (middle mcp), 13 (ring mcp), 17 (pinky mcp)
    const palmIndices = [0, 1, 2, 5, 9, 13, 17];
    for (const idx of palmIndices) {
      const lm = landmarks[idx];
      if (lm && Number.isFinite(lm.x) && Number.isFinite(lm.y)) {
        if (lm.x < minX) minX = lm.x;
        if (lm.x > maxX) maxX = lm.x;
        if (lm.y < minY) minY = lm.y;
        if (lm.y > maxY) maxY = lm.y;
        found++;
      }
    }

    if (found >= 3 && maxX > minX && maxY > minY) {
      const padX = (maxX - minX) * 0.1;
      const padY = (maxY - minY) * 0.1;
      const rawX = (minX + padX) * w;
      const rawY = (minY + padY) * h;
      const rawW = (maxX - minX - 2 * padX) * w;
      const rawH = (maxY - minY - 2 * padY) * h;

      hx = Math.max(0, Math.min(w - 1, Math.round(rawX)));
      hy = Math.max(0, Math.min(h - 1, Math.round(rawY)));
      hw = Math.max(1, Math.min(w - hx, Math.round(rawW)));
      hh = Math.max(1, Math.min(h - hy, Math.round(rawH)));
    }
  }

  return { x: hx, y: hy, width: hw, height: hh };
}

/** Compute frame score based on geometrical alignment, eye liveness, and lighting. */
export function scoreFrameQuality(params: {
  faceDetected: boolean;
  centered: boolean;
  yaw: number;
  eyesOpen: boolean;
  lightingOk: boolean;
  allowTurned?: boolean;
}): number {
  let score = 0;
  if (params.faceDetected) score += 30;
  if (params.centered) score += 25;
  if (params.faceDetected) {
    const absYaw = Math.abs(params.yaw);
    if (absYaw <= 15) score += 25;
    else if (absYaw <= 25) score += 15;
    else if (params.allowTurned && absYaw <= 45) score += 20;
  }
  if (params.eyesOpen) score += 20;
  if (params.lightingOk) score += 20;
  return score;
}
