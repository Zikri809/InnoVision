/**
 * Enrollment pose gate — PURE, env-free policy module (single source of truth).
 *
 * WHY THIS MODULE EXISTS (prod incident 2026-09-21, session cfb12aef): the
 * enrollment wizard had TWO yaw gates that disagreed, and the one that ran at
 * capture time could not fail on yaw at all:
 *
 *   1. `captureBestFrame` accepted any frame scoring ≥90 of 120 on a blended
 *      quality score. Yaw contributes 0 points beyond 45°, so
 *      `faceDetected 30 + centered 25 + eyesOpen 20 + lighting 20 = 95` passed
 *      with ZERO yaw points at ANY head angle. The on-screen per-angle oval was
 *      decorative: a "Right" frame at 46° was captured and submitted.
 *
 *   2. The ROUTE re-measured yaw with the sidecar's ABSOLUTE 3D-68 regressor,
 *      while the CLIENT reports yaw RELATIVE to a per-user calibrated neutral
 *      (`calibrateNeutral`). A student whose camera/head geometry sits off-axis
 *      sees green client guidance while the server rejects with the raw code
 *      `pose_invalid` — 4 rejections in one sitting, no actionable copy.
 *
 * This module owns each angle's band ONCE: the capture loop enforces it, the
 * wizard renders it, and the route judges against the SAME band after
 * reconciling the sidecar's absolute yaw with the client's per-frame reading.
 *
 * YAW SPACES (the crux — read before changing anything):
 *   - Tracker yaw (`LivePose.yaw`): nose-offset proxy ×100, RELATIVE to the
 *     user's calibrated neutral (0 = looking straight at the camera).
 *     POSITIVE = the student turns toward THEIR OWN LEFT.
 *   - Sidecar yaw (`InsightFaceFace.yaw`): 3D-68 landmark regression in
 *     DEGREES, ABSOLUTE (no per-user calibration). Same sign convention.
 * `checkEnrollPoseServer` below is the only place the two are reconciled.
 */

/** Which guided angle a capture belongs to. */
export type EnrollAngle = "front" | "left" | "right";

/** Decimal places for yaw in diagnostics (one is plenty for a gate). */
const YAW_PRECISION = 2;

/**
 * Neutral-relative yaw band per angle, in tracker units.
 *
 * These are the numbers the enrollment UI has ALWAYS drawn — the green oval in
 * `face-enroll-client.tsx` and the `turnLeft`/`turnRight`/`turnLess` prompt
 * copy. They are lifted here verbatim so the gate, the guidance, and the
 * server check are one contract instead of three drifting copies.
 *
 * `front` is tight: the wizard's first capture must be straight-on. Sides
 * require a real turn (≥10) and cap at 45, so an over-rotation is caught LIVE,
 * while the student is still in front of the camera and can react.
 */
export const ENROLL_YAW_BANDS: Record<EnrollAngle, { min: number; max: number }> = {
  front: { min: -15, max: 15 },
  // POSITIVE yaw = the student turns toward THEIR OWN left.
  left: { min: 10, max: 45 },
  right: { min: -45, max: -10 },
};

/**
 * Slack the ROUTE adds on top of the band, in the same units.
 *
 * This is a ROUNDING margin, not an estimator-disagreement margin. The route
 * judges the client's own reading — the exact number the capture gate enforced
 * — so an honest client is inside its band by construction and the only gap to
 * absorb is the tracker's integer rounding. `Math.round` moves a value by at
 * most 0.5, hence the value: large enough that a rounded reading is never
 * re-litigated, small enough that a frame the capture gate rejected stays
 * rejected. Do NOT widen it to paper over a client/server disagreement; that
 * is the bug this module exists to fix, and widening re-opens it silently.
 */
export const ENROLL_YAW_SERVER_TOLERANCE = 0.5;

/**
 * Widest |absolute − client| gap the route accepts before it stops trusting the
 * client's reading and falls back to the strict absolute band. Beyond this the
 * two estimators disagree so much that one of them is not describing a real
 * head pose (a tampered client, or a genuinely broken calibration).
 */
