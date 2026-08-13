import type { IHandTracker, FakeHandControl } from "./types";

/**
 * Typed accessors for the E2E fake-hand-tracker test seam (Phase 6).
 *
 * This module is PURE — it reads `globalThis` globals and shape-validates
 * `start`/`stop`/`sequence`/`frame` only. There is deliberately NO
 * `process.env` here: the `NODE_ENV !== "production"` gate lives in the
 * GestureLayer boot effect, so this module stays trivially importable in Node
 * unit tests and the component never sees a raw `(window as any)` cast.
 *
 * SECURITY: the globals are read-only and only affect the student's own
 * client-side gesture input (a student could already click/`fetch`). The
 * production gate + shape validation keep browser extensions/3P scripts from
 * silently replacing gesture tracking in a production build.
 */
const FAKE_TRACKER_KEY = "__INNOVISION_FAKE_HAND_TRACKER__";
const FAKE_CONTROL_KEY = "__INNOVISION_FAKE_HAND_CONTROL__";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Return the E2E fake tracker if installed and well-shaped, else undefined. */
export function getFakeHandTracker(): IHandTracker | undefined {
  const candidate = (globalThis as Record<string, unknown>)[FAKE_TRACKER_KEY];
  if (
    isRecord(candidate) &&
    typeof candidate.start === "function" &&
    typeof candidate.stop === "function"
  ) {
    return candidate as unknown as IHandTracker;
  }
  return undefined;
}

/** Return the E2E fake control if installed and well-shaped, else undefined. */
export function getFakeHandControl(): FakeHandControl | undefined {
  const candidate = (globalThis as Record<string, unknown>)[FAKE_CONTROL_KEY];
  if (
    isRecord(candidate) &&
    typeof candidate.sequence === "function" &&
    typeof candidate.frame === "function"
  ) {
    return candidate as unknown as FakeHandControl;
  }
  return undefined;
}
