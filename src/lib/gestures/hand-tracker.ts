import type { HandFrame, IHandTracker, Landmark } from "./types";
import { landmarksToHandFrame } from "./finger-count";
import {
  acquireCameraStream,
  releaseCameraStream,
  resolveStream,
} from "@/lib/vision/camera";
import {
  calculatePhotometricLuminance,
  classifyLighting,
  getHandPalmRegion,
} from "@/lib/face/quality";

/**
 * Browser-only MediaPipe glue (Phase 6).
 *
 * This module is CLIENT-SAFE: there is NO top-level browser access — every
 * `document`/`navigator`/`window`/MediaPipe reference lives inside the class,
 * so the module parses under Vitest (it is never executed there; see the
 * 0-threshold coverage key in `vitest.config.ts`). The pure logic it mirrors
 * lives in `finger-count.ts` (Node-unit-tested); this file is the real
 * end-to-end seam exercised only by manual smoke (TESTING §7.1) + the E2E
 * fake-tracker path.
 *
 * Handedness/overlay contract:
 *  - The tracker processes the RAW (non-mirrored) video so MediaPipe's
 *    handedness matches the standard heuristic (thumb x-comparison).
 *  - The canvas overlay mirrors BOTH the video and the landmark x-coordinates
 *    (`1 - l.x`) so the skeleton stays aligned with the flipped preview. (The
 *    reference sample's overlay is actually flipped — this is the port fix.)
 *
 * P7 note: hand-loss detection pauses when the tab is hidden (the rAF loop
 * stops). Harmless in P6 (client-side only), but P7's server-side `paused`
 * must add a `visibilitychange`/`blur` fallback so a student can't tab away to
 * avoid re-verification.
 *
 * No server logic here — this is purely the student's own camera feed.
 */

export const MEDIAPIPE_BUNDLE_URL = "/mediapipe/vision_bundle.mjs";
export const MEDIAPIPE_WASM_ROOT = "/mediapipe/wasm";
export const HAND_MODEL_URL = "/models/hand_landmarker.task";

const CAMERA_WIDTH_MAX = 640;
const CAMERA_HEIGHT_MAX = 480;
const FRAME_INTERVAL_MS = 33; // ~30fps cap

type MediaPipeHandLandmarker = {
  detectForVideo(video: HTMLVideoElement, timestamp: number): {
    landmarks?: Landmark[][];
    handedness?: { categoryName?: string }[][];
  };
  close(): void;
};

type VisionModule = {
  FilesetResolver: {
    forVisionTasks(wasmRoot: string): Promise<unknown>;
  };
  HandLandmarker: {
    createFromOptions(vision: unknown, options: unknown): Promise<MediaPipeHandLandmarker>;
  };
};

let cachedHandVision: VisionModule | null = null;
let cachedHandFileset: unknown = null;