export const ENROLL_YAW_MAX_ESTIMATOR_GAP = 60;

/**
 * Sanity ceiling on the sidecar's absolute yaw for a frame the client claims is
 * in band. A true profile (>75°) is not a usable enrollment sample regardless
 * of what the client says, so the client's reading can never open the gate
 * past this.
 */
export const ENROLL_YAW_ABSOLUTE_SANITY_DEG = 75;

/**
 * Plausibility ceiling for the client's own yaw reading (tracker units). The
 * tracker's proxy saturates well below this; a larger value is garbage.
 */
export const ENROLL_YAW_CLIENT_MAX = 150;

/** Why a frame failed the gate — drives the student-facing copy. */
export type PoseFailureReason =
  | "no_face"
  | "not_straight"
  | "wrong_way"
  | "turn_more"
  | "turn_less";

export type PoseGateResult =
  | { ok: true; angle: EnrollAngle; yaw: number }
  | { ok: false; angle: EnrollAngle; yaw: number; reason: PoseFailureReason };

/**
 * The one band judgement. Every call site funnels through here.
 *
 * `yawTolerance` widens the band symmetrically: the capture loop passes 0 (its
 * guidance is exact), the route passes `ENROLL_YAW_SERVER_TOLERANCE`.
 */
export function checkEnrollPose(
  angle: EnrollAngle,
  yaw: number,
  yawTolerance = 0,
): PoseGateResult {
  const { min, max } = ENROLL_YAW_BANDS[angle];
  if (!Number.isFinite(yaw)) return { ok: false, angle, yaw, reason: "no_face" };
  const rounded = roundYaw(yaw);
  if (yaw >= min - yawTolerance && yaw <= max + yawTolerance) {
    return { ok: true, angle, yaw: rounded };
  }

  if (angle === "front") {
    // Any large |yaw| is a turn in progress; direction is irrelevant here.
    return { ok: false, angle, yaw: rounded, reason: "not_straight" };
  }

  const wanted: 1 | -1 = angle === "left" ? 1 : -1;
  const signed = Math.sign(yaw) || 0;
  // A side band is ONE-SIDED: [10, 45] for left, [-45, -10] for right. So the
  // only two ways to miss it are (a) the sign is wrong / no turn at all, or
  // (b) the sign is right but the magnitude is off. Classifying by sign FIRST
  // is what keeps the copy honest — "+46 for the right angle" is a turn in the
  // WRONG DIRECTION, not an over-rotation, and telling the student to "ease
  // back" would send them further from the requested pose.
  if (signed !== wanted) {
    return { ok: false, angle, yaw: rounded, reason: "wrong_way" };
  }
  // Turned the right way, but not far enough / too far. The near bound is the
  // band edge closest to straight ahead.
  const nearBound = Math.min(Math.abs(min), Math.abs(max));
  return {
    ok: false,
    angle,
    yaw: rounded,
    reason: Math.abs(yaw) < nearBound ? "turn_more" : "turn_less",
  };
}

/** Capture-loop predicate: is this angle's band satisfied right now? */
export function isPoseInBand(angle: EnrollAngle, yaw: number): boolean {
  return checkEnrollPose(angle, yaw).ok;
}

/**
 * Absolute-space bands — the fallback used when the client ships no per-frame
 * yaw (legacy or tampered clients). These are the pre-incident server bounds,
 * unchanged, so a client that declines to participate gets the old strictness
 * rather than a weaker gate.
 */
export const ENROLL_YAW_ABSOLUTE_BANDS: Record<EnrollAngle, { min: number; max: number }> = {
  front: { min: -30, max: 30 },
  left: { min: 10, max: 120 },
  right: { min: -120, max: -10 },
};

