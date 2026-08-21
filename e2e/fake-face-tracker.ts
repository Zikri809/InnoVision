/**
 * Standalone fake-face-tracker init script for Playwright E2E (Phase 7 —
 * CompreFace migration).
 *
 * Installed via `page.addInitScript(fakeFaceInit)` BEFORE the student
 * navigates to `/play` (addInitScript is not retroactive). It installs:
 *  - `window.__INNOVISION_FAKE_FACE_TRACKER__` — an `IFaceTracker`-shaped fake
 *    whose `captureFrame()` returns a deterministic FRAME MARKER string:
 *    `'match'` → `data:image/jpeg;base64,FAKE_FRAME_MATCH`;
 *    `'mismatch'` → `data:image/jpeg;base64,FAKE_FRAME_MISMATCH`.
 *    The route-level CompreFace mock (`compreface-client.ts`, mock mode)
 *    inspects the frame string and returns the corresponding canned response.
 *  - `window.__INNOVISION_FAKE_FACE_CONTROL__` — `setVerifyMode('match'|
 *    'mismatch')` (default 'match'), `triggerBlink()` (resolves the current
 *    `waitForBlink`), `setFacePeriodic({minMs,maxMs})` (overrides the periodic
 *    cadence — stored on the control so the pipeline reads it at construction).
 *
 * TEST-ONLY: never imported by app code. `start`/`stop` are StrictMode-
 * idempotent (Next dev runs StrictMode).
 *
 * NOTE: Playwright serializes this function to a string for `addInitScript`,
 * so it must be fully self-contained (no outer imports / module references).
 */
export function fakeFaceInit(): void {
  const MATCH_MARKER = "data:image/jpeg;base64,FAKE_FRAME_MATCH";
  const MISMATCH_MARKER = "data:image/jpeg;base64,FAKE_FRAME_MISMATCH";

  type FakeTracker = {
    start(): void;
    stop(): void;
    captureFrame(): Promise<string | null>;
    captureBestFrame?(): Promise<string | null>;
    waitForBlink(timeoutMs: number): Promise<"passed" | "failed">;
  };

  let verifyMode: "match" | "mismatch" = "match";
  let blinkResolver: ((r: "passed" | "failed") => void) | null = null;
  let blinkTimer: ReturnType<typeof setTimeout> | null = null;
  // Latch: a `triggerBlink` before any `waitForBlink` registers resolves the
  // NEXT wait immediately (removes the click→register race in the E2E helper).
  let pendingBlink = false;
  let periodic: { minMs: number; maxMs: number } = { minMs: 30000, maxMs: 45000 };

  const tracker: FakeTracker = {
    start(): void {
      // StrictMode-idempotent: nothing to start (frames are synchronous).
    },
    stop(): void {
      if (blinkTimer !== null) {
        clearTimeout(blinkTimer);
        blinkTimer = null;
      }
      pendingBlink = false;
      if (blinkResolver) {
        blinkResolver("failed");
        blinkResolver = null;
      }
    },
    async captureFrame(): Promise<string | null> {
      return verifyMode === "match" ? MATCH_MARKER : MISMATCH_MARKER;
    },
    async captureBestFrame(): Promise<string | null> {
      return verifyMode === "match" ? MATCH_MARKER : MISMATCH_MARKER;
    },
    async waitForBlink(timeoutMs: number): Promise<"passed" | "failed"> {
      return new Promise((resolve) => {
        // A blink latched before this wait → resolve immediately.
        if (pendingBlink) {
          pendingBlink = false;
          resolve("passed");
          return;
        }
        // StrictMode-idempotent: a second wait supersedes the first.
        if (blinkTimer !== null) clearTimeout(blinkTimer);
        blinkResolver = resolve;
        blinkTimer = setTimeout(() => {
          blinkResolver = null;
          blinkTimer = null;
          resolve("failed");
        }, timeoutMs);
      });
    },
  };

  window.__INNOVISION_FAKE_FACE_TRACKER__ = tracker;

  window.__INNOVISION_FAKE_FACE_CONTROL__ = {
    setVerifyMode(mode: "match" | "mismatch"): void {
      verifyMode = mode;
    },
    triggerBlink(): void {
      if (blinkTimer !== null) {
        clearTimeout(blinkTimer);
        blinkTimer = null;
      }
      if (blinkResolver) {
        const r = blinkResolver;
        blinkResolver = null;
        r("passed");
      } else {
        // No wait pending — latch so the next waitForBlink resolves instantly.
        pendingBlink = true;
      }
    },
    setFacePeriodic(opts: { minMs: number; maxMs: number }): void {
      periodic = { minMs: opts.minMs, maxMs: opts.maxMs };
    },
    // Exposed for the pipeline's `getFakePeriodicOverride()` read.
    get _periodic(): { minMs: number; maxMs: number } {
      return periodic;
    },
  };
}
