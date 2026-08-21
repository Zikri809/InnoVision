/**
 * Shared types for the gesture layer (Phase 6).
 *
 * Pure types only — no logic, no DOM, no `process.env`. The `IHandTracker`
 * interface is the test seam: the real browser implementation
 * (`HandLandmarkerTracker`) and the E2E fake both implement it.
 */

/** A single normalized landmark (MediaPipe returns 0..1 x/y, z in meters-ish). */
export type Landmark = { x: number; y: number; z: number };

export type Handedness = "Left" | "Right";

/** One processed frame from a hand tracker (real or fake). */
export type HandFrame = {
  /** Whether a hand was detected at all. */
  handPresent: boolean;
  /** Extended finger count (1–5; 0 when no hand / fist / not countable). */
  fingerCount: number;
  /** MediaPipe handedness of the detected hand (absent when no hand). */
  handedness?: Handedness;
  /** Evaluated lighting status for hand recognition. */
  lighting?: "good" | "too_dark" | "too_bright";
};

/** Hold progress for a given 1-based finger (0..1). */
export type HoldProgress = {
  /** 1-based finger being held. */
  finger: number;
  /** 0..1 hold completion. */
  progress: number;
};

/** A scripted segment for the E2E fake tracker. */
export type HandSegment = {
  /** Whether a hand is present. `present: false` differs from a fist. */
  present: boolean;
  /** Finger count when present (0 for a fist). */
  fingers: number;
  /** How long (ms) to emit this segment's frames. */
  holdMs: number;
};

/**
 * The test seam every hand-tracking implementation satisfies. `start` may be
 * async (real boot) or sync (fake); `stop` must be idempotent (StrictMode
 * double-mounts).
 */
export interface IHandTracker {
  start(onFrame: (frame: HandFrame) => void): Promise<void> | void;
  stop(): void;
  bindDOMElements?(elements: { video: HTMLVideoElement; canvas: HTMLCanvasElement }): void;
}

/** E2E control surface for scripting fake frames. */
export type FakeHandControl = {
  /** Replays an array of segments (cancels any in-flight sequence). */
  sequence(segments: HandSegment[]): void;
  /** Pushes a single frame synchronously. */
  frame(handPresent: boolean, fingerCount: number): void;
};
