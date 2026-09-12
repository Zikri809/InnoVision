import type { IFaceTracker, LivePose } from "./types";
import { BlinkDetector } from "./liveness";
import { HeadTurnChallenge, type TurnSide } from "./challenge";
import {
  FACE_TRACK_FRAME_INTERVAL_MS,
  HEAD_TURN_TIMEOUT_MS,
  LIVENESS_TIMEOUT_MS,
  LUMINANCE_SAMPLE_INTERVAL_MS,
} from "./constants";
import {
  acquireCameraStream,
  releaseCameraStream,
  resolveStream,
} from "@/lib/vision/camera";
import {
  calculatePhotometricLuminance,
  classifyLighting,
  getFacialSkinRegion,
  scoreFrameQuality,
} from "./quality";

/**
 * Browser-only MediaPipe face tracker (Phase 7 — CompreFace migration).
 *
 * CLIENT-SAFE: no top-level browser access — every `document`/`navigator`/
 * `window`/MediaPipe reference lives inside the class, so the module parses
 * under Vitest (it is never executed there; see the 0-threshold coverage key
 * in `vitest.config.ts`). The pure logic it mirrors lives in `lib/face/*`
 * (Node-unit-tested); this file is the real end-to-end seam exercised by
 * manual smoke (TESTING §7) + the E2E fake-tracker path.
 *
 * Camera ownership: this tracker acquires a SHARED stream reference from
 * `lib/vision/camera.ts` — the SOLE owner of `track.stop()`. `stop()` here
 * releases the ref and closes the landmarker but NEVER stops shared tracks.
 *
 * CompreFace migration (L3/L11/L12): the embedding model + `FaceEmbeddingProvider`
 * are GONE — embedding computation moved server-side to CompreFace. This
 * tracker now ONLY:
 *   - boots the vendored `face_landmarker.task` (CPU, blendshapes) for BLINK
 *     liveness (`waitForBlink`),
 *   - captures a base64 JPEG FRAME (`captureFrame`) — the Next.js route
 *     forwards it to CompreFace, and
 *   - reports per-frame pose state (`yaw`, `centered`, `lighting`, and
 *     `facesSeen` via numFaces:2) that powers the UX chips and the
 *     lecturer-visible integrity advisories (`second_face`, `looked_away`).
 *
 * There is deliberately NO client quality gate on the verify path: the
 * capture helpers pick a GOOD frame (best-frame scoring), but the SERVER
 * never trusted client-side gating anyway (CompreFace does its own
 * detection). The former dead `evaluateQuality` native-detector path was
 * removed — multi-face now comes from the landmarker itself.
 *
 * 0-key coverage: like `hand-tracker.ts`, browser-only glue is exercised by
 * manual smoke + E2E fake, not the Node unit suite.
 */

export const FACE_LANDMARKER_MODEL_URL = "/models/face_landmarker.task";

type MediaPipeFaceLandmarker = {
  detectForVideo(video: HTMLVideoElement, timestamp: number): {
    faceBlendshapes?: { categories?: { categoryName?: string; score?: number }[] }[];
    faceLandmarks?: { x: number; y: number; z: number }[][];
    faces?: { faceRectangle?: { left: number; top: number; width: number; height: number } }[];
  };
  close(): void;
};

type VisionModule = {
  FilesetResolver: {
    forVisionTasks(wasmRoot: string): Promise<unknown>;
  };
  FaceLandmarker: {
    createFromOptions(vision: unknown, options: unknown): Promise<MediaPipeFaceLandmarker>;
  };
};

const BLINK_LANDMARKER_URL = "/mediapipe/vision_bundle.mjs";
const WASM_ROOT = "/mediapipe/wasm";

/** Upper clamp for the adaptive duty-cycle interval (see setFrameInterval). */
const FRAME_INTERVAL_MAX_MS = 200;

/** JPEG quality for the captured frame (0–1). */
const FRAME_JPEG_QUALITY = 0.85;

/** Cap the capture canvas so the frame payload stays small (~150 KB). */
const CAPTURE_CANVAS_MAX = 640;

