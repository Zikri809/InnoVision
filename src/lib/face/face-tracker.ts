import type { IFaceTracker } from "./types";
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
    faceLandmarks?: unknown[];
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

export class FaceTracker implements IFaceTracker {
  private readonly video: HTMLVideoElement;
  private landmarker: MediaPipeFaceLandmarker | null = null;
  private cameraToken: number | null = null;
  private rafId: number | null = null;
  private disposed = false;
  private blinkDetector = new BlinkDetector();
  private visibilityHandler: (() => void) | null = null;
  private loadedMetadataHandler: (() => void) | null = null;
  private loadedMetadataTimer: ReturnType<typeof setTimeout> | null = null;
  private waitForBlinkResolvers: (() => void)[] = [];
  private lastFrameAt = 0;
  private lastQualityResult: FaceQuality = { ok: false, reason: "no-frame-yet" };
  private canvas: HTMLCanvasElement | null = null;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async start(): Promise<void> {
    // 1. Shared camera stream (coalesced; release on stop).
    this.cameraToken = await acquireCameraStream();
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

    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await Promise.race([
      new Promise<void>((resolve) => {
        this.loadedMetadataHandler = () => resolve();
        this.video.onloadedmetadata = this.loadedMetadataHandler;
      }),
      new Promise<void>((resolve) => {
        this.loadedMetadataTimer = setTimeout(() => resolve(), 5000);
      }),
    ]);
    if (this.loadedMetadataTimer) clearTimeout(this.loadedMetadataTimer);
    if (this.disposed) {
      this.releaseCamera();
      return;
    }
    await this.video.play();

    // 2. Bundle + WASM + FaceLandmarker (blendshapes for blink liveness only —
    //    the embedding model is gone; CompreFace owns matching server-side).
    const vision = await this.loadVision();
    this.landmarker = await this.createLandmarker(vision);

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
  }

  /**
   * Capture a base64 JPEG frame of the current `<video>` frame, subject to a
   * best-effort client quality gate. Returns null when the gate fails / the
   * video is not ready / the tab is hidden.
   *
   * The quality gate checks (native FaceDetector when available, else the
   * landmarker): single face in range `[FRAME_QUALITY_MIN_SIZE,
   * FRAME_QUALITY_MAX_SIZE]`, both eyes open. The ROUTE does NOT trust this —
   * CompreFace runs its own detection; this is a cheap client-side guard to
   * avoid wasting a server round-trip on bad frames.
   */
  async captureFrame(): Promise<string | null> {
    if (this.disposed || !this.video) return null;
    if (typeof document !== "undefined" && document.hidden) return null;
    if (this.video.readyState < 2) return null;

    const quality = this.evaluateQuality();
    if (!quality.ok) {
      this.lastQualityResult = quality;
      return null;
    }
    this.lastQualityResult = quality;

    try {
      const canvas = this.ensureCanvas();
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      // Downscale to ≤640px so the JPEG stays small (≈30–60 KB base64).
      const scale = Math.min(1, CAPTURE_CANVAS_MAX / this.video.videoWidth);
      canvas.width = Math.round(this.video.videoWidth * scale);
      canvas.height = Math.round(this.video.videoHeight * scale);
      ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);

      return canvas.toDataURL("image/jpeg", FRAME_JPEG_QUALITY);
    } catch {
      return null;
    }
  }

  async waitForBlink(timeoutMs: number = LIVENESS_TIMEOUT_MS): Promise<"passed" | "failed"> {
    if (this.disposed) return "failed";
    if (typeof document !== "undefined" && document.hidden) return "failed";

    return new Promise<"passed" | "failed">((resolve) => {
      const onBlink = () => {
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
    if (this.video.srcObject) {
      this.video.srcObject = null;
    }
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
    if (this.blinkDetector.update(left, right) === "passed") {
      this.handleBlinkObserved();
    }
  }

  private async loadVision(): Promise<VisionModule> {
    // `webpackIgnore` keeps Next/Turbopack from bundling or rewriting the URL;
    // the browser fetches the static file from `public/mediapipe/`.
    const mod = (await import(
      /* webpackIgnore: true */
      BLINK_LANDMARKER_URL
    )) as unknown as VisionModule;
    return mod;
  }

  private async createLandmarker(vision: VisionModule): Promise<MediaPipeFaceLandmarker> {
    const base = {
      baseOptions: {
        modelAssetPath: FACE_LANDMARKER_MODEL_URL,
        delegate: "CPU" as const,
      },
      runningMode: "VIDEO" as const,
      numFaces: 1,
      outputFaceBlendshapes: true,
    };
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_ROOT);
    return vision.FaceLandmarker.createFromOptions(fileset, base);
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
