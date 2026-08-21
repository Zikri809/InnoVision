/**
 * Shared constants for the face pipeline (Phase 7 — CompreFace migration).
 *
 * This module is PURE and env-free (house precedent: `lib/sessions/timer.ts`,
 * `lib/gestures/constants.ts`) so it can be imported by Node unit tests, the
 * client components, and the E2E specs. There is deliberately NO `config.ts`
 * and NO `process.env` — an env read here is a drift trap (the SQL constants
 * inside `record_face_check` in migration `0010_compreface.sql` are
 * authoritative for enforcement; these values are MIRRORS used for client UX,
 * unit tests, and E2E margins).
 *
 * MIRROR-NOT-ENFORCEMENT: `FACE_SIMILARITY_MIN` / `FACE_MARGIN_MIN` /
 * `FACE_SUSPICION_MIN` are mirrors of the SQL constants in `0010_compreface.sql`.
 * The server is the sole authority — a client that disagrees simply
 * fails/succeeds per the server's verdict.
 */

/** Minimum CompreFace similarity for a face match (SQL constant 0.5). */
export const FACE_SIMILARITY_MIN = 0.5;

/**
 * Minimum gap between the top match and the second-best match (SQL constant
 * 0.05). Kills lookalike misidentifications while preventing false rejections
 * from ambient baseline similarities in multi-subject setups. A null
 * second-best satisfies the margin automatically.
 */
export const FACE_MARGIN_MIN = 0.05;

/**
 * Enrollment duplicate-flag threshold (SQL constant 0.45). LOWER than
 * FACE_SIMILARITY_MIN — anything that would verify is caught at enroll.
 */
export const FACE_SUSPICION_MIN = 0.45;

/**
 * Maximum number of characters in a base64 JPEG frame payload (≈150 KB).
 * Server-side body-size cap (DoS prevention — L21).
 */
export const MAX_FRAME_BASE64_CHARS = 200_000;

/** Quality-gate minimum face bounding-box size (px, browser native detector). */
export const FRAME_QUALITY_MIN_SIZE = 80;

/** Quality-gate maximum face bounding-box size (px). */
export const FRAME_QUALITY_MAX_SIZE = 640;

/** How long the liveness gate waits for a blink before declaring `failed`. */
export const LIVENESS_TIMEOUT_MS = 8000;

/** Number of VALID capture frames needed for enrollment (one per angle). */
export const ENROLL_CAPTURE_FRAMES = 3;

/** Max total capture attempts before enrollment gives up (`capture_failed`). */
export const ENROLL_CAPTURE_MAX_ATTEMPTS = 15;

/** Max wall-clock for the whole 3-angle capture (45s cap). */
export const ENROLL_CAPTURE_MAX_MS = 45000;

/** The three guided enrollment angles. */
export const ENROLL_ANGLES = ["front", "left", "right"] as const;

/** Pose yaw range for the guided angles (degrees), validated via CompreFace /detect. */
export const ENROLL_ANGLE_YAW_RANGE = { min: 25, max: 60 } as const;

/** Periodic verify jitter bounds (per-check, random within [min, max]). */
export const PERIODIC_MIN_MS = 30000;

/** Periodic verify jitter bounds (per-check, random within [min, max]). */
export const PERIODIC_MAX_MS = 45000;

/** Whole-boot deadline for the face tracker (camera + bundle + models). */
export const FACE_BOOT_TIMEOUT_MS = 20000;

/** Flagged-state poll interval (the student waits for a lecturer unlock). */
export const FLAGGED_POLL_MS = 8000;

/** Blendshape upper bound for "eye open" (`eyeBlinkLeft/Right`). */
export const EYE_OPEN_MAX = 0.4;

/** Blendshape lower bound for "eye closed" (`eyeBlinkLeft/Right`). */
export const EYE_CLOSED_MIN = 0.6;

/**
 * Minimum interval between face checks (advisory `too_frequent` flag in
 * `record_face_check`). Mirrors the SQL `interval '2 seconds'`. Advisory only
 * — never a hard block (real stable faces + fast E2E are never blocked).
 */
export const MIN_VERIFY_INTERVAL_MS = 2000;