// Suppress benign Emscripten/TFLite C++ stderr logs that trigger Next.js dev overlay
if (typeof window !== "undefined") {
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    if (
      typeof args[0] === "string" &&
      (args[0].includes("Created TensorFlow Lite XNNPACK delegate") ||
        args[0].includes("Sets FaceBlendshapesGraph acceleration"))
    ) {
      console.info(...args);
      return;
    }
    origError.apply(console, args);
  };
}

let cachedVision: VisionModule | null = null;
let cachedFileset: unknown = null;

export class FaceTracker implements IFaceTracker {
  private readonly video: HTMLVideoElement;
  private landmarker: MediaPipeFaceLandmarker | null = null;
  private cameraToken: number | null = null;
  private sharedStream: MediaStream | null = null;

  /**
   * Read-only access to the shared camera stream (mobile redesign plan W3):
   * the paused/recovering overlay renders a self-view <video> bound to THIS
   * stream via srcObject — no second acquireCameraStream token, and the
   * tracker's own bound video element is untouched.
   */
  get stream(): MediaStream | null {
    return this.sharedStream;
  }
  private rafId: number | null = null;
  private disposed = false;
  /**
   * Adaptive duty cycle: the rAF detection loop samples this each tick (see
   * setFrameInterval). Starts FULL — liveness-critical states (gate, blinks)
   * must never be throttled; the pipeline slows it once sustained play begins.
   */
  private frameIntervalMs: number = FACE_TRACK_FRAME_INTERVAL_MS;
  private blinkDetector = new BlinkDetector();
  private visibilityHandler: (() => void) | null = null;
  private loadedMetadataHandler: (() => void) | null = null;
  private loadedMetadataTimer: ReturnType<typeof setTimeout> | null = null;
  private waitForBlinkResolvers: ((outcome: "passed" | "failed") => void)[] = [];
  /**
   * Head-turn challenge state (anti-replay liveness). The pose loop feeds the
   * active challenge; `waitForHeadTurn` mirrors `waitForBlink`'s resolver
   * pattern. Only turns that occur DURING the challenge resolve it — a turn
   * made before the wait began doesn't count (mirrors the blink detector's
   * "during the challenge" rule).
   */
  private turnChallenge: HeadTurnChallenge | null = null;
  private turnChallengePrevSampleMs: number | null = null;
  private waitForTurnResolvers: ((outcome: "passed" | "failed") => void)[] = [];
  private poseListeners: Set<(pose: LivePose) => void> = new Set();
  private errorListeners: Set<(err: unknown) => void> = new Set();
  private errored = false;
  private loopErrorCount = 0;
  private lastFrameAt = 0;
  private canvas: HTMLCanvasElement | null = null;
  private currentPose: LivePose = { yaw: 0, centered: false, faceDetected: false };
  private currentBlendshapes: { left: number; right: number } = { left: 0, right: 0 };
  private currentLandmarks: { x: number; y: number; z?: number }[] | null = null;
  private currentLighting: "good" | "too_dark" | "too_bright" = "good";
  private lastLuminanceSampleAt = 0;
  /**
   * Per-user neutral baseline for the nose-ratio proxy. The raw ratio at
   * "looking straight" varies with facial anatomy AND webcam placement (a
   * side-placed webcam alone can read ~15-20 units), so absolute thresholds
   * misfire per person. When set, yaw is reported RELATIVE to this baseline.
   */
  private ratioBaseline: number | null = null;
  private lastRawRatio: number | null = null;
  /**
   * Neutral baseline for the pitch proxy (nose drop fraction) — calibrated
   * alongside yaw by the same `calibrateNeutral` sampling (the enroll flow's
   * "look straight" pose is the neutral for BOTH axes). Unset → 0.5, the
   * geometric midpoint of the forehead→chin span.
   */
  private pitchBaseline: number | null = null;
  private lastRawPitchRatio: number | null = null;