/** Judge an ABSOLUTE (sidecar-space) yaw — the no-client-yaw fallback path. */
export function checkEnrollPoseAbsolute(
  angle: EnrollAngle,
  absoluteYawDeg: number,
  yawTolerance = 0,
): PoseGateResult {
  const { min, max } = ENROLL_YAW_ABSOLUTE_BANDS[angle];
  if (!Number.isFinite(absoluteYawDeg)) {
    return { ok: false, angle, yaw: absoluteYawDeg, reason: "no_face" };
  }
  const rounded = roundYaw(absoluteYawDeg);
  if (absoluteYawDeg >= min - yawTolerance && absoluteYawDeg <= max + yawTolerance) {
    return { ok: true, angle, yaw: rounded };
  }
  if (angle === "front") {
    return { ok: false, angle, yaw: rounded, reason: "not_straight" };
  }
  const wanted: 1 | -1 = angle === "left" ? 1 : -1;
  const signed = Math.sign(absoluteYawDeg) || 0;
  if (signed !== wanted) {
    return { ok: false, angle, yaw: rounded, reason: "wrong_way" };
  }
  const nearBound = Math.min(Math.abs(min), Math.abs(max));
  return {
    ok: false,
    angle,
    yaw: rounded,
    reason: Math.abs(absoluteYawDeg) < nearBound ? "turn_more" : "turn_less",
  };
}

/**
 * The route's judgement — reconciles the two estimators.
 *
 * The client's per-frame yaw is the reading that matches the student's own
 * on-screen guidance, so when it is present, plausible, and consistent with the
 * sidecar's independent measurement, the SHARED band decides. The sidecar's
 * absolute yaw still has veto power via `ENROLL_YAW_ABSOLUTE_SANITY_DEG`, so a
 * client cannot talk its way into storing a profile-view sample.
 *
 * Without a usable client reading (omitted, malformed, or wildly inconsistent
 * with the sidecar) the strict absolute bands apply — the pre-incident
 * behaviour, which is correct for an on-axis camera and fails closed otherwise.
 *
 * RESIDUAL (documented, not a regression): a client that lies about its reading
 * can pass the band with a frame whose true pose differs, up to the sanity
 * ceiling. The consequence is bounded — the stored sample is still a
 * sidecar-measured face under 75°, still runs the spoof gate and the duplicate
 * scan, and a near-frontal sample is a perfectly good baseline. The gate's job
 * is to stop the frames that are USELESS as a baseline (mid-turn, profile,
 * wrong direction), not to authenticate the client's protractor.
 */
export function checkEnrollPoseServer(
  angle: EnrollAngle,
  absoluteYawDeg: number,
  clientYaw?: number | null,
): PoseGateResult {
  if (!Number.isFinite(absoluteYawDeg)) {
    return { ok: false, angle, yaw: absoluteYawDeg, reason: "no_face" };
  }

  const clientUsable =
    typeof clientYaw === "number" &&
    Number.isFinite(clientYaw) &&
    Math.abs(clientYaw) <= ENROLL_YAW_CLIENT_MAX &&
    Math.abs(absoluteYawDeg - clientYaw) <= ENROLL_YAW_MAX_ESTIMATOR_GAP;

  if (!clientUsable) {
    // NO tolerance here: the tolerance exists to absorb CLIENT↔SERVER
    // estimator disagreement, and in this branch there is no client reading to
    // disagree with. Falling back to the pre-incident absolute bounds, exactly,
    // keeps a client that declines to participate at the old strictness rather
    // than handing it a WIDER gate than the honest path.
    return checkEnrollPoseAbsolute(angle, absoluteYawDeg);
  }

  // Shared band, in the space the student was actually guided by.
  const bandResult = checkEnrollPose(angle, clientYaw as number, ENROLL_YAW_SERVER_TOLERANCE);
  if (!bandResult.ok) return bandResult;

  // Anti-tamper veto: even an in-band client reading cannot store a sample the
  // sidecar measured as a near-profile.
  if (Math.abs(absoluteYawDeg) > ENROLL_YAW_ABSOLUTE_SANITY_DEG) {
    return {
      ok: false,
      angle,
      yaw: roundYaw(absoluteYawDeg),
      reason: angle === "front" ? "not_straight" : "turn_less",
    };
  }

  return bandResult;
}

function roundYaw(yaw: number): number {
  const f = 10 ** YAW_PRECISION;
  return Math.round(yaw * f) / f;
}
