import { describe, it, expect } from "vitest";
import {
  calculatePhotometricLuminance,
  classifyLighting,
  getFacialSkinRegion,
  getHandPalmRegion,
  scoreFrameQuality,
  IDEAL_LIGHTING_MIN,
  IDEAL_LIGHTING_MAX,
  GENERAL_LIGHTING_MIN,
  GENERAL_LIGHTING_MAX,
} from "./quality";

describe("calculatePhotometricLuminance", () => {
  it("calculates correct luminance for pure colors", () => {
    // Pure Black
    expect(calculatePhotometricLuminance(0, 0, 0)).toBe(0);
    // Pure White
    expect(calculatePhotometricLuminance(255, 255, 255)).toBeCloseTo(255, 4);
    // Pure Red (0.299 * 255 = 76.245)
    expect(calculatePhotometricLuminance(255, 0, 0)).toBeCloseTo(76.245, 3);
    // Pure Green (0.587 * 255 = 149.685)
    expect(calculatePhotometricLuminance(0, 255, 0)).toBeCloseTo(149.685, 3);
    // Pure Blue (0.114 * 255 = 29.07)
    expect(calculatePhotometricLuminance(0, 0, 255)).toBeCloseTo(29.07, 3);
  });

  it("handles typical skin tones", () => {
    // Light skin tone (~RGB 240, 190, 160) -> 0.299(240) + 0.587(190) + 0.114(160) = 71.76 + 111.53 + 18.24 = 201.53
    expect(calculatePhotometricLuminance(240, 190, 160)).toBeCloseTo(201.53, 2);
    // Medium skin tone (~RGB 160, 120, 90) -> 0.299(160) + 0.587(120) + 0.114(90) = 47.84 + 70.44 + 10.26 = 128.54
    expect(calculatePhotometricLuminance(160, 120, 90)).toBeCloseTo(128.54, 2);
    // Darker skin tone (~RGB 90, 60, 40) -> 0.299(90) + 0.587(60) + 0.114(40) = 26.91 + 35.22 + 4.56 = 66.69
    expect(calculatePhotometricLuminance(90, 60, 40)).toBeCloseTo(66.69, 2);
  });

  it("safely clamps negative and out-of-range inputs and NaN", () => {
    expect(calculatePhotometricLuminance(-50, 0, 0)).toBe(0);
    expect(calculatePhotometricLuminance(300, 255, 255)).toBeCloseTo(255, 4);
    expect(calculatePhotometricLuminance(Number.NaN, 100, 100)).toBeCloseTo(0.587 * 100 + 0.114 * 100, 3);
    expect(calculatePhotometricLuminance(Number.POSITIVE_INFINITY, 0, 0)).toBe(0);
  });
});

describe("classifyLighting", () => {
  it("classifies ideal lighting (enrollment mode)", () => {
    // Below ideal threshold (< 80)
    expect(classifyLighting(0, "ideal")).toBe("too_dark");
    expect(classifyLighting(50, "ideal")).toBe("too_dark");
    expect(classifyLighting(79.9, "ideal")).toBe("too_dark");

    // Ideal range (80 - 195)
    expect(classifyLighting(IDEAL_LIGHTING_MIN, "ideal")).toBe("good");
    expect(classifyLighting(120, "ideal")).toBe("good");
    expect(classifyLighting(160, "ideal")).toBe("good");
    expect(classifyLighting(IDEAL_LIGHTING_MAX, "ideal")).toBe("good");

    // Above ideal threshold (> 195)
    expect(classifyLighting(195.1, "ideal")).toBe("too_bright");
    expect(classifyLighting(230, "ideal")).toBe("too_bright");
    expect(classifyLighting(255, "ideal")).toBe("too_bright");
  });

  it("classifies general lighting (assessment mode)", () => {
    // Below general threshold (< 65)
    expect(classifyLighting(0, "general")).toBe("too_dark");
    expect(classifyLighting(64.9, "general")).toBe("too_dark");

    // General range (65 - 215)
    expect(classifyLighting(GENERAL_LIGHTING_MIN, "general")).toBe("good");
    expect(classifyLighting(75, "general")).toBe("good");
    expect(classifyLighting(150, "general")).toBe("good");
    expect(classifyLighting(GENERAL_LIGHTING_MAX, "general")).toBe("good");

    // Above general threshold (> 215)
    expect(classifyLighting(215.1, "general")).toBe("too_bright");
    expect(classifyLighting(255, "general")).toBe("too_bright");
  });

  it("gracefully defaults on NaN or infinite luminance", () => {
    expect(classifyLighting(Number.NaN, "ideal")).toBe("good");
    expect(classifyLighting(Number.POSITIVE_INFINITY, "ideal")).toBe("good");
  });
});

