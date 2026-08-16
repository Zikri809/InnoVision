import type { IFaceTracker, FakeFaceControl } from "./types";

/**
 * Typed accessors for the E2E fake-face-tracker test seam (Phase 7 — CompreFace
 * migration).
 *
 * This module is PURE — it reads `globalThis` globals and shape-validates
 * `start`/`stop`/`captureFrame`/`waitForBlink` and the control surface
 * only. There is deliberately NO `process.env` here: the `NODE_ENV !==
 * "production"` gate lives in the face-tracker boot effect, so this module
 * stays trivially importable in Node unit tests and the component never sees a
 * raw `(window as any)` cast.
 *
 * SECURITY: the globals are read-only and only affect the student's own
 * client-side face input (a student could already click/`fetch`). The
 * production gate + shape validation keep browser extensions/3P scripts from
 * silently replacing face tracking in a production build.
 */
const FAKE_TRACKER_KEY = "__INNOVISION_FAKE_FACE_TRACKER__";
const FAKE_CONTROL_KEY = "__INNOVISION_FAKE_FACE_CONTROL__";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Return the E2E fake tracker if installed and well-shaped, else undefined. */
export function getFakeFaceTracker(): IFaceTracker | undefined {
  const candidate = (globalThis as Record<string, unknown>)[FAKE_TRACKER_KEY];
  if (
    isRecord(candidate) &&
    typeof candidate.start === "function" &&
    typeof candidate.stop === "function" &&
    typeof candidate.captureFrame === "function" &&
    typeof candidate.waitForBlink === "function"
  ) {
    return candidate as unknown as IFaceTracker;
  }
  return undefined;
}

/** Return the E2E fake control if installed and well-shaped, else undefined. */
export function getFakeFaceControl(): FakeFaceControl | undefined {
  const candidate = (globalThis as Record<string, unknown>)[FAKE_CONTROL_KEY];
  if (
    isRecord(candidate) &&
    typeof candidate.setVerifyMode === "function" &&
    typeof candidate.triggerBlink === "function" &&
    typeof candidate.setFacePeriodic === "function"
  ) {
    return candidate as unknown as FakeFaceControl;
  }
  return undefined;
}
