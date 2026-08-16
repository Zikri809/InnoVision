import { describe, it, expect } from "vitest";
import { BlinkDetector } from "./liveness";
import { EYE_OPEN_MAX, EYE_CLOSED_MIN } from "./constants";

/**
 * U-F5 — blink liveness: an open→closed transition passes; no open→closed
 * within timeout fails (timeout handled by the caller); a mid-blink start
 * fails rather than falsely passing; reset re-arms.
 */
describe("BlinkDetector", () => {
  it("U-F5: open→closed transition → passed", () => {
    const d = new BlinkDetector();
    expect(d.update(0.1, 0.1)).toBe("pending");
    expect(d.update(0.9, 0.95)).toBe("passed");
    expect(d.stateValue).toBe("passed");
  });

  it("U-F5: stays pending while eyes remain open", () => {
    const d = new BlinkDetector();
    for (let i = 0; i < 10; i++) {
      expect(d.update(0.1, 0.1)).toBe("pending");
    }
  });

  it("U-F5: already-closed at start → failed (not a false pass)", () => {
    const d = new BlinkDetector();
    expect(d.update(0.9, 0.9)).toBe("pending"); // still closed, no open seen
    expect(d.update(0.5, 0.5)).toBe("failed"); // ambiguous after closed → failed
  });

  it("U-F5: reset re-arms the detector", () => {
    const d = new BlinkDetector();
    d.update(0.1, 0.1);
    d.update(0.9, 0.9);
    expect(d.stateValue).toBe("passed");
    d.reset();
    expect(d.stateValue).toBe("pending");
    expect(d.update(0.1, 0.1)).toBe("pending");
    expect(d.update(0.95, 0.95)).toBe("passed");
  });

  it("U-F5: ambiguous sample between thresholds while open stays pending", () => {
    const d = new BlinkDetector();
    // First see a genuine open sample.
    expect(d.update(0.1, 0.1)).toBe("pending");
    // 0.5 is above EYE_OPEN_MAX (0.4) and below EYE_CLOSED_MIN (0.6).
    expect(d.update(0.5, 0.5)).toBe("pending");
    expect(d.update(0.1, 0.1)).toBe("pending");
  });

  it("U-F5: ambiguous before any open sample → failed (unverifiable start)", () => {
    const d = new BlinkDetector();
    expect(d.update(0.5, 0.5)).toBe("failed");
  });

  it("U-F5: threshold boundaries use the constants", () => {
    const d = new BlinkDetector();
    expect(d.update(EYE_OPEN_MAX, EYE_OPEN_MAX)).toBe("pending");
    expect(d.update(EYE_CLOSED_MIN, EYE_CLOSED_MIN)).toBe("passed");
  });
});