  /**
   * Sample the live nose ratio for `sampleMs` and store the mean as the
   * user's neutral pose. Call while the user looks straight at the camera
   * (top of the guided enrollment). Falls back silently when the loop is not
   * producing landmarks — the baseline simply stays unset (absolute mode).
   */
  async calibrateNeutral(sampleMs: number = 900): Promise<void> {
    if (this.disposed) return;
    const samples: number[] = [];
    const pitchSamples: number[] = [];
    const deadline = Date.now() + sampleMs;
    while (Date.now() < deadline && !this.disposed) {
      if (this.lastRawRatio !== null) samples.push(this.lastRawRatio);
      if (this.lastRawPitchRatio !== null) pitchSamples.push(this.lastRawPitchRatio);
      await new Promise((r) => setTimeout(r, 50));
    }
    if (samples.length >= 5) {
      // Trim outliers (blinks/mid-motion spikes) then average.
      samples.sort((a, b) => a - b);
      const kept = samples.slice(Math.floor(samples.length * 0.2), Math.ceil(samples.length * 0.8));
      this.ratioBaseline = kept.reduce((s, v) => s + v, 0) / kept.length;
    }
    // Pitch baseline: the same trimmed-mean pass over the samples captured
    // in the same window (the "look straight" pose is neutral for both axes).
    if (pitchSamples.length >= 5) {
      pitchSamples.sort((a, b) => a - b);
      const kept = pitchSamples.slice(Math.floor(pitchSamples.length * 0.2), Math.ceil(pitchSamples.length * 0.8));
      this.pitchBaseline = kept.reduce((s, v) => s + v, 0) / kept.length;
    }
  }

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  onPoseChange(cb: (pose: LivePose) => void): () => void {
    this.poseListeners.add(cb);
    return () => {
      this.poseListeners.delete(cb);
    };
  }

  /**
   * Subscribe to fatal detection-loop errors (fires at most once). A dead loop
   * can no longer produce poses or blinks — subscribers must degrade the
   * pipeline to `'unavailable'` instead of silently freezing (which used to
   * brick blink recovery and strand the student on the paused overlay).
   */
  onError(cb: (err: unknown) => void): () => void {
    this.errorListeners.add(cb);
    return () => {
      this.errorListeners.delete(cb);
    };
  }

  private emitError(err: unknown): void {
    if (this.errored) return;
    this.errored = true;
    for (const listener of this.errorListeners) {
      try {
        listener(err);
      } catch {
        // a broken subscriber must not break the others
      }
    }
  }

