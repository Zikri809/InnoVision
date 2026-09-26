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
import type { EnrollAngle } from "./pose-gate";

export type { FaceCheckTrigger };

export type LivePose = {
  yaw: number;
  /**
   * Head pitch proxy in the same units as yaw (nose-drop fraction ×100
   * relative to the calibrated neutral). POSITIVE = head tilted DOWN (a lap
   * glance); negative = chin up. Optional: fakes/legacy trackers without it
   * are treated as pitch 0 by the look-away advisory.
   */
  pitch?: number;
  centered: boolean;
  faceDetected: boolean;
  lighting?: "good" | "too_dark" | "too_bright";
  /**
   * Number of faces the tracker saw in the frame (absent/1 = one face).
   * ≥2 feeds the lecturer-visible `second_face` advisory — the tracker runs
   * with numFaces:2 so a second person is no longer invisible.
   */
  facesSeen?: number;
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
  /** Shared camera stream (read-only) — powers the recovery self-view. */
  readonly stream?: MediaStream | null;
  /** Capture a base64 JPEG frame, or null when no valid face is tracked. */
  captureFrame(opts?: {
    /**
     * Downscale the capture canvas to this max dimension (default 640).
     * The answer-commit path passes ~320: ArcFace embeds at 112×112, so a
     * 320px source stays ~3× oversampled while cutting per-answer upload
     * bytes ~4–6× (prod 2026-09-26 perf fix). Enroll/verify omit it and keep
     * full resolution.
     */
    maxDim?: number;
    /** JPEG quality 0–1 (default 0.85; the answer path passes 0.7). */
    quality?: number;
  }): Promise<string | null>;
  /** Capture the highest quality frame available (face detected, centered, open eyes) within a time window. */
  captureBestFrame?(opts?: {
    maxWaitMs?: number;
    requireCentered?: boolean;
    requireOpenEyes?: boolean;
    requireGoodLighting?: boolean;
    requireIdealLighting?: boolean;
    /**
     * Guided enrollment angle whose yaw band must be satisfied for a frame to
     * be accepted (see `lib/face/pose-gate.ts`). The blended quality score
     * cannot fail on yaw, so without this the capture gate is decorative.
     */
    angle?: EnrollAngle;
  }): Promise<string | null>;
  /**
   * The pose a `captureBestFrame({ angle })` call ACCEPTED (read immediately
   * after a successful capture). The enroll route forwards it so the server
   * judges the SAME reading the student was guided by, instead of re-deriving
   * yaw in a different space (absolute vs neutral-relative) and rejecting an
   * honest capture. Optional: fakes/legacy trackers may omit it.
   */
  readonly lastAcceptedPose?: { angle: EnrollAngle; yaw: number } | null;
  /** Wait for a blink within `timeoutMs`; resolves 'passed' or 'failed'. */
  waitForBlink(timeoutMs: number): Promise<"passed" | "failed">;
  /**
   * Anti-replay head-turn challenge: resolve 'passed' when the student turns
   * their head toward `side` and holds it (see `challenge.ts`). OPTIONAL —
   * callers feature-detect and auto-pass when absent, so trackers/fakes
   * without it stay valid (the real tracker and the E2E fake implement it).
   */
  waitForHeadTurn?(timeoutMs: number, side: "left" | "right"): Promise<"passed" | "failed">;
  /** Optional subscriber for real-time face pose updates (yaw, balance, centering). */
  onPoseChange?(cb: (pose: LivePose) => void): () => void;
  /**
   * Optional subscriber for FATAL tracking-loop errors. When the detection
   * loop dies mid-session the tracker can no longer produce poses or blinks —
   * subscribers must degrade to `'unavailable'` (passthrough) instead of
   * silently freezing. Fires at most once per tracker instance.
   */
  onError?(cb: (err: unknown) => void): () => void;
  /** Read current framing & lighting health. */
  getFaceHealth?(): { aligned: boolean; lightingOk: boolean; faceDetected: boolean; facesSeen?: number };
  /**
   * Adaptive duty cycle: slow the detection loop during sustained play,
   * restore full rate before liveness-critical states (see the tier
   * constants in constants.ts). Optional — callers feature-detect; the E2E
   * fake never needs it (its frames are synchronous).
   */
  setFrameInterval?(ms: number): void;
  /**
   * Sample the current head pose as the caller's NEUTRAL baseline for
   * `yaw` (per-user calibration: nose-position proxies depend on facial
   * anatomy + webcam placement, so "straight" is not a universal zero).
   * Call while the user looks straight ahead — e.g. at the top of the guided
   * enrollment flow. Optional: trackers without it keep absolute yaw.
   * Resolves TRUE when a baseline was actually captured; FALSE when too few
   * samples landed (no face tracked during the window) — the baseline is
   * left UNSET and yaw stays in absolute mode, so callers should retry once
   * with a longer window rather than run the flow against a possibly-biased
   * geometric midpoint.
   */
  calibrateNeutral?(sampleMs?: number): Promise<boolean>;
  stop(): void;
}

/**
 * E2E control surface for scripting fake face behavior. All fields optional —
 * the real tracker never exposes this surface.
 *
 * InsightFace migration: `setVerifyMode('match'|'mismatch')` no longer
 * produces an embedding vector — it selects which FRAME MARKER string
 * `captureFrame` returns (`FAKE_FRAME_MATCH` vs `FAKE_FRAME_MISMATCH`). The
 * route-level mock (insightface-client.ts) inspects the frame string (when
 * the harness seam flag `NEXT_PUBLIC_E2E_FAKE_SEAM === '1'` AND
 * `FACE_MOCK_ENABLED === '1'` — see src/lib/face/seam-gate.ts) and
 * returns the corresponding canned response.
 */
export type FakeFaceControl = {
  /** `'match'` → `FAKE_FRAME_MATCH` marker; `'mismatch'` → `FAKE_FRAME_MISMATCH`. */
  setVerifyMode(mode: "match" | "mismatch"): void;
  /** Resolve the current (or next) `waitForBlink` with a blink. */
  triggerBlink(): void;
  /**
   * Resolve the current (or next) `waitForHeadTurn` with a head turn
   * (anti-replay challenge). Optional: fakes without it stay valid — the
   * pipeline auto-passes the challenge when the tracker lacks
   * `waitForHeadTurn`.
   */
  triggerHeadTurn?(): void;
  /** Override the periodic cadence for the E2E seam (keys match `PeriodicCadence`). */
  setFacePeriodic(opts: { minMs: number; maxMs: number }): void;
  /**
   * Script the fake tracker's pose state (yaw/centering/face count/lighting)
   * — drives the `second_face`/`looked_away` advisories and the pipeline's
   * lighting precheck in E2E. Optional: older fake trackers without it stay
   * valid.
   */
  setFacePose?(opts: {
    yaw?: number;
    pitch?: number;
    centered?: boolean;
    faceDetected?: boolean;
    facesSeen?: number;
    lighting?: "good" | "too_dark" | "too_bright";
  }): void;
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
 * audit-5 M4: one `pending_review` student on the lecturer's review list
 * (`list_pending_face_enrollments`, migration 0062 §7).
 */
export type PendingFaceEnrollment = {
  student_id: string;
  full_name: string | null;
  matric_no: string | null;
  classes: string[];
};

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
