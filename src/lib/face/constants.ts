/**
 * Shared constants for the face pipeline (Phase 7 — CompreFace migration +
 * integrity suite).
 *
 * This module is PURE and env-free (house precedent: `lib/sessions/timer.ts`,
 * `lib/gestures/constants.ts`) so it can be imported by Node unit tests, the
 * client components, and the E2E specs. There is deliberately NO `config.ts`
 * and NO `process.env` — an env read here is a drift trap (the SQL constants
 * inside `record_face_check` in migration `0020_integrity_suite.sql` are
 * authoritative for enforcement; these values are MIRRORS used for client UX,
 * unit tests, and E2E margins).
 *
 * MIRROR-NOT-ENFORCEMENT: `FACE_SIMILARITY_MIN` / `FACE_SUSPICION_MIN` are
 * mirrors of the SQL constants. The server is the sole authority — a client
 * that disagrees simply fails/succeeds per the server's verdict.
 */

/** Minimum baseline similarity (ArcFace cosine) for a frame vote to count as a hit. */
export const FACE_SIMILARITY_MIN = 0.5;

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

/** How long the liveness gate waits for a blink before declaring `failed`. */
export const LIVENESS_TIMEOUT_MS = 8000;

/**
 * Adaptive duty-cycle tiers for the FaceTracker detection loop
 * (`setFrameInterval`). FULL runs during liveness-critical states (gate,
 * recovering): a blink's blendshape crossing lasts ~100ms, and the
 * BlinkDetector passes on a single closed sample after an open one — so the
 * sampling period must stay well under 100ms to catch every blink. SLOW runs
 * during sustained play (`ready`), where the loop only feeds pose health,
 * advisories, and the precheck (all multi-second scale): 66ms (~15fps)
 * guarantees ≥1 sample inside any ~100ms blink window while roughly halving
 * inference duty, and capture paths (captureFrame/captureBestFrame) are
 * loop-independent. The pipeline flips tiers at its single status choke
 * point; the tracker clamps to [FULL, 200].
 */
export const FACE_TRACK_FRAME_INTERVAL_MS = 33;
export const FACE_TRACK_SLOW_INTERVAL_MS = 66;

/**
 * How often the tracker samples face-ROI luminance for the ambient lighting
 * classification (ms). Room lighting changes on seconds-scale; the
 * authoritative per-capture luminance check in `captureBestFrame` is
 * unaffected (it measures the frame it captures).
 */
export const LUMINANCE_SAMPLE_INTERVAL_MS = 500;

/** Number of VALID capture frames needed for enrollment (one per angle). */
export const ENROLL_CAPTURE_FRAMES = 3;

/** Max total capture attempts before enrollment gives up (`capture_failed`). */
export const ENROLL_CAPTURE_MAX_ATTEMPTS = 15;

/** Max wall-clock for the whole 3-angle capture (45s cap). */
export const ENROLL_CAPTURE_MAX_MS = 45000;

/** The three guided enrollment angles. */
export const ENROLL_ANGLES = ["front", "left", "right"] as const;

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

/**
 * Blendshape lower bound for "eye closed" (`eyeBlinkLeft/Right`).
 * Tuned to 0.46 after live testing: a natural-speed blink peaks around
 * 0.45–0.6 on the blendshape ramp and lasts ~3 frames at the tracker's ~30fps
 * sampling. At 0.46 soft/quick and turned-pose blinks reliably cross while the
 * anti-spoof property is unchanged — a static photo can never produce the
 * required OPEN→closed TRANSITION regardless of where the closed threshold sits.
 */
export const EYE_CLOSED_MIN = 0.46;

/**
 * Minimum interval between face checks (advisory `too_frequent` flag in
 * `record_face_check`). Mirrors the SQL `interval '2 seconds'`. Advisory only
 * — never a hard block (real stable faces + fast E2E are never blocked).
 */
export const MIN_VERIFY_INTERVAL_MS = 2000;

