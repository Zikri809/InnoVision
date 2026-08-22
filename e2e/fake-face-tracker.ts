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

  type FakePose = {
    yaw: number;
    centered: boolean;
    faceDetected: boolean;
    facesSeen: number;
    lighting: "good" | "too_dark" | "too_bright";
  };

  type FakeTracker = {
    start(): void;
    stop(): void;
    captureFrame(): Promise<string | null>;
    captureBestFrame?(): Promise<string | null>;
    waitForBlink(timeoutMs: number): Promise<"passed" | "failed">;
    onPoseChange?(cb: (pose: FakePose) => void): () => void;
    getFaceHealth?(): { aligned: boolean; lightingOk: boolean; faceDetected: boolean };
  };

  let verifyMode: "match" | "mismatch" = "match";
  let blinkResolver: ((r: "passed" | "failed") => void) | null = null;
  let blinkTimer: ReturnType<typeof setTimeout> | null = null;
  // Latch: a `triggerBlink` before any `waitForBlink` registers resolves the
  // NEXT wait immediately (removes the click→register race in the E2E helper).
  let pendingBlink = false;
  let periodic: { minMs: number; maxMs: number } = { minMs: 30000, maxMs: 45000 };
  // Scriptable pose state — the advisories hook (AttentionMonitor) and the
  // pipeline's lighting precheck consume this through onPoseChange /
  // getFaceHealth.
  let pose: FakePose = { yaw: 0, centered: true, faceDetected: true, facesSeen: 1, lighting: "good" };
  const poseListeners = new Set<(p: FakePose) => void>();
  let poseTimer: ReturnType<typeof setInterval> | null = null;

  function ensurePoseLoop(): void {
    if (poseTimer !== null || poseListeners.size === 0) return;
    poseTimer = setInterval(() => {
      for (const cb of poseListeners) cb(pose);
    }, 200);
  }

  const tracker: FakeTracker = {
    start(): void {
      // StrictMode-idempotent: nothing to start (frames are synchronous).
    },
    stop(): void {
      if (blinkTimer !== null) {
        clearTimeout(blinkTimer);
        blinkTimer = null;
      }
      if (poseTimer !== null) {
        clearInterval(poseTimer);
        poseTimer = null;
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
    onPoseChange(cb: (p: FakePose) => void): () => void {
      poseListeners.add(cb);
      ensurePoseLoop();
      return () => {
        poseListeners.delete(cb);
        if (poseListeners.size === 0 && poseTimer !== null) {
          clearInterval(poseTimer);
          poseTimer = null;
        }
      };
    },
    getFaceHealth(): { aligned: boolean; lightingOk: boolean; faceDetected: boolean } {
      return {
        aligned: pose.faceDetected && pose.centered && Math.abs(pose.yaw) <= 25,
        lightingOk: pose.lighting === "good",
        faceDetected: pose.faceDetected,
      };
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
    setFacePose(opts: {
      yaw?: number;
      centered?: boolean;
      faceDetected?: boolean;
      facesSeen?: number;
      lighting?: "good" | "too_dark" | "too_bright";
    }): void {
      pose = {
        yaw: opts.yaw ?? pose.yaw,
        centered: opts.centered ?? pose.centered,
        faceDetected: opts.faceDetected ?? pose.faceDetected,
        facesSeen: opts.facesSeen ?? pose.facesSeen,
        lighting: opts.lighting ?? pose.lighting,
      };
    },
    // Exposed for the pipeline's `getFakePeriodicOverride()` read.
    get _periodic(): { minMs: number; maxMs: number } {
      return periodic;
    },
  };
}