describe("getFacialSkinRegion", () => {
  const w = 640;
  const h = 480;

  it("returns centered default bounding box when landmarks are missing or null", () => {
    const r1 = getFacialSkinRegion(w, h, null);
    expect(r1).toEqual({ x: 192, y: 120, width: 256, height: 240 });

    const r2 = getFacialSkinRegion(w, h, []);
    expect(r2).toEqual({ x: 192, y: 120, width: 256, height: 240 });
  });

  it("computes bounded ROI from facial landmarks with 15% inner padding", () => {
    // Mock landmarks with face span x: [0.3, 0.7], y: [0.2, 0.8]
    const landmarks = Array.from({ length: 468 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    landmarks[10] = { x: 0.5, y: 0.2, z: 0 }; // Forehead
    landmarks[152] = { x: 0.5, y: 0.8, z: 0 }; // Chin
    landmarks[234] = { x: 0.3, y: 0.5, z: 0 }; // Left cheek
    landmarks[454] = { x: 0.7, y: 0.5, z: 0 }; // Right cheek
    landmarks[1] = { x: 0.5, y: 0.5, z: 0 }; // Nose

    const roi = getFacialSkinRegion(w, h, landmarks);
    // Span: width span 0.4, height span 0.6
    // PadX = 0.4 * 0.15 = 0.06 -> x range [0.36, 0.64] * 640 = [230.4, 409.6] -> width = 179.2
    // PadY = 0.6 * 0.15 = 0.09 -> y range [0.29, 0.71] * 480 = [139.2, 340.8] -> height = 201.6
    expect(roi.x).toBeGreaterThanOrEqual(220);
    expect(roi.x).toBeLessThanOrEqual(240);
    expect(roi.width).toBeGreaterThanOrEqual(170);
    expect(roi.width).toBeLessThanOrEqual(190);
    expect(roi.y).toBeGreaterThanOrEqual(130);
    expect(roi.y).toBeLessThanOrEqual(150);
  });

  it("handles out-of-bounds or negative dimensions safely", () => {
    expect(getFacialSkinRegion(0, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(getFacialSkinRegion(-100, 480)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(getFacialSkinRegion(Number.NaN, 480)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("getHandPalmRegion", () => {
  const w = 640;
  const h = 480;

  it("returns centered fallback when landmarks are empty", () => {
    const roi = getHandPalmRegion(w, h, null);
    expect(roi.width).toBeGreaterThan(0);
    expect(roi.height).toBeGreaterThan(0);
  });

  it("extracts hand palm region from palm base landmarks", () => {
    const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    landmarks[0] = { x: 0.4, y: 0.7, z: 0 }; // wrist
    landmarks[5] = { x: 0.35, y: 0.4, z: 0 }; // index mcp
    landmarks[17] = { x: 0.65, y: 0.45, z: 0 }; // pinky mcp

    const roi = getHandPalmRegion(w, h, landmarks);
    expect(roi.x).toBeGreaterThan(0);
    expect(roi.y).toBeGreaterThan(0);
    expect(roi.width).toBeGreaterThan(0);
    expect(roi.height).toBeGreaterThan(0);
    expect(roi.x + roi.width).toBeLessThanOrEqual(w);
    expect(roi.y + roi.height).toBeLessThanOrEqual(h);
  });
});

describe("scoreFrameQuality", () => {
  it("awards maximum score (+100) for pristine frame", () => {
    const score = scoreFrameQuality({
      faceDetected: true,
      centered: true,
      yaw: 5,
      eyesOpen: true,
      lightingOk: true,
    });
    // 30 (presence) + 25 (centered) + 25 (yaw <= 15) + 20 (eyes) + 20 (lighting) = 120
    expect(score).toBe(120);
  });

  it("penalizes closed eyes or missing face", () => {
    const noFaceScore = scoreFrameQuality({
      faceDetected: false,
      centered: false,
      yaw: 0,
      eyesOpen: true,
      lightingOk: true,
    });
    // 0 (no face) + 0 (not centered) + 0 (yaw not scored) + 20 (eyes) + 20 (lighting) = 40
    expect(noFaceScore).toBe(40);

    const blinkScore = scoreFrameQuality({
      faceDetected: true,
      centered: true,
      yaw: 0,
      eyesOpen: false,
      lightingOk: true,
    });
    // 30 + 25 + 25 + 0 (closed eyes) + 20 = 100
    expect(blinkScore).toBe(100);
  });

  it("scores intermediate head angles correctly", () => {
    const straightScore = scoreFrameQuality({
      faceDetected: true,
      centered: true,
      yaw: 10,
      eyesOpen: true,
      lightingOk: true,
    });
    const tiltedScore = scoreFrameQuality({
      faceDetected: true,
      centered: true,
      yaw: 22,
      eyesOpen: true,
      lightingOk: true,
    });
    const turnedScore = scoreFrameQuality({
      faceDetected: true,
      centered: true,
      yaw: 40,
      eyesOpen: true,
      lightingOk: true,
    });

    expect(straightScore).toBe(120);
    expect(tiltedScore).toBe(110); // +15 for 15 < abs(yaw) <= 25
    expect(turnedScore).toBe(95); // +0 for abs(yaw) > 25
  });
});
