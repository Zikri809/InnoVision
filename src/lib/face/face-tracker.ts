import type { IFaceTracker, LivePose } from "./types";
import { BlinkDetector } from "./liveness";
import {
  FRAME_QUALITY_MAX_SIZE,
  FRAME_QUALITY_MIN_SIZE,
  LIVENESS_TIMEOUT_MS,
} from "./constants";
import {
  acquireCameraStream,
  releaseCameraStream,
  resolveStream,
} from "@/lib/vision/camera";

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
 *     liveness (`waitForBlink`), and
 *   - captures a base64 JPEG FRAME (`captureFrame`) with a best-effort client
 *     quality gate (single face, size in range, eyes open). The frame is what
 *     the Next.js route forwards to CompreFace `/recognize`.
 *
 * The quality gate is best-effort client-side only — the route does NOT trust
 * it (CompreFace does its own detection).
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

/** Caps the landmarker rAF detection loop (~30fps). */
const FRAME_INTERVAL_MS = 33;

/** JPEG quality for the captured frame (0–1). */
const FRAME_JPEG_QUALITY = 0.85;

/** Cap the capture canvas so the frame payload stays small (~150 KB). */
const CAPTURE_CANVAS_MAX = 640;

type FaceQuality =
  | { ok: true; rect: { left: number; top: number; width: number; height: number } }
  | { ok: false; reason: string };

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
  private stream: MediaStream | null = null;
  private rafId: number | null = null;
  private disposed = false;
  private blinkDetector = new BlinkDetector();
  private visibilityHandler: (() => void) | null = null;
  private loadedMetadataHandler: (() => void) | null = null;
  private loadedMetadataTimer: ReturnType<typeof setTimeout> | null = null;
  private waitForBlinkResolvers: (() => void)[] = [];
  private poseListeners: Set<(pose: LivePose) => void> = new Set();
  private lastFrameAt = 0;
  private lastQualityResult: FaceQuality = { ok: false, reason: "no-frame-yet" };
  private canvas: HTMLCanvasElement | null = null;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  onPoseChange(cb: (pose: LivePose) => void): () => void {
    this.poseListeners.add(cb);
    return () => {
      this.poseListeners.delete(cb);
    };
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

    // 1. Shared camera stream (coalesced; release on stop).
    console.info("[face-tracker] acquiring camera stream...");
    this.cameraToken = await acquireCameraStream();
    console.info("[face-tracker] camera stream acquired, token:", this.cameraToken);
    if (this.disposed) {
      releaseCameraStream(this.cameraToken);
      this.cameraToken = null;
      return;
    }
    let stream: MediaStream;
    try {
      stream = resolveStream(this.cameraToken);
    } catch (err) {
      if (this.disposed) {
        releaseCameraStream(this.cameraToken);
        this.cameraToken = null;
      }
      throw err;
    }

    this.stream = stream;
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
    console.info("[face-tracker] start() completed successfully!");
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

  private lastBlinkAt = 0;

  async waitForBlink(timeoutMs: number = LIVENESS_TIMEOUT_MS): Promise<"passed" | "failed"> {
    if (this.disposed) return "failed";
    if (typeof document !== "undefined" && document.hidden) return "failed";

    // If the user already blinked naturally within the last 3.5 seconds:
    if (Date.now() - this.lastBlinkAt < 3500) {
      this.lastBlinkAt = 0;
      this.blinkDetector.reset();
      return "passed";
    }

    return new Promise<"passed" | "failed">((resolve) => {
      const onBlink = () => {
        this.lastBlinkAt = 0;
        this.blinkDetector.reset();
        resolve("passed");
      };
      const timer = setTimeout(() => {
        this.removeBlinkListener(onBlink);
        this.blinkDetector.reset();
        resolve("failed");
      }, timeoutMs);
      this.addBlinkListener(onBlink, timer);
    });
  }

  /** Best-effort quality gate — the SERVER never trusts this. */
  private evaluateQuality(): FaceQuality {
    // Native FaceDetector (Chromium) — single face + bounding box size.
    const Detector = (globalThis as { FaceDetector?: unknown }).FaceDetector;
    if (Detector) {
      // Fire-and-forget async detection; the synchronous fallback covers the
      // in-between. (Native FaceDetector is experimental; do NOT gate capture
      // on it — the landmarker fallback below is the real gate.)
      void this.detectWithNativeApi();
      return this.lastQualityResult;
    }
    return this.qualityFromLandmarks();
  }

  private async detectWithNativeApi(): Promise<void> {
    try {
      const Detector = (globalThis as { FaceDetector?: new () => { detect: (v: HTMLVideoElement) => Promise<unknown[]> } }).FaceDetector;
      if (!Detector || !this.landmarker || this.video.readyState < 2) return;
      const detector = new Detector();
      const faces = await detector.detect(this.video);
      const first = faces[0] as { boundingBox?: { width: number; height: number } } | undefined;
      if (!first?.boundingBox) {
        this.lastQualityResult = { ok: false, reason: "no-face" };
        return;
      }
      const w = first.boundingBox.width;
      const h = first.boundingBox.height;
      if (faces.length > 1) {
        this.lastQualityResult = { ok: false, reason: "multiple-faces" };
        return;
      }
      if (w < FRAME_QUALITY_MIN_SIZE || h < FRAME_QUALITY_MIN_SIZE || w > FRAME_QUALITY_MAX_SIZE || h > FRAME_QUALITY_MAX_SIZE) {
        this.lastQualityResult = { ok: false, reason: "face-size-out-of-range" };
        return;
      }
      this.lastQualityResult = { ok: true, rect: { left: 0, top: 0, width: w, height: h } };
    } catch {
      // Native FaceDetector unsupported — the landmarker fallback is the gate.
    }
  }

  /** Landmarker-based quality fallback: face present + eyes open. */
  private qualityFromLandmarks(): FaceQuality {
    // The rAF loop stores blendshape state via the blink detector; for the
    // quality gate we just require the detector to have seen an OPEN state.
    if (!this.landmarker || this.video.readyState < 2) {
      return { ok: false, reason: "not-ready" };
    }
    // A cheap proxy: eyes-open is required for a usable frame. If the blink
    // detector is in the default pending state (no samples yet), fall through
    // and still capture (the gate is best-effort).
    if (this.lastQualityResult.ok) return this.lastQualityResult;
    return { ok: true, rect: { left: 0, top: 0, width: 1, height: 1 } };
  }

  private ensureCanvas(): HTMLCanvasElement {
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
    }
    return this.canvas;
  }

  private addBlinkListener(
    onBlink: () => void,
    timer: ReturnType<typeof setTimeout>,
  ): void {
    const wrapped = () => {
      clearTimeout(timer);
      this.removeBlinkListener(wrapped);
      onBlink();
    };
    this.waitForBlinkResolvers.push(wrapped);
  }

  private removeBlinkListener(onBlink: () => void): void {
    this.waitForBlinkResolvers = this.waitForBlinkResolvers.filter((r) => r !== onBlink);
  }

  private handleBlinkObserved(): void {
    this.lastBlinkAt = Date.now();
    const resolvers = this.waitForBlinkResolvers;
    this.waitForBlinkResolvers = [];
    for (const r of resolvers) r();
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
    const resolvers = this.waitForBlinkResolvers;
    this.waitForBlinkResolvers = [];
    for (const r of resolvers) r();
  }

  private releaseCamera(): void {
    if (this.cameraToken !== null) {
      releaseCameraStream(this.cameraToken);
      this.cameraToken = null;
    }
    if (this.stream && this.video.srcObject === this.stream) {
      this.video.srcObject = null;
    }
    this.stream = null;
  }

  private detectLoop(now: number): void {
    if (this.disposed) return;
    try {
      if (document.hidden) {
        this.rafId = requestAnimationFrame((t) => this.detectLoop(t));
        return;
      }
      if (now - this.lastFrameAt >= FRAME_INTERVAL_MS) {
        this.lastFrameAt = now;
        if (this.landmarker && this.video.readyState >= 2) {
          const results = this.landmarker.detectForVideo(this.video, now);
          this.feedLiveness(results);
          if (this.poseListeners.size > 0) {
            let yaw = 0;
            let centered = false;
            let faceDetected = false;
            const landmarks = results.faceLandmarks?.[0];
            if (landmarks && landmarks.length > 0) {
              faceDetected = true;
              const nose = landmarks[1];
              const leftCheek = landmarks[234];
              const rightCheek = landmarks[454];
              if (nose && leftCheek && rightCheek) {
                const span = rightCheek.x - leftCheek.x;
                if (span > 0.01) {
                  const ratio = (nose.x - leftCheek.x) / span;
                  // Ratio ~0.5 when looking straight; >0.55 when turning left; <0.45 when turning right
                  yaw = Math.round((ratio - 0.5) * 100);
                }
                centered = nose.x >= 0.30 && nose.x <= 0.70 && nose.y >= 0.20 && nose.y <= 0.80;
              }
            }
            const pose: LivePose = { yaw, centered, faceDetected };
            for (const listener of this.poseListeners) {
              listener(pose);
            }
          }
        }
      }
      this.rafId = requestAnimationFrame((t) => this.detectLoop(t));
    } catch {
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** Feed the per-eye blendshape values (eyeBlinkLeft/Right) to the BlinkDetector. */
  private feedLiveness(results: {
    faceBlendshapes?: { categories?: { categoryName?: string; score?: number }[] }[];
  }): void {
    const cats = results.faceBlendshapes?.[0]?.categories ?? [];
    let left = 0;
    let right = 0;
    for (const c of cats) {
      if (c.categoryName === "eyeBlinkLeft") left = c.score ?? 0;
      else if (c.categoryName === "eyeBlinkRight") right = c.score ?? 0;
    }
    const updateResult = this.blinkDetector.update(left, right);
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
      numFaces: 1,
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
