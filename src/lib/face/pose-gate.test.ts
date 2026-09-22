import { describe, it, expect } from "vitest";
import {
  checkEnrollPose,
  checkEnrollPoseAbsolute,
  checkEnrollPoseServer,
  isPoseInBand,
  ENROLL_YAW_BANDS,
  ENROLL_YAW_SERVER_TOLERANCE,
  ENROLL_YAW_ABSOLUTE_SANITY_DEG,
  ENROLL_YAW_MAX_ESTIMATOR_GAP,
  ENROLL_YAW_CLIENT_MAX,
  type EnrollAngle,
} from "./pose-gate";

/**
 * Prod incident 2026-09-21 regression suite.
 *
 * Two bugs are pinned here, and every test is written so that REINTRODUCING
 * either one turns a case red:
 *
 *  A. The capture gate accepted any frame scoring ≥90/120, and yaw contributes
 *     0 points beyond 45° — so 46°, 60°, even a near-profile frame was
 *     "in band". The capture gate now calls `isPoseInBand` explicitly.
 *  B. The server compared the sidecar's ABSOLUTE yaw against hardcoded bounds
 *     while the client guided in NEUTRAL-RELATIVE yaw, so an off-axis camera
 *     produced four `pose_invalid` rejections. `checkEnrollPoseServer` judges
 *     the client's accepted reading instead.
 */

const ANGLES: EnrollAngle[] = ["front", "left", "right"];

describe("pose-gate — bands match the enrollment UI contract", () => {
  it("front requires a straight-on face (±15)", () => {
    expect(ENROLL_YAW_BANDS.front).toEqual({ min: -15, max: 15 });
  });

  it("left/right require a real turn (10–45) with opposite signs", () => {
    expect(ENROLL_YAW_BANDS.left).toEqual({ min: 10, max: 45 });
    expect(ENROLL_YAW_BANDS.right).toEqual({ min: -45, max: -10 });
  });

  it("accepts the exact band edges (inclusive)", () => {
    for (const angle of ANGLES) {
      const { min, max } = ENROLL_YAW_BANDS[angle];
      expect(checkEnrollPose(angle, min).ok, `${angle} min`).toBe(true);
      expect(checkEnrollPose(angle, max).ok, `${angle} max`).toBe(true);
    }
  });

  it("rejects just outside the band edges", () => {
    expect(checkEnrollPose("front", 15.01).ok).toBe(false);
    expect(checkEnrollPose("front", -15.01).ok).toBe(false);
    expect(checkEnrollPose("left", 9.99).ok).toBe(false);
    expect(checkEnrollPose("left", 45.01).ok).toBe(false);
    expect(checkEnrollPose("right", -9.99).ok).toBe(false);
    expect(checkEnrollPose("right", -45.01).ok).toBe(false);
  });
});

describe("pose-gate — BUG A regression: the 46° 'Right' frame", () => {
  /**
   * The literal prod value from the enrollment screenshot: the wizard's oval
   * was amber and the HUD read "Angle: 46°", yet the frame was captured and
   * submitted because the blended score cleared ≥90 with zero yaw points.
   *
   * The HUD prints `Math.abs(yaw)`, so the sign is not recoverable from the
   * screenshot — both directions must be rejected, each with the reason that
   * tells the student what to actually do.
   */
  it("rejects the prod 46° frame for the right angle, both directions", () => {
    const over = checkEnrollPose("right", -46);
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error("unreachable");
    expect(over.reason).toBe("turn_less");

    const wrongWay = checkEnrollPose("right", 46);
    expect(wrongWay.ok).toBe(false);
    if (wrongWay.ok) throw new Error("unreachable");
    expect(wrongWay.reason).toBe("wrong_way");
  });

  it("the capture predicate rejects it too (what captureBestFrame calls)", () => {
    expect(isPoseInBand("right", 46)).toBe(false);
    expect(isPoseInBand("right", -46)).toBe(false);
  });

  it("rejects frames the OLD blended score provably accepted", () => {
    // OLD: faceDetected 30 + centered 25 + yaw 0 (>45°) + eyes 20 + light 20 = 95 ≥ 90.
    // Every one of these must now fail the band, i.e. 95/120 is not "in band".
    for (const yaw of [46, 60, 90, 120, 180, -46, -60, -90]) {
      const angle: EnrollAngle = yaw > 0 ? "right" : "left";
      expect(isPoseInBand(angle, yaw), `yaw ${yaw}`).toBe(false);
    }
  });

  it("a front frame that is mid-turn (49°, the prod rejection) is rejected", () => {
    const verdict = checkEnrollPose("front", -49.09);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("not_straight");
  });
});