export class HandLandmarkerTracker implements IHandTracker {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private landmarker: MediaPipeHandLandmarker | null = null;
  private cameraToken: number | null = null;
  private stream: MediaStream | null = null;
  private rafId: number | null = null;
  private disposed = false;
  private lastFrameAt = 0;
  private visibilityHandler: (() => void) | null = null;
  private loadedMetadataHandler: (() => void) | null = null;
  private loadedMetadataTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: { video: HTMLVideoElement; canvas: HTMLCanvasElement }) {
    this.video = opts.video;
    this.canvas = opts.canvas;
  }

  async start(
    onFrame: (frame: HandFrame) => void,
    onError?: (err: Error) => void,
  ): Promise<void> {
    // Start loading Vision + Landmarker concurrently with camera acquisition
    const modelPromise = (async () => {
      try {
        const vision = await this.loadVision();
        if (this.disposed) return null;
        return await this.createLandmarker(vision);
      } catch (err) {
        console.error("[hand-tracker] failed to create landmarker:", err);
        throw err;
      }
    })();

    // 1. Camera via the SHARED stream manager (Phase 7) — this module is NOT
    //    the track-stop owner. `stop()` releases the ref; camera.ts stops the
    //    tracks only when the last consumer releases.
    this.cameraToken = await acquireCameraStream();
    if (this.disposed) {
      releaseCameraStream(this.cameraToken);
      this.cameraToken = null;
      return;
    }
    const stream = resolveStream(this.cameraToken);

    this.stream = stream;
    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.playsInline = true;

    if (this.video.readyState < 1) {
      await Promise.race([
        new Promise<void>((resolve) => {
          this.loadedMetadataHandler = () => resolve();
          this.video.onloadedmetadata = this.loadedMetadataHandler;
        }),
        new Promise<void>((resolve) => {
          this.loadedMetadataTimer = setTimeout(resolve, 2000);
        }),
      ]);
      if (this.loadedMetadataTimer) {
        clearTimeout(this.loadedMetadataTimer);
        this.loadedMetadataTimer = null;
      }
    }

    if (this.disposed) {
      this.releaseCamera();
      return;
    }

    try {
      await Promise.race([
        this.video.play(),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    } catch {
      // Non-fatal if playback already underway
    }

    const w = this.video.videoWidth || CAMERA_WIDTH_MAX;
    const h = this.video.videoHeight || CAMERA_HEIGHT_MAX;
    this.canvas.width = w;
    this.canvas.height = h;

    // 2. Await concurrent model creation
    this.landmarker = await modelPromise;

    if (this.disposed) {
      this.closeLandmarker();
      this.releaseCamera();
      return;
    }

    // 3. rAF detection loop (capped ~30fps; skips while the tab is hidden).
    this.lastFrameAt = 0;
    this.visibilityHandler = () => {
      // On tab return, `video.readyState` may be stale — the loop re-checks
      // `readyState >= 2` every frame anyway.
      this.lastFrameAt = 0;
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.rafId = requestAnimationFrame((now) => this.detectLoop(now, onFrame, onError));
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
    this.closeLandmarker();
    this.releaseCamera();
    const ctx = this.canvas.getContext("2d");
    ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  bindDOMElements(elements: { video: HTMLVideoElement; canvas: HTMLCanvasElement }): void {
    this.video = elements.video;
    this.canvas = elements.canvas;
    if (this.stream && this.video.srcObject !== this.stream) {
      this.video.srcObject = this.stream;
      this.video.muted = true;
      this.video.playsInline = true;
      void this.video.play().catch(() => {});
    }
    const w = this.video.videoWidth || CAMERA_WIDTH_MAX;
    const h = this.video.videoHeight || CAMERA_HEIGHT_MAX;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  private releaseCamera(): void {
    if (this.cameraToken !== null) {
      // camera.ts is the ONLY place tracks stop (refcounted; last release
      // stops the shared stream). NEVER call track.stop() here.
      releaseCameraStream(this.cameraToken);
      this.cameraToken = null;
    }
    if (this.stream && this.video.srcObject === this.stream) {
      this.video.srcObject = null;
    }
    this.stream = null;
  }

  private async loadVision(): Promise<VisionModule> {
    if (!cachedHandVision) {
      cachedHandVision = (await import(
        /* webpackIgnore: true */
        MEDIAPIPE_BUNDLE_URL
      )) as unknown as VisionModule;
    }
    return cachedHandVision;
  }

  private async createLandmarker(vision: VisionModule) {
    if (!cachedHandFileset) {
      cachedHandFileset = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);
    }
    const base = {
      baseOptions: {
        modelAssetPath: HAND_MODEL_URL,
        delegate: "GPU" as const,
      },
      runningMode: "VIDEO" as const,
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    };
    try {
      return await vision.HandLandmarker.createFromOptions(cachedHandFileset, base);
    } catch {
      return await vision.HandLandmarker.createFromOptions(cachedHandFileset, {
        ...base,
        baseOptions: { ...base.baseOptions, delegate: "CPU" as const },
      });
    }
  }

  private detectLoop(
    now: number,
    onFrame: (frame: HandFrame) => void,
    onError?: (err: Error) => void,
  ): void {
    if (this.disposed) return;
    try {
      if (document.hidden) {
        this.rafId = requestAnimationFrame((t) => this.detectLoop(t, onFrame, onError));
        return;
      }
      if (now - this.lastFrameAt >= FRAME_INTERVAL_MS) {
        this.lastFrameAt = now;
        if (this.landmarker && this.video.readyState >= 2) {
          const results = this.landmarker.detectForVideo(this.video, now);
          this.renderOverlay(results.landmarks);
          const frame = landmarksToHandFrame(results);
          const ctx = this.canvas.getContext("2d");
          if (ctx) {
            frame.lighting = this.computeHandLuminance(
              ctx,
              this.canvas.width,
              this.canvas.height,
              results.landmarks?.[0],
            );
          }
          onFrame(frame);
        }
      }
      this.rafId = requestAnimationFrame((t) => this.detectLoop(t, onFrame, onError));
    } catch (err) {
      // A runtime detection error must not freeze the camera silently: cancel
      // the rAF and surface the error to the component (via `onError`), which
      // flips gestures off and shows the notice. The loop does NOT rethrow —
      // `start()` resolved before any frame ran, so a rethrow would become an
      // unhandled `window.onerror` that the boot race can never catch.
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Compute perceived photometric luminance on the palm / hand bounding box to
   * detect underexposed or overexposed hand gestures.
   */
  private computeHandLuminance(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    landmarks?: Landmark[] | null,
  ): "good" | "too_dark" | "too_bright" {
    try {
      const roi = getHandPalmRegion(w, h, landmarks);
      if (roi.width <= 0 || roi.height <= 0) return "good";
      const imgData = ctx.getImageData(roi.x, roi.y, roi.width, roi.height);
      const data = imgData.data;
      let total = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 16) {
        total += calculatePhotometricLuminance(data[i], data[i + 1], data[i + 2]);
        count++;
      }
      const lum = count > 0 ? total / count : 128;
      return classifyLighting(lum, "ideal");
    } catch {
      return "good";
    }
  }

  /** Mirrored overlay: flip x (`1 - l.x`) so the skeleton aligns with the preview. */
  private renderOverlay(landmarks?: Landmark[][]): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.scale(-1, 1);
    ctx.translate(-w, 0);
    ctx.drawImage(this.video, 0, 0, w, h);
    ctx.restore();

    const lm = landmarks?.[0];
    if (!lm) return;
    ctx.fillStyle = "#00d4ff";
    for (const l of lm) {
      ctx.beginPath();
      ctx.arc((1 - l.x) * w, l.y * h, 5, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  private closeLandmarker(): void {
    try {
      this.landmarker?.close();
    } catch {
      // MediaPipe close() may throw if the graph is already torn down.
    }
    this.landmarker = null;
  }
}