  async start(): Promise<void> {
    console.info("[face-tracker] start() initiated");
    // Start loading Vision + Landmarker concurrently with camera acquisition
    const modelPromise = (async () => {
      try {
        console.info("[face-tracker] loadVision() starting...");
        const vision = await this.loadVision();
        console.info("[face-tracker] loadVision() resolved");
        if (this.disposed) return null;
        console.info("[face-tracker] createLandmarker() starting...");
        const landmarker = await this.createLandmarker(vision);
        console.info("[face-tracker] createLandmarker() resolved");
        return landmarker;
      } catch (err) {
        console.error("[face-tracker] failed to create landmarker:", err);
        throw err;
      }
    })();
    // Attach an early no-op handler so a fast model rejection while start() is
    // still awaiting the camera doesn't surface as an unhandled rejection;
    // the real handling happens at `await modelPromise` below.
    modelPromise.catch(() => {});

    // 1. Shared camera stream (coalesced; release on stop).
    console.info("[face-tracker] acquiring camera stream...");
    this.cameraToken = await acquireCameraStream();
    console.info("[face-tracker] camera stream acquired, token:", this.cameraToken);
    if (this.disposed) {
      releaseCameraStream(this.cameraToken);
      this.cameraToken = null;
      return;
    }

    try {
      const stream = resolveStream(this.cameraToken);
      this.sharedStream = stream;
      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.playsInline = true;
      console.info("[face-tracker] video srcObject set, readyState:", this.video.readyState);

      if (this.video.readyState < 1) {
        console.info("[face-tracker] waiting for video metadata...");
        await Promise.race([
          new Promise<void>((resolve) => {
            this.loadedMetadataHandler = () => {
              console.info("[face-tracker] onloadedmetadata fired");
              resolve();
            };
            this.video.onloadedmetadata = this.loadedMetadataHandler;
          }),
          new Promise<void>((resolve) => {
            this.loadedMetadataTimer = setTimeout(() => {
              console.info("[face-tracker] loadedMetadataTimer expired (3s fallback)");
              resolve();
            }, 3000);
          }),
        ]);
        if (this.loadedMetadataTimer) {
          clearTimeout(this.loadedMetadataTimer);
          this.loadedMetadataTimer = null;
        }
      }

      if (this.disposed) {
        console.info("[face-tracker] disposed before play");
        this.releaseCamera();
        return;
      }

      try {
        console.info("[face-tracker] calling video.play()...");
        await Promise.race([
          this.video.play(),
          new Promise<void>((resolve) => setTimeout(resolve, 500)),
        ]);
        console.info("[face-tracker] video.play() resolved/proceeded");
      } catch (err) {
        if (this.disposed || (err instanceof Error && err.name === "AbortError")) {
          console.info("[face-tracker] play() aborted due to disposal/abort");
          this.releaseCamera();
          return;
        }
        console.warn("[face-tracker] play() non-fatal warning:", err);
      }

      // 2. Await the concurrent model creation
      console.info("[face-tracker] awaiting model creation...");
      this.landmarker = await modelPromise;
      console.info("[face-tracker] model creation ready, landmarker present:", !!this.landmarker);

      if (this.disposed) {
        this.closeModels();
        this.releaseCamera();
        return;
      }

      // 3. rAF detection loop (capped ~30fps; skips while the tab is hidden).
      this.visibilityHandler = () => {
        this.lastFrameAt = 0;
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
      this.rafId = requestAnimationFrame((now) => this.detectLoop(now));

      // 4. Track-death watcher (integrity hardening): a camera track that
      // ENDS (device unplug / OS-level revoke) or goes MUTED (e.g. an OS
      // privacy kill-switch) leaves the <video> element showing its LAST
      // frame forever. Without this, every periodic verify would re-upload
      // that frozen frame of the right person and pass identity indefinitely
      // (only the suspected_replay advisory would hint at it). Degradation
      // mirrors the fatal loop error: onError → the pipeline's 'unavailable'
      // passthrough — lecturer-visible, never a silent pass.
      // NOTE: setting track.enabled = false from devtools does NOT fire
      // mute/ended (per spec) — that freeze is caught instead by the frame
      // pipeline: a black frame fails the server-side similarity vote →
      // FAIL row → paused, and blink recovery cannot pass on a dead feed.
      const track = stream.getVideoTracks()[0];
      if (track) {
        const onTrackGone = () => {
          if (!this.disposed && !this.errored) {
            console.warn("[face-tracker] video track ended/muted — degrading");
            this.emitError(new Error("video_track_dead"));
          }
        };
        track.addEventListener("ended", onTrackGone);
        track.addEventListener("mute", onTrackGone);
        // 'unmute' restores the live feed while the pipeline is still in its
        // bounded transport-failure window; nothing to do — the pipeline
        // surfaces 'unavailable' only after onError, which fires once.
      }
      console.info("[face-tracker] start() completed successfully!");
    } catch (err) {
      this.closeModels();
      this.releaseCamera();
      throw err;
    }
  }

  /**
   * Capture a base64 JPEG frame of the current `<video>` frame, subject to a
   * best-effort client quality gate. Returns null when the gate fails / the
   * video is not ready / the tab is hidden.
   */
  async captureFrame(): Promise<string | null> {
    if (this.disposed || !this.video) return null;
    if (typeof document !== "undefined" && document.hidden) return null;
    if (this.video.readyState < 2) return null;

    try {
      const canvas = this.ensureCanvas();
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      const vw = this.video.videoWidth || 640;
      const vh = this.video.videoHeight || 480;

      // Downscale to ≤640px so the JPEG stays small (≈30–60 KB base64).
      const scale = Math.min(1, CAPTURE_CANVAS_MAX / vw);
      canvas.width = Math.round(vw * scale);
      canvas.height = Math.round(vh * scale);
      ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);

      return canvas.toDataURL("image/jpeg", FRAME_JPEG_QUALITY);
    } catch {
      return null;
    }
  }

