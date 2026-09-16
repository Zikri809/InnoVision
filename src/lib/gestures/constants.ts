/**
 * Shared constants for the gesture layer (Phase 6).
 *
 * This module is pure and env-free (house precedent: `lib/sessions/timer.ts`)
 * so it can be imported by Node unit tests, the client components, and the E2E
 * specs. E2E derives its hold/clear margins from these values (single source
 * of truth) via relative imports — Playwright does not resolve the `@/*` alias.
 */

/** Duration a finger must be held steady to confirm an answer. */
export const HOLD_MS = 1200;

/**
 * Hand-tracker duty-cycle tiers (applied via `IHandTracker.setFrameInterval`).
 * The detection loop slows to the current quiz phase's tier while the canvas
 * preview render stays at the full ~30fps (decoupled inside the tracker), so
 * CPU-bound hosts — VPS boxes where the GPU delegate falls back to WASM and
 * two landmarkers run concurrently — stop spending inference on frames no
 * consumer reads. FULL while a question is answerable or the scan countdown
 * runs (hold latency + hand-loss timing own the frame budget), FEEDBACK
 * during feedback dwell (palm-next hold stays live), IDLE when nothing can
 * fire (reading/locked states).
 */
export const HAND_TRACK_FULL_INTERVAL_MS = 33;
export const HAND_TRACK_FEEDBACK_INTERVAL_MS = 66;
export const HAND_TRACK_IDLE_INTERVAL_MS = 150;

/** "3-2-1-SCAN" countdown between questions while gestures are active. */
export const SCAN_COUNTDOWN_MS = 1200;

/** Hand absent this long (assessment) → show the "keep your hand visible" warning. */
export const WARN_AFTER_MS = 3000;

/** Hand absent this long (assessment) → show the client-side pause overlay. */
export const PAUSE_AFTER_MS = 10000;
/**
 * Stabilization window for clearing the pause overlay: the hand must be
 * continuously present for this long before input unblocks. A single present
 * frame must NOT unlock (a hold started while paused could otherwise fire the
 * instant input unblocks — E9b pins this).
 */
export const PAUSE_CLEAR_MS = 1500;

/** Whole-boot deadline for the real tracker (camera + bundle + model). */
export const BOOT_TIMEOUT_MS = 10000;

/** Maximum finger count that can map to an answer (5-option MCQ). */
export const MAX_ANSWER_FINGERS = 5;

/**
 * Fake-tracker tick interval (E2E). Mirrored as a local literal inside the
 * standalone `e2e/fake-hand-tracker.ts` init script (addInitScript cannot
 * import); this export is the documentation/single-source for Node-side code.
 */
export const FAKE_TICK_MS = 50;