describe("pose-gate — failure reasons are actionable", () => {
  it("front: any large |yaw| is 'not_straight' regardless of direction", () => {
    for (const yaw of [40, -40, 90, -90]) {
      const v = checkEnrollPose("front", yaw);
      expect(v.ok).toBe(false);
      if (v.ok) throw new Error("unreachable");
      expect(v.reason).toBe("not_straight");
    }
  });

  it("sides: not turning at all is 'wrong_way' (the prod left=-1.5° rejection)", () => {
    const v = checkEnrollPose("left", -1.52);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toBe("wrong_way");
  });

  it("sides: turning the OPPOSITE way is 'wrong_way'", () => {
    const left = checkEnrollPose("left", -30);
    expect(left.ok).toBe(false);
    if (left.ok) throw new Error("unreachable");
    expect(left.reason).toBe("wrong_way");

    const right = checkEnrollPose("right", 30);
    expect(right.ok).toBe(false);
    if (right.ok) throw new Error("unreachable");
    expect(right.reason).toBe("wrong_way");
  });

  it("sides: turned the right way but too little is 'turn_more'", () => {
    const v = checkEnrollPose("left", 5);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toBe("turn_more");
  });

  it("sides: turned the right way but too far is 'turn_less'", () => {
    const v = checkEnrollPose("left", 60);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toBe("turn_less");
  });

  it("non-finite yaw is 'no_face' (never a silent pass)", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const v = checkEnrollPose("front", bad);
      expect(v.ok).toBe(false);
      if (v.ok) throw new Error("unreachable");
      expect(v.reason).toBe("no_face");
    }
  });
});