/**
 * Frames captured per face check (2-of-3 majority voting). The verify route
 * verifies each frame against the caller's own subject (1:1) and the SQL RPC
 * records ONE row whose verdict is the strict majority of per-frame votes.
 */
export const VERIFY_FRAMES_PER_CHECK = 3;

/** Delay between the follow-up frames of one check (ms). */
export const VERIFY_FRAME_SPACING_MS = 500;

/**
 * Grace period for a secondary frame capture before giving up on it. A
 * failed secondary capture is OMITTED (majority over submitted frames) —
 * capture flakiness must not count as a fail vote.
 */
export const VERIFY_SECONDARY_CAPTURE_TIMEOUT_MS = 600;

/**
 * How long a precheck-gated check (bad lighting, mid-commit hand, or no
 * aligned face — see `face-check-gate.ts`) defers itself before retrying.
 * Deferrals are bounded (pipeline-side `FACE_CHECK_DEFER_MAX`); a doomed
 * frame would otherwise land as a false fail row.
 */
export const LIGHTING_RETRY_DELAY_MS = 4000;

/**
 * Debounce for window-blur focus-loss detection (ms). Transient blurs (OS
 * screenshot tool, IME popups, notification toasts) return focus inside this
 * window and never pause the exam.
 */
export const FOCUS_BLUR_DEBOUNCE_MS = 900;

/**
 * Verify-silence backstop (integrity hardening, migration 0042): a verify
 * POST that fails at the TRANSPORT layer (fetch throw — e.g. proxies that
 * drop the large multi-frame bodies while tiny answer POSTs sail through)
 * currently retries silently forever. After this many consecutive transport
 * failures the pipeline degrades to `unavailable` + reportUnavailableOnce(),
 * routing the session into the self-exempting outage path the silence cron
 * honors — without it, that student is falsely flagged ~300s in (answers
 * flow, no face_checks rows land). HTTP ≥500 already degrades (L14).
 */
export const VERIFY_TRANSPORT_FAIL_LIMIT = 4;

/**
 * Focus-loss pause escalation: the Nth confirmed focus-loss pause flags the
 * session (lecturer decision). Mirrors the SQL constant in `pause_session`.
 */
export const FOCUS_LOSS_FLAG_THRESHOLD = 3;

/** Sustained second-face presence that fires the `second_face` advisory (ms). */
export const SECOND_FACE_SUSTAIN_MS = 1000;

/**
 * Looked-away accumulation that fires the `looked_away` advisory: this much
 * off-center/off-axis time within the rolling window.
 */
export const LOOK_AWAY_ACCUMULATE_MS = 8000;

/** Rolling window for look-away accumulation (ms). */
export const LOOK_AWAY_WINDOW_MS = 60000;

/** Head yaw beyond which the student counts as "looking away" (degrees). */
export const LOOK_AWAY_YAW_DEG = 25;

/** Throttle between identical advisory reports of one type (ms). */
export const ADVISORY_THROTTLE_MS = 55000;

/** Speech-level RMS above which an audio sample counts as voice activity. */
export const VOICE_RMS_THRESHOLD = 0.06;

/**
 * Voice activity within the rolling window that fires the `voice_activity`
 * advisory (cumulative speech-level ms).
 */
export const VOICE_ACTIVITY_ACCUMULATE_MS = 2000;

/** Rolling window for voice-activity accumulation (ms). */
export const VOICE_ACTIVITY_WINDOW_MS = 30000;

/** Audio sample poll interval for the RMS meter (ms). */
export const VOICE_SAMPLE_INTERVAL_MS = 250;

/** Incident ring-buffer target length (ms of footage kept in memory). */
export const INCIDENT_RING_MS = 300000;

/** MediaRecorder timeslice for incident chunks (ms). */
export const INCIDENT_TIMESTRICE_MS = 5000;

/** Maximum upload size for one incident clip (bytes). */
export const MAX_INCIDENT_BYTES = 30_000_000;