import { describe, it, expect } from "vitest";
import { shouldDeferFaceCheck, type FaceCheckHealth } from "./face-check-gate";

/**
 * Precheck gate unit tests: the deferral policy for mid-quiz face checks —
 * transient bad moments (dim lighting, mid-commit hand, absent/unaligned
 * face) defer silently; exhaustion falls through to capture (the server
 * judges the real frame); `start` and null-health never defer.
 */
describe("shouldDeferFaceCheck", () => {
  const good: FaceCheckHealth = { aligned: true, lightingOk: true, faceDetected: true };

  it("defers on bad lighting (the original precheck condition)", () => {
    expect(
      shouldDeferFaceCheck({ ...good, lightingOk: false }, false, "periodic", 0, 2),
    ).toBe(true);
  });

  it("defers when no face is detected (palm over the camera)", () => {
    expect(
      shouldDeferFaceCheck({ ...good, faceDetected: false }, false, "periodic", 0, 2),
    ).toBe(true);
  });

  it("defers when the face is present but unaligned (yaw beyond 25°, not centered)", () => {
    expect(
      shouldDeferFaceCheck({ ...good, aligned: false }, false, "question", 0, 2),
    ).toBe(true);
  });

  it("defers while a hand gesture is mid-commit, even with perfect health", () => {
    expect(shouldDeferFaceCheck(good, true, "question", 0, 2)).toBe(true);
  });

  it("proceeds on healthy, idle conditions", () => {
    expect(shouldDeferFaceCheck(good, false, "question", 0, 2)).toBe(false);
  });

  it("never defers the `start` trigger (gate ran blink liveness; no soft-lock)", () => {
    expect(shouldDeferFaceCheck({ ...good, aligned: false }, true, "start", 0, 2)).toBe(
      false,
    );
  });

  it("proceeds once retries are exhausted — sustained occlusion is judged server-side", () => {
    const bad: FaceCheckHealth = { aligned: false, lightingOk: false, faceDetected: false };
    expect(shouldDeferFaceCheck(bad, true, "periodic", 2, 2)).toBe(false);
    expect(shouldDeferFaceCheck(bad, true, "periodic", 3, 2)).toBe(false);
  });

  it("defers below the retry cap regardless of which retry index it lands on", () => {
    const bad: FaceCheckHealth = { aligned: false, lightingOk: false, faceDetected: false };
    expect(shouldDeferFaceCheck(bad, false, "periodic", 1, 2)).toBe(true);
  });

  it("proceeds on null health (trackers without getFaceHealth — legacy behavior)", () => {
    expect(shouldDeferFaceCheck(null, false, "question", 0, 2)).toBe(false);
  });

  it("never gates harder than lighting did when health omits fields", () => {
    expect(shouldDeferFaceCheck({}, false, "periodic", 0, 2)).toBe(false);
  });
});