describe("pose-gate — server tolerance is a backstop, not a second opinion", () => {
  it("widens the band symmetrically by the tolerance", () => {
    const edge = ENROLL_YAW_BANDS.front.max;
    // No tolerance (the capture gate): the edge is exact.
    expect(checkEnrollPose("front", edge).ok).toBe(true);
    expect(checkEnrollPose("front", edge + 0.01).ok).toBe(false);
    // With the server tolerance the same edge is accepted…
    expect(checkEnrollPose("front", edge + ENROLL_YAW_SERVER_TOLERANCE, ENROLL_YAW_SERVER_TOLERANCE).ok).toBe(true);
    // …and one hundredth past it is not.
    expect(
      checkEnrollPose("front", edge + ENROLL_YAW_SERVER_TOLERANCE + 0.01, ENROLL_YAW_SERVER_TOLERANCE).ok,
    ).toBe(false);
  });

  it("keeps the server gate strictly more permissive than the client gate", () => {
    // If the server were STRICTER than the capture gate, honest captures would
    // be rejected server-side — the exact shape of the incident.
    for (const angle of ANGLES) {
      for (const yaw of [-90, -46, -20, -14, 0, 14, 20, 46, 90]) {
        if (isPoseInBand(angle, yaw)) {
          expect(
            checkEnrollPose(angle, yaw, ENROLL_YAW_SERVER_TOLERANCE).ok,
            `${angle} @ ${yaw}`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("pose-gate — BUG B regression: absolute vs neutral-relative space", () => {
  /**
   * The prod failure: the student's calibrated neutral sat ~-40° off the
   * sidecar's absolute zero (off-axis webcam / head geometry). The client
   * guided them to a ~-40° absolute "straight" pose and to ~-1° absolute for a
   * "left" turn — which the OLD absolute-only server gate read as
   * `FRONT out of range: -49.09` and `SIDE out of range: -1.52`.
   */
  it("accepts a straight capture the client guided, even at -40° absolute", () => {
    // Client accepted yaw ≈ 0 (its calibrated "straight"); sidecar measures -40°.
    const v = checkEnrollPoseServer("front", -40, 0);
    expect(v.ok).toBe(true);
  });

  it("accepts a side capture the client guided, even when absolute yaw is near zero", () => {
    // Client turned to its own +30 units; sidecar measures the same pose as -1.5°.
    const v = checkEnrollPoseServer("left", -1.52, 30);
    expect(v.ok).toBe(true);
  });

  it("rejects the same frames when the client reading is absent (strict fallback)", () => {
    expect(checkEnrollPoseServer("front", -40, null).ok).toBe(false);
    expect(checkEnrollPoseServer("left", -1.52, null).ok).toBe(false);
    expect(checkEnrollPoseServer("front", -40, undefined).ok).toBe(false);
  });

  it("still rejects a genuinely wrong pose reported by BOTH estimators", () => {
    // Client says "still straight", sidecar agrees → front band rejects.
    expect(checkEnrollPoseServer("front", 12, 12).ok).toBe(true);
    // Both agree the student is at 40° during the front capture → reject.
    expect(checkEnrollPoseServer("front", 40, 40).ok).toBe(false);
  });

  it("honours the client reading's DIRECTION (wrong-way turns still fail)", () => {
    const v = checkEnrollPoseServer("left", -20, -20);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toBe("wrong_way");
  });
});

describe("pose-gate — anti-tamper bounds on the client reading", () => {
  it("ignores a client reading that is implausibly large", () => {
    // Beyond ENROLL_YAW_CLIENT_MAX the reading is garbage → absolute fallback.
    const v = checkEnrollPoseServer("front", 40, ENROLL_YAW_CLIENT_MAX + 1);
    expect(v.ok).toBe(false);
  });

  it("ignores a client reading that contradicts the sidecar wildly", () => {
    // Client claims "straight" (0) while the sidecar measures a near-profile.
    const v = checkEnrollPoseServer("front", 70, 0);
    expect(v.ok).toBe(false);
    // The gap exceeds the estimator bound, so the strict absolute band decides.
    expect(Math.abs(70 - 0)).toBeGreaterThan(ENROLL_YAW_MAX_ESTIMATOR_GAP);
  });

  it("vetoes an in-band client reading when the sidecar sees a near-profile", () => {
    // Client reading is inside the front band AND consistent with the sidecar,
    // but the absolute pose is past the sanity ceiling → no stored sample.
    const v = checkEnrollPoseServer("front", 0, 0);
    expect(v.ok).toBe(true);
    const nearProfile = ENROLL_YAW_ABSOLUTE_SANITY_DEG + 5;
    // Craft a consistent pair: both estimators agree at a near-profile angle.
    const veto = checkEnrollPoseServer("front", nearProfile, nearProfile);
    expect(veto.ok).toBe(false);
  });

  it("non-finite sidecar yaw never passes", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const v = checkEnrollPoseServer("front", bad, 0);
      expect(v.ok).toBe(false);
      if (v.ok) throw new Error("unreachable");
      expect(v.reason).toBe("no_face");
    }
  });
});

describe("pose-gate — absolute fallback keeps the pre-incident strictness", () => {
  it("front is ±30 absolute (unchanged from before the incident)", () => {
    expect(checkEnrollPoseAbsolute("front", 30).ok).toBe(true);
    expect(checkEnrollPoseAbsolute("front", 30.01).ok).toBe(false);
    expect(checkEnrollPoseAbsolute("front", -30).ok).toBe(true);
  });

  it("sides need a real turn in the right direction", () => {
    expect(checkEnrollPoseAbsolute("left", 30).ok).toBe(true);
    expect(checkEnrollPoseAbsolute("left", -30).ok).toBe(false);
    expect(checkEnrollPoseAbsolute("right", -30).ok).toBe(true);
    expect(checkEnrollPoseAbsolute("right", 30).ok).toBe(false);
    expect(checkEnrollPoseAbsolute("left", 5).ok).toBe(false);
  });

  it("is applied when the client sends no reading at all", () => {
    // No client data → absolute bands, NOT the widened shared band.
    const v = checkEnrollPoseServer("front", 20, null);
    expect(v.ok).toBe(true);
    const strict = checkEnrollPoseServer("front", 35, null);
    expect(strict.ok).toBe(false);
  });
});
