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
 *    The route-level CompreFace mock (`insightface-client.ts`, mock mode)
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
    pitch?: number;
    centered: boolean;
    faceDetected: boolean;
    facesSeen: number;
    lighting: "good" | "too_dark" | "too_bright";
  };

  type FakeTracker = {
    start(): void;
    stop(): void;
    captureFrame(): Promise<string | null>;
    captureBestFrame?(opts?: { angle?: "front" | "left" | "right" }): Promise<string | null>;
    waitForBlink(timeoutMs: number): Promise<"passed" | "failed">;
    waitForHeadTurn?(timeoutMs: number, side: "left" | "right"): Promise<"passed" | "failed">;
    onPoseChange?(cb: (pose: FakePose) => void): () => void;
    getFaceHealth?(): { aligned: boolean; lightingOk: boolean; faceDetected: boolean };
    readonly lastAcceptedPose?: { angle: "front" | "left" | "right"; yaw: number } | null;
  };

  let verifyMode: "match" | "mismatch" = "match";
  let blinkResolver: ((r: "passed" | "failed") => void) | null = null;
  let blinkTimer: ReturnType<typeof setTimeout> | null = null;
  // Latch: a `triggerBlink` before any `waitForBlink` registers resolves the
  // NEXT wait immediately (removes the click→register race in the E2E helper).
  let pendingBlink = false;
  // Head-turn challenge (anti-replay): same latched-resolver pattern as the
  // blink. `triggerHeadTurn` resolves the current wait (or latches for the
  // next one); the side is accepted but not enforced — the fake has no real
  // pose stream the challenge could judge.
  let turnResolver: ((r: "passed" | "failed") => void) | null = null;
  let turnTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTurn = false;
  let periodic: { minMs: number; maxMs: number } = { minMs: 30000, maxMs: 45000 };
  // Scriptable pose state — the advisories hook (AttentionMonitor) and the
  // pipeline's lighting precheck consume this through onPoseChange /
  // getFaceHealth.
  let pose: FakePose = {
    yaw: 0,
    pitch: 0,
    centered: true,
    faceDetected: true,
    facesSeen: 1,
    lighting: "good",
  };
  const poseListeners = new Set<(p: FakePose) => void>();
  let poseTimer: ReturnType<typeof setInterval> | null = null;
  // The pose the last `captureBestFrame({ angle })` accepted — mirrors the
  // real tracker's `lastAcceptedPose` so the enroll client ships the same
  // `yawReadings` payload (prod incident 2026-09-21).
  let acceptedPose: { angle: "front" | "left" | "right"; yaw: number } | null = null;

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
      if (turnTimer !== null) {
        clearTimeout(turnTimer);
        turnTimer = null;
      }
      if (poseTimer !== null) {
        clearInterval(poseTimer);
        poseTimer = null;
      }
      pendingBlink = false;
      pendingTurn = false;
      if (blinkResolver) {
        blinkResolver("failed");
        blinkResolver = null;
      }
      if (turnResolver) {
        turnResolver("failed");
        turnResolver = null;
      }
    },
    async captureFrame(): Promise<string | null> {
      return verifyMode === "match" ? MATCH_MARKER : MISMATCH_MARKER;
    },
    async captureBestFrame(opts?: { angle?: "front" | "left" | "right" }): Promise<string | null> {
      // The real tracker enforces the per-angle yaw band here (prod incident
      // 2026-09-21) and records the pose it accepted. The fake mirrors that
      // contract so E2E exercises the same wire payload: the pose currently
      // scripted via setFacePose is the accepted reading for the requested
      // angle. Without an angle the call is angle-agnostic (verify path).
      if (opts?.angle) {
        acceptedPose = { angle: opts.angle, yaw: pose.yaw };
      }
      return verifyMode === "match" ? MATCH_MARKER : MISMATCH_MARKER;
    },
    get lastAcceptedPose(): { angle: "front" | "left" | "right"; yaw: number } | null {
      return acceptedPose;
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
    async waitForHeadTurn(timeoutMs: number, _side: "left" | "right"): Promise<"passed" | "failed"> {
      return new Promise((resolve) => {
        // A turn latched before this wait → resolve immediately.
        if (pendingTurn) {
          pendingTurn = false;
          resolve("passed");
          return;
        }
        // StrictMode-idempotent: a second wait supersedes the first.
        if (turnTimer !== null) clearTimeout(turnTimer);
        turnResolver = resolve;
        turnTimer = setTimeout(() => {
          turnResolver = null;
          turnTimer = null;
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
    triggerHeadTurn(): void {
      if (turnTimer !== null) {
        clearTimeout(turnTimer);
        turnTimer = null;
      }
      if (turnResolver) {
        const r = turnResolver;
        turnResolver = null;
        r("passed");
      } else {
        pendingTurn = true;
      }
    },
    setFacePeriodic(opts: { minMs: number; maxMs: number }): void {
      periodic = { minMs: opts.minMs, maxMs: opts.maxMs };
    },
    setFacePose(opts: {
      yaw?: number;
      pitch?: number;
      centered?: boolean;
      faceDetected?: boolean;
      facesSeen?: number;
      lighting?: "good" | "too_dark" | "too_bright";
    }): void {
      pose = {
        yaw: opts.yaw ?? pose.yaw,
        pitch: opts.pitch ?? pose.pitch,
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
