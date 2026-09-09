import { describe, expect, it, vi } from "vitest";
import { computeHandLuminance } from "./hand-tracker";
import type { Landmark } from "./types";

describe("computeHandLuminance", () => {
  const w = 640;
  const h = 480;

  function createMockContext(
    pixelValue: number,
    onGetImageData?: (sx: number, sy: number, sw: number, sh: number) => void,
  ): CanvasRenderingContext2D {
    return {
      getImageData: vi.fn((sx: number, sy: number, sw: number, sh: number) => {
        onGetImageData?.(sx, sy, sw, sh);
        // sw * sh * 4 RGBA values
        const length = Math.max(0, sw * sh * 4);
        const data = new Uint8ClampedArray(length);
        for (let i = 0; i < length; i += 4) {
          data[i] = pixelValue; // R
          data[i + 1] = pixelValue; // G
          data[i + 2] = pixelValue; // B
          data[i + 3] = 255; // A
        }
        return { data, width: sw, height: sh } as ImageData;
      }),
    } as unknown as CanvasRenderingContext2D;
  }

  it("returns too_dark when canvas context throws or fails", () => {
    const throwingCtx = {
      getImageData: () => {
        throw new Error("Canvas tainted / security error");
      },
    } as unknown as CanvasRenderingContext2D;

    expect(computeHandLuminance(throwingCtx, w, h, null)).toBe("too_dark");
  });

  it("returns too_dark for invalid dimensions (<= 0)", () => {
    const ctx = createMockContext(128);
    expect(computeHandLuminance(ctx, 0, 0, null)).toBe("too_dark");
    expect(computeHandLuminance(ctx, -100, 480, null)).toBe("too_dark");
  });

  it("mirrors the ROI x-coordinate to correctly sample the flipped canvas preview", () => {
    let capturedSx = -1;
    const ctx = createMockContext(128, (sx) => {
      capturedSx = sx;
    });

    // Create landmarks on the left side of the raw video (e.g. x around 0.15)
    const landmarks: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0.15, y: 0.5, z: 0 }));
    landmarks[0] = { x: 0.10, y: 0.6, z: 0 };
    landmarks[5] = { x: 0.20, y: 0.4, z: 0 };
    landmarks[17] = { x: 0.20, y: 0.6, z: 0 };

    computeHandLuminance(ctx, w, h, landmarks);

    // If roi was on the left (e.g. x < 200), on mirrored canvas it must be sampled on the right (> 300)
    expect(capturedSx).toBeGreaterThan(300);
  });

  it("classifies dark lighting (< 80) as too_dark", () => {
    const ctx = createMockContext(40); // 40 is well below IDEAL_LIGHTING_MIN (80)
    expect(computeHandLuminance(ctx, w, h, null)).toBe("too_dark");

    const ctx60 = createMockContext(60); // 60 is degraded low lighting (< 80)
    expect(computeHandLuminance(ctx60, w, h, null)).toBe("too_dark");
  });

  it("classifies ideal lighting (80-195) as good", () => {
    const ctx = createMockContext(130);
    expect(computeHandLuminance(ctx, w, h, null)).toBe("good");
  });

  it("classifies overexposed bright lighting (> 195) as too_bright", () => {
    const ctx = createMockContext(230); // 230 is well above IDEAL_LIGHTING_MAX (195)
    expect(computeHandLuminance(ctx, w, h, null)).toBe("too_bright");
  });
});
