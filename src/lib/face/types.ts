/**
 * Shared types for the face pipeline (Phase 7 — CompreFace migration).
 *
 * Pure types only — no logic, no DOM, no `process.env`. The `IFaceTracker`
 * interface is the test seam: the real browser implementation (`FaceTracker`)
 * and the E2E fake both implement it.
 *
 * `FaceCheckTrigger` is RE-EXPORTED from the DB-derived aliases — never
 * re-declared (repo rule: `types.ts` re-exports DB-derived enums).
 */
import type { FaceCheckTrigger, SessionStatus } from "@/lib/types/aliases";

export type { FaceCheckTrigger };

export type LivePose = {
  yaw: number;
  centered: boolean;
  faceDetected: boolean;
  lighting?: "good" | "too_dark" | "too_bright";
};

/**
 * The test seam every face-tracking implementation satisfies. `start` may be
 * async (real boot) or sync (fake); `stop` must be idempotent (StrictMode
 * double-mounts).
 *
 * CompreFace migration (L3): the tracker no longer produces an embedding. It
 * captures a webcam FRAME (base64 JPEG data URL) that the Next.js route
 * forwards to CompreFace `/recognize`. `captureFrame` returns `null` when the
 * quality gate fails / no face is tracked — the pipeline POSTs a sentinel
 * frame, CompreFace returns no subject, and the RPC computes a fail.
 */
export interface IFaceTracker {
  start(): Promise<void> | void;
  /** Capture a base64 JPEG frame, or null when no valid face is tracked. */
  captureFrame(): Promise<string | null>;
  /** Capture the highest quality frame available (face detected, centered, open eyes) within a time window. */
  captureBestFrame?(opts?: {
    maxWaitMs?: number;
    requireCentered?: boolean;
    requireOpenEyes?: boolean;
    requireGoodLighting?: boolean;
    requireIdealLighting?: boolean;
  }): Promise<string | null>;
  /** Wait for a blink within `timeoutMs`; resolves 'passed' or 'failed'. */
  waitForBlink(timeoutMs: number): Promise<"passed" | "failed">;
  /** Optional subscriber for real-time face pose updates (yaw, balance, centering). */
  onPoseChange?(cb: (pose: LivePose) => void): () => void;
  /** Read current framing & lighting health. */
  getFaceHealth?(): { aligned: boolean; lightingOk: boolean; faceDetected: boolean };
  stop(): void;
}

/**
 * E2E control surface for scripting fake face behavior. All fields optional —
 * the real tracker never exposes this surface.
 *
 * CompreFace migration (L15): `setVerifyMode('match'|'mismatch')` no longer
 * produces an embedding vector — it selects which FRAME MARKER string
 * `captureFrame` returns (`FAKE_FRAME_MATCH` vs `FAKE_FRAME_MISMATCH`). The
 * route-level CompreFace mock inspects the frame string (when
 * `NODE_ENV !== 'production'` AND `COMPREFACE_MOCK_ENABLED === '1'`) and
 * returns the corresponding canned response.
 */
export type FakeFaceControl = {
  /** `'match'` → `FAKE_FRAME_MATCH` marker; `'mismatch'` → `FAKE_FRAME_MISMATCH`. */
  setVerifyMode(mode: "match" | "mismatch"): void;
  /** Resolve the current (or next) `waitForBlink` with a blink. */
  triggerBlink(): void;
  /** Override the periodic cadence for the E2E seam (keys match `PeriodicCadence`). */
  setFacePeriodic(opts: { minMs: number; maxMs: number }): void;
  /** Read the current periodic override (the pipeline consumes this at cadence construction). */
  readonly _periodic?: { minMs: number; maxMs: number };
};

/**
 * Face enrollment state. `'pending_review'` = duplicate detected at enrollment
 * (lecturer decides); `'enrolled'` = active; `null` = not enrolled / revoked /
 * rejected.
 */
export type FaceEnrollmentStatus = "enrolled" | "pending_review";

/**
 * UI status of the face pipeline. `'off'` = practice/lecturer; `'unavailable'`
 * = camera/models offline (passthrough); `'exempt'` = lecturer exemption;
 * `'gate'` = initial assessment gate; `'ready'` = verified, continuous verify
 * armed; `'paused'` = server-paused (blink-recoverable); `'recovering'` =
 * blink recovery in progress; `'flagged'` = lecturer decision required.
 */
export type FaceStatus =
  | "off"
  | "unavailable"
  | "exempt"
  | "gate"
  | "ready"
  | "paused"
  | "recovering"
  | "flagged";

/** The success body of `record_face_check` (snake_case from the RPC). */
export type FaceCheckResult = {
  matched: boolean;
  distance: number | null;
  sessionStatus: Extract<SessionStatus, "active" | "paused" | "flagged">;
  nextNonce: string;
  faceFailStreak: number;
};

/** The route-level success body (camelCase, after key mapping). */
export type FaceVerifyResponse = {
  matched: boolean;
  distance: number | null;
  sessionStatus: Extract<SessionStatus, "active" | "paused" | "flagged">;
  nextNonce: string;
  faceFailStreak: number;
};