  /**
   * Compute perceived photometric luminance (0–255) specifically on the inner
   * face region (excluding background pixels to accurately catch backlit/dark faces).
   */
  private computeFaceLuminance(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    landmarks?: { x: number; y: number; z?: number }[] | null,
  ): number {
    try {
      const roi = getFacialSkinRegion(w, h, landmarks);
      if (roi.width <= 0 || roi.height <= 0) return 128;
      const imgData = ctx.getImageData(roi.x, roi.y, roi.width, roi.height);
      const data = imgData.data;
      let total = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 16) {
        total += calculatePhotometricLuminance(data[i], data[i + 1], data[i + 2]);
        count++;
      }
      return count > 0 ? total / count : 128;
    } catch {
      return 128;
    }
  }

  /** Read current framing & lighting health. */
  getFaceHealth(): { aligned: boolean; lightingOk: boolean; faceDetected: boolean } {
    const aligned = this.currentPose.faceDetected && this.currentPose.centered && Math.abs(this.currentPose.yaw) <= 25;
    return {
      aligned,
      lightingOk: this.currentLighting === "good",
      faceDetected: this.currentPose.faceDetected,
    };
  }

  /**
   * Adaptive duty cycle (see the tier constants in constants.ts): callers
   * slow the loop during sustained play and must restore FULL before any
   * liveness-critical state (gate/recovery run `waitForBlink`). Values are
   * clamped to [FACE_TRACK_FRAME_INTERVAL_MS, 200]; takes effect on the next
   * rAF tick (no restart needed — the loop reads the field each frame).
   */
  setFrameInterval(ms: number): void {
    this.frameIntervalMs = Math.min(
      Math.max(Math.round(ms), FACE_TRACK_FRAME_INTERVAL_MS),
      FRAME_INTERVAL_MAX_MS,
    );
  }

  /**
   * Capture a high-quality frame where face is present, centered, facing camera,
   * eyes are open, and lighting is optimal. Polling over a brief window prevents
   * transient blink/motion/lighting misfires.
   */
  async captureBestFrame(opts?: {
    maxWaitMs?: number;
    requireCentered?: boolean;
    requireOpenEyes?: boolean;
    requireGoodLighting?: boolean;
    requireIdealLighting?: boolean;
  }): Promise<string | null> {
    if (this.disposed || !this.video) return null;
    if (typeof document !== "undefined" && document.hidden) return null;
    if (this.video.readyState < 2) return null;

    const maxWaitMs = opts?.maxWaitMs ?? 1500;
    const requireCentered = opts?.requireCentered ?? true;
    const requireOpenEyes = opts?.requireOpenEyes ?? true;
    const requireGoodLighting = opts?.requireGoodLighting ?? true;
    const requireIdealLighting = opts?.requireIdealLighting ?? false;
    const startTime = Date.now();

    let bestFrame: string | null = null;
    let bestScore = -1;

    const minLum = requireIdealLighting ? 80 : 65;
    const maxLum = requireIdealLighting ? 195 : 215;

    while (Date.now() - startTime < maxWaitMs && !this.disposed) {
        const isEyesOpen =
          !requireOpenEyes ||
          (this.currentBlendshapes.left < 0.45 && this.currentBlendshapes.right < 0.45) ||
          Math.min(this.currentBlendshapes.left, this.currentBlendshapes.right) < 0.38;
        const isCentered = !requireCentered || this.currentPose.centered;
        const allowTurned = Math.abs(this.currentPose.yaw) >= 10;

        const baseScore = scoreFrameQuality({
          faceDetected: this.currentPose.faceDetected,
          centered: isCentered,
          yaw: this.currentPose.yaw,
          eyesOpen: isEyesOpen,
          lightingOk: false,
          allowTurned,
        });

        // If geometric quality is strong, verify lighting on canvas
        if (baseScore >= 70) {
          const frame = await this.captureFrame();
          if (frame && this.canvas) {
            const ctx = this.canvas.getContext("2d");
            if (ctx) {
              const lum = this.computeFaceLuminance(ctx, this.canvas.width, this.canvas.height, this.currentLandmarks);
              const goodLum = lum >= minLum && lum <= maxLum;
              const totalScore = scoreFrameQuality({
                faceDetected: this.currentPose.faceDetected,
                centered: isCentered,
                yaw: this.currentPose.yaw,
                eyesOpen: isEyesOpen,
                lightingOk: goodLum || (!requireGoodLighting && !requireIdealLighting),
                allowTurned,
              });

              if (totalScore >= 90) return frame;
              if (totalScore > bestScore) {
                bestScore = totalScore;
                bestFrame = frame;
              }
            }
          }
        }

      await new Promise((r) => setTimeout(r, 60));
    }

    return bestFrame ?? this.captureFrame();
  }

  private lastBlinkAt = 0;

  async waitForBlink(timeoutMs: number = LIVENESS_TIMEOUT_MS): Promise<"passed" | "failed"> {
    if (this.disposed) return "failed";
    if (typeof document !== "undefined" && document.hidden) return "failed";

    return new Promise<"passed" | "failed">((resolve) => {
      // A blink only counts when it happens DURING the challenge: the
      // BlinkDetector enforces a strict open→closed→open transition, and
      // crediting a natural blink from BEFORE the wait began would let a
      // student blink on cue just before triggering verification.
      const waiter = (outcome: "passed" | "failed") => {
        clearTimeout(timer);
        this.removeBlinkListener(waiter);
        if (outcome === "passed") {
          this.lastBlinkAt = 0;
          this.blinkDetector.reset();
        }
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        this.removeBlinkListener(waiter);
        this.blinkDetector.reset();
        resolve("failed");
      }, timeoutMs);
      this.waitForBlinkResolvers.push(waiter);
    });
  }

  private ensureCanvas(): HTMLCanvasElement {
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
    }
    return this.canvas;
  }

  private removeBlinkListener(
    onBlink: (outcome: "passed" | "failed") => void,
  ): void {
    this.waitForBlinkResolvers = this.waitForBlinkResolvers.filter((r) => r !== onBlink);
  }

  /**
   * Anti-replay head-turn challenge (integrity hardening): resolve 'passed'
   * when the student turns their head toward `side` (user-relative — positive
   * yaw = their left) and holds it past HEAD_TURN_YAW_MIN for
   * HEAD_TURN_SUSTAIN_MS. Mirrors `waitForBlink`'s resolver pattern; the
   * challenge object is created HERE (not at wait time by the caller) so only
   * turns occurring during the challenge count.
   */
  waitForHeadTurn(
    timeoutMs: number = HEAD_TURN_TIMEOUT_MS,
    side: TurnSide = "left",
  ): Promise<"passed" | "failed"> {
    if (this.disposed) return Promise.resolve("failed");
    if (typeof document !== "undefined" && document.hidden) return Promise.resolve("failed");
    // A fresh challenge per wait — a turn made BEFORE the wait began must
    // never resolve it (same posture as waitForBlink's during-challenge rule).
    this.turnChallenge = new HeadTurnChallenge(side);
    this.turnChallengePrevSampleMs = null;
    return new Promise<"passed" | "failed">((resolve) => {
      const waiter = (outcome: "passed" | "failed") => {
        clearTimeout(timer);
        this.removeTurnListener(waiter);
        this.turnChallenge = null;
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        this.removeTurnListener(waiter);
        this.turnChallenge = null;
        resolve("failed");
      }, timeoutMs);
      this.waitForTurnResolvers.push(waiter);
    });
  }

  private removeTurnListener(
    onTurn: (outcome: "passed" | "failed") => void,
  ): void {
    this.waitForTurnResolvers = this.waitForTurnResolvers.filter((r) => r !== onTurn);
  }

  private resolveAllTurns(outcome: "passed" | "failed"): void {
    const resolvers = this.waitForTurnResolvers;
    this.waitForTurnResolvers = [];
    this.turnChallenge = null;
    for (const r of resolvers) r(outcome);
  }

  private handleBlinkObserved(): void {
    this.lastBlinkAt = Date.now();
    const resolvers = this.waitForBlinkResolvers;
    this.waitForBlinkResolvers = [];
    for (const r of resolvers) r("passed");
  }

  stop(): void {
    this.disposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.loadedMetadataHandler) {
      this.video.onloadedmetadata = null;
      this.loadedMetadataHandler = null;
    }
    if (this.loadedMetadataTimer) {
      clearTimeout(this.loadedMetadataTimer);
      this.loadedMetadataTimer = null;
    }
    this.closeModels();
    this.releaseCamera();
    this.canvas = null;
    // Dispose must NOT settle pending liveness waits as "passed": an unmount
    // mid-challenge resolving "passed" would let recoverFlow treat a blink
    // that never happened as verified and un-pause the session. Fail them.
    const resolvers = this.waitForBlinkResolvers;
    this.waitForBlinkResolvers = [];
    for (const r of resolvers) r("failed");
    this.resolveAllTurns("failed");
  }

  private releaseCamera(): void {
    if (this.cameraToken !== null) {
      releaseCameraStream(this.cameraToken);
      this.cameraToken = null;
    }
    if (this.sharedStream && this.video.srcObject === this.sharedStream) {
      this.video.srcObject = null;
    }
    this.sharedStream = null;
  }

  private detectLoop(now: number): void {
    if (this.disposed) return;
    try {
      if (document.hidden) {
        this.rafId = requestAnimationFrame((t) => this.detectLoop(t));
        return;
      }
      if (now - this.lastFrameAt >= this.frameIntervalMs) {
        this.lastFrameAt = now;
        if (
          this.landmarker &&
          this.video.readyState >= 2 &&
          this.video.videoWidth > 0 &&
          this.video.videoHeight > 0
        ) {
          const results = this.landmarker.detectForVideo(this.video, now);
          let yaw = 0;
          let pitch = 0;
          let centered = false;
          let faceDetected = false;
          const facesSeen = results.faceLandmarks?.length ?? 0;
          const landmarks = results.faceLandmarks?.[0];
          if (landmarks && landmarks.length > 0) {
            faceDetected = true;
            this.currentLandmarks = landmarks;
            const nose = landmarks[1];
            const leftCheek = landmarks[234];
            const rightCheek = landmarks[454];
            if (nose && leftCheek && rightCheek) {
              const span = rightCheek.x - leftCheek.x;
              if (span > 0.01) {
                const ratio = (nose.x - leftCheek.x) / span;
                this.lastRawRatio = ratio;
                // USER-space yaw RELATIVE to the user's calibrated neutral
                // (or the geometric midpoint when uncalibrated): POSITIVE =
                // the user turns toward THEIR OWN left, negative = their
                // right. In the raw camera image a left turn moves the nose
                // toward the image-right cheek (ratio rises), so no mirror
                // negation here — the mirrored preview (`scale-x-[-1]`)
                // already shows that same turn drifting toward the left edge
                // of the screen, matching the "turn LEFT" instruction. All
                // other consumers (attention advisories, quality score,
                // getFaceHealth, server pose gate) use |yaw|; the only
                // signed consumers are the enroll client's Left/Right gates,
                // which mean USER left/right.
                const neutral = this.ratioBaseline ?? 0.5;
                yaw = Math.round((ratio - neutral) * 100);
              }
              // Pitch proxy (look-away advisory): nose drop as a fraction of
              // the forehead→chin span, RELATIVE to the same neutral pose as
              // yaw. In image space y grows DOWNWARD, so a head-down tilt
              // moves the nose toward the chin — POSITIVE = head down (a lap
              // glance), negative = chin up. Reuses pitchBaseline via the
              // same trimmed-mean calibration as yaw.
              const forehead = landmarks[10];
              const chin = landmarks[152];
              if (forehead && chin) {
                const vSpan = chin.y - forehead.y;
                if (vSpan > 0.01) {
                  const vRatio = (nose.y - forehead.y) / vSpan;
                  this.lastRawPitchRatio = vRatio;
                  const pitchNeutral = this.pitchBaseline ?? 0.5;
                  pitch = Math.round((vRatio - pitchNeutral) * 100);
                } else {
                  // Degenerate vertical span (extreme roll) — drop the stale
                  // sample so a later calibration never averages it in.
                  this.lastRawPitchRatio = null;
                }
              }
              centered = nose.x >= 0.30 && nose.x <= 0.70 && nose.y >= 0.20 && nose.y <= 0.80;
            }
          } else {
            this.currentLandmarks = null;
            this.lastRawRatio = null;
            this.lastRawPitchRatio = null;
          }
          const isTurned = Math.abs(yaw) >= 10;
          this.feedLiveness(results, isTurned);
          let lighting: "good" | "too_dark" | "too_bright" = this.currentLighting;
          if (faceDetected && now - this.lastLuminanceSampleAt >= LUMINANCE_SAMPLE_INTERVAL_MS) {
            this.lastLuminanceSampleAt = now;
            const canvas = this.ensureCanvas();
            const ctx = canvas.getContext("2d");
            if (ctx) {
              const vw = this.video.videoWidth || 640;
              const vh = this.video.videoHeight || 480;
              const scale = Math.min(1, CAPTURE_CANVAS_MAX / vw);
              canvas.width = Math.round(vw * scale);
              canvas.height = Math.round(vh * scale);
              ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
              const lum = this.computeFaceLuminance(ctx, canvas.width, canvas.height, landmarks);
              lighting = classifyLighting(lum, "ideal");
              this.currentLighting = lighting;
            }
          }
          const pose: LivePose = { yaw, pitch, centered, faceDetected, lighting, facesSeen };
          this.currentPose = pose;
          this.loopErrorCount = 0;
          // Feed the active head-turn challenge BEFORE the pose listeners so
          // the wait resolves in the same frame the sustained turn completes.
          if (this.turnChallenge) {
            const prevMs = this.turnChallengePrevSampleMs;
            this.turnChallengePrevSampleMs = now;
            if (this.turnChallenge.feed({ yaw, faceDetected }, now, prevMs)) {
              this.resolveAllTurns("passed");
            }
          }
          if (this.poseListeners.size > 0) {
            for (const listener of this.poseListeners) {
              listener(pose);
            }
          }
        }
      }
      this.rafId = requestAnimationFrame((t) => this.detectLoop(t));
    } catch (err) {
      this.loopErrorCount++;
      if (this.loopErrorCount < 3 && !this.disposed) {
        console.warn(`[face-tracker] detection loop transient error (${this.loopErrorCount}/3):`, err);
        this.rafId = requestAnimationFrame((t) => this.detectLoop(t));
        return;
      }
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.releaseCamera();
      // Surface the death — a silently frozen loop bricks blink recovery and
      // keeps recording verify fails against the student.
      console.error("[face-tracker] detection loop failed:", err);
      this.emitError(err);
    }
  }

  /** Feed the per-eye blendshape values (eyeBlinkLeft/Right) to the BlinkDetector. */
  private feedLiveness(
    results: {
      faceBlendshapes?: { categories?: { categoryName?: string; score?: number }[] }[];
    },
    isTurned = false,
  ): void {
    const cats = results.faceBlendshapes?.[0]?.categories ?? [];
    let left = 0;
    let right = 0;
    for (const c of cats) {
      if (c.categoryName === "eyeBlinkLeft") left = c.score ?? 0;
      else if (c.categoryName === "eyeBlinkRight") right = c.score ?? 0;
    }
    this.currentBlendshapes = { left, right };
    const updateResult = this.blinkDetector.update(left, right, isTurned);
    if (updateResult === "passed") {
      this.handleBlinkObserved();
    } else if (updateResult === "failed") {
      // Re-arm immediately so the continuous live stream keeps seeking a clean blink transition
      this.blinkDetector.reset();
    }
  }

  private async loadVision(): Promise<VisionModule> {
    if (!cachedVision) {
      // `webpackIgnore` keeps Next/Turbopack from bundling or rewriting the URL;
      // the browser fetches the static file from `public/mediapipe/`.
      cachedVision = (await import(
        /* webpackIgnore: true */
        BLINK_LANDMARKER_URL
      )) as unknown as VisionModule;
    }
    return cachedVision;
  }

  private async createLandmarker(vision: VisionModule): Promise<MediaPipeFaceLandmarker> {
    if (!cachedFileset) {
      cachedFileset = await vision.FilesetResolver.forVisionTasks(WASM_ROOT);
    }
    const base = {
      baseOptions: {
        modelAssetPath: FACE_LANDMARKER_MODEL_URL,
        delegate: "CPU" as const,
      },
      runningMode: "VIDEO" as const,
      // TWO faces (not one): the tracker must be able to SEE a second person
      // — the pose stream exposes `facesSeen`, which feeds the lecturer-
      // visible `second_face` advisory. One face stays the blink/embedding
      // subject (landmarks[0] = the largest/primary face).
      numFaces: 2,
      outputFaceBlendshapes: true,
    };
    return vision.FaceLandmarker.createFromOptions(cachedFileset, base);
  }

  private closeModels(): void {
    try {
      this.landmarker?.close();
    } catch {
      // MediaPipe close() may throw if the graph is already torn down.
    }
    this.landmarker = null;
  }
}
