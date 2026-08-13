import type { HandFrame, IHandTracker, Landmark } from "./types";
import { landmarksToHandFrame } from "./finger-count";

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

export class HandLandmarkerTracker implements IHandTracker {
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private landmarker: MediaPipeHandLandmarker | null = null;
  private rafId: number | null = null;
  private disposed = false;
  private lastFrameAt = 0;
  private visibilityHandler: (() => void) | null = null;
  private loadedMetadataHandler: (() => void) | null = null;

  constructor(opts: { video: HTMLVideoElement; canvas: HTMLCanvasElement }) {
    this.video = opts.video;
    this.canvas = opts.canvas;
  }

  async start(
    onFrame: (frame: HandFrame) => void,
    onError?: (err: Error) => void,
  ): Promise<void> {
    // 1. Camera (guarded; max-bounded resolution). `video.play()` is awaited
    //    and the canvas backing store is sized to the real stream.
    const stream = await this.acquireCamera();
    if (this.disposed) {
      stopStreamTracks(stream);
      return;
    }

    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await new Promise<void>((resolve) => {
      this.loadedMetadataHandler = () => resolve();
      this.video.onloadedmetadata = this.loadedMetadataHandler;
    });
    if (this.disposed) {
      stopStreamTracks(stream);
      return;
    }
    await this.video.play();

    const w = this.video.videoWidth || CAMERA_WIDTH_MAX;
    const h = this.video.videoHeight || CAMERA_HEIGHT_MAX;
    this.canvas.width = w;
    this.canvas.height = h;

    // 2. Bundle + WASM + model (GPU → CPU fallback).
    const vision = await this.loadVision();
    this.landmarker = await this.createLandmarker(vision);

    if (this.disposed) {
      this.closeLandmarker();
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
    this.closeLandmarker();
    const stream = this.video.srcObject as MediaStream | null;
    if (stream) {
      stopStreamTracks(stream);
      this.video.srcObject = null;
    }
    const ctx = this.canvas.getContext("2d");
    ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private async acquireCamera(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support webcam access.");
    }
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { max: CAMERA_WIDTH_MAX, ideal: CAMERA_WIDTH_MAX },
        height: { max: CAMERA_HEIGHT_MAX, ideal: CAMERA_HEIGHT_MAX },
      },
    });
  }

  private async loadVision(): Promise<VisionModule> {
    // `webpackIgnore` keeps Next/Turbopack from bundling or rewriting the URL;
    // the browser fetches the static file from `public/mediapipe/`. The module
    // is typed by the ambient declaration `src/types/mediapipe-url.d.ts`, which
    // mirrors the exact-pinned `@mediapipe/tasks-vision` package; the local
    // structural `VisionModule` below narrows it to just the two members this
    // file uses (kept in sync by the vendor script's version check).
    const mod = (await import(
      /* webpackIgnore: true */
      MEDIAPIPE_BUNDLE_URL
    )) as unknown as VisionModule;
    return mod;
  }

  private async createLandmarker(vision: VisionModule) {
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
      const fileset = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);
      return await vision.HandLandmarker.createFromOptions(fileset, base);
    } catch {
      // GPU unavailable (headless/software rendering) → CPU fallback.
      const fileset = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);
      return await vision.HandLandmarker.createFromOptions(fileset, {
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
          onFrame(landmarksToHandFrame(results));
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

function stopStreamTracks(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
