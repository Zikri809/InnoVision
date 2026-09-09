import type { Landmark, Handedness, HandFrame } from "./types";

/**
 * Pure finger-counting logic (Phase 6, M-DETECT revision; final 2D-angle
 * architecture after three real-camera iterations).
 *
 * This module is a testable mirror of the browser/MediaPipe glue in
 * `hand-tracker.ts` — it is NOT an enforcement point; the tracker calls it on
 * raw (non-mirrored) landmark frames.
 *
 * History of the three revisions (kept here so nobody re-litigates them):
 *  1. Screen-height `tip.y < pip.y` (reference port) — broke on hand tilt
 *     (the 3→4 misfire).
 *  2. Distance ratios (tip-to-wrist vs pip-to-wrist) — foreshortening when
 *     the palm tilts out of plane collapsed extended fingers into the
 *     half-curl band (palm-back 3/4/5 flicker on low-quality webcams).
 *  3. Metric `worldLandmarks` joint angles — REVERTED: the metric copy is
 *     model-PREDICTED, not measured. With the hand against the face in
 *     backlight it hallucinated: rejected a real splayed thumb (5→4) and
 *     counted folded fingers (1→2). Never trust predicted 3D for counting.
 *
 * Final architecture — everything happens on the 2D screen landmarks:
 *  - Fingers: PIP JOINT-ANGLE test. `cos(angle at PIP between MCP→PIP and
 *    PIP→TIP) ≥ 0.8` AND the projected PIP→TIP segment ≥ 0.45× the MCP→PIP
 *    segment. Projection PRESERVES colinearity — a straight finger is
 *    straight in 2D at any tilt or palm orientation (this is what distances
 *    could never do) — while a curled finger reverses direction at the PIP
 *    (cos ≤ 0.5). The length ratio is projection-INVARIANT for colinear
 *    chains (all bones scale together), so a hallucinated stub tip fails it;
 *    anatomically the middle phalanx is ~0.65–0.8 of the proximal one.
 *  - Thumb: straightness at BOTH joints (CMC→MCP→IP→TIP), then two
 *    rejection guards: pinky-base clearance (rejects the straight thumb
 *    folded flat across the palm — the hiding pose when showing 4) and, when
 *    at least one other finger is extended, an axis-envelope test (the tip
 *    must not project more than 1.15× past the farthest extended fingertip
 *    along the finger axis — rejects the phantom thumb MediaPipe paints onto
 *    the jaw/cheek contour when the back of the hand faces the lens at face
 *    height, the 4→5 misfire). With zero fingers extended (thumbs-up) the
 *    envelope is meaningless and is skipped. Handedness is NOT used for
 *    counting: MediaPipe's handedness heuristic assumes a palm-facing
 *    silhouette and flips on back-of-hand views — it caused instability.
 */

const INDEX_TIP = 8;
const INDEX_PIP = 6;
const INDEX_MCP = 5;

const MIDDLE_TIP = 12;
const MIDDLE_PIP = 10;
const MIDDLE_MCP = 9;

const RING_TIP = 16;
const RING_PIP = 14;

const PINKY_TIP = 20;
const PINKY_PIP = 18;
const PINKY_MCP = 17;

const THUMB_CMC = 1;
const THUMB_MCP = 2;
const THUMB_IP = 3;
const THUMB_TIP = 4;

const WRIST = 0;

/**
 * Minimum PIP-joint straightness for a finger to read as extended: cos >= 0.92
 * means the chain bends at most ~23° at the PIP. A relaxed half-curled finger
 * (25°–50° bend) has cos <= 0.906 and evaluates to false (preventing 3->4 and
 * 2->3 misfires). A truly extended finger (chain bend <= 20°) has cos >= 0.9397.
 */
const FINGER_PIP_COS_EXTENDED = 0.92;

/**
 * Minimum projected `dist(PIP, TIP) / dist(MCP, PIP)` for an extended finger.
 * For a COLINEAR chain projection scales every bone equally, so this ratio is
 * projection-invariant (anatomically ~0.65–0.8: middle vs proximal phalanx);
 * a curled or hallucinated stub tip collapses it below 0.3. Conservative
 * guard against landmark fits that invent a near-straight but stubby chain.
 */
const FINGER_PIP_LENGTH_RATIO_MIN = 0.45;

/**
 * Maximum projected `dist(PIP, TIP) / dist(MCP, PIP)` for an extended finger.
 * Anatomically middle + distal phalanx is ~0.65–1.1x proximal phalanx. A phantom
 * digit snapped to facial contours (e.g. jawline or cheek) stretches past 1.35x.
 */
const FINGER_PIP_LENGTH_RATIO_MAX = 1.35;

/**
 * Minimum ratio of knuckle span to palm length (dist(index_mcp, pinky_mcp) / dist(wrist, middle_mcp)).
 * Rejects degenerate or collapsed knuckle frames caused by facial contour snapping.
 */
const MIN_KNUCKLE_PALM_RATIO = 0.20;

/**
 * Minimum ratio of straight-line knuckle-to-tip span to total finger bone chain length.
 * For a straight finger (bend <= 20°), span / totalLength >= 0.98.
 * For an intermediate curl (>= 30° bend), span / totalLength collapses below 0.960.
 */
const MIN_KNUCKLE_TIP_SPAN_RATIO = 0.960;

/**
 * Maximum ratio of finger length (MCP to tip) to palm span (wrist to middle MCP).
 * Natural anatomy is ~0.85–1.05. Set to 1.55 to absorb up to ~50° out-of-plane palm tilt
 * while rejecting phantom fingertips snapped to facial contours extending past the palm envelope (1.8x+).
 */
const MAX_FINGER_PALM_RATIO = 1.55;

/**
 * Maximum thumb CMC-to-tip length relative to palm span.
 * Natural anatomy is ~0.80–1.25. Rejects phantom thumb snapped to jawline/cheek.
 * Set to 2.05 to absorb 50% out-of-plane foreshortening while rejecting phantom jawline thumb (2.4x).
 */
const THUMB_CMC_PALM_RATIO_MAX = 2.05;

/**
 * Maximum thumb MCP-to-tip length relative to palm span.
 * Natural anatomy is ~0.50–0.85. Rejects phantom thumb snapped to jawline/cheek.
 * Set to 1.60 to absorb 50% out-of-plane foreshortening while rejecting phantom jawline thumb (2.05x).
 */
const THUMB_MCP_PALM_RATIO_MAX = 1.60;

/**
 * Maximum thumb distal-to-proximal bone ratio (dist(ip, tip) / dist(mcp, ip)).
 * In natural anatomy, distal phalanx is ~0.65–1.15x proximal phalanx. When snapped
 * to jawline or cheek contour, the distal segment stretches past 3.0x (e.g. 5.0x in phantom).
 * Set to 2.5 to absorb 0.008 landmark jitter on short thumb segments while decisively
 * rejecting phantom jawline/cheek thumb snapping.
 */
const THUMB_DISTAL_PROXIMAL_RATIO_MAX = 2.50;

/**
 * Minimum thumb distal-to-proximal bone ratio to guard against collapsed stub landmarks.
 */
const THUMB_DISTAL_PROXIMAL_RATIO_MIN = 0.25;

/**
 * Minimum cosine of the angle at MCP between WRIST→MCP and MCP→PIP for an
 * extended finger. An extended finger continues outwards from the palm
 * (cos ≥ 0.5+ under severe foreshortening, ~0.95 upright); a finger curled
 * downward or folded into the palm reverses direction towards the wrist (cos ≤ 0,
 * typically ~ -0.9). Rejects downward-curled fingers in palm-facing views.
 */
const FINGER_MCP_COS_MIN = 0.25;

/**
 * Minimum joint straightness for the thumb's MCP and IP joints (≈ 41° max
 * flexion each). An open thumb — however far it is abducted sideways — keeps
 * both joints near-straight (cos ≈ 0.95+); a tucked thumb flexes both past
 * 45°. Slightly looser than the finger threshold because BOTH joints must
 * pass (noise compounds across the two checks).
 */
const THUMB_COS_EXTENDED = 0.75;

/**
 * Thumb-fold guard: minimum `dist(tip, 17) / dist(ip, 17)` on screen. A
 * straight thumb folded ACROSS the palm toward the pinky base (the hiding
 * pose when showing 4) lands its tip at ~0.1–0.7 of the IP-joint distance;
 * an open thumb never points its tip INTO the pinky base (≥ ~0.85 even
 * leaning pinky-ward, ~2 for the perpendicular splay).
 */
const THUMB_PINKY_CLEAR_RATIO = 0.75;

/**
 * Maximum cosine of the angle between the thumb vector (CMC→TIP) and the
 * palm axis (WRIST→MIDDLE_MCP) before the thumb is suspected of being tucked
 * along the index finger or resting along the palm. When splayed open, the
 * thumb abducts sideways at ~35°–90° (cos ≤ 0.82); a thumb tucked along the
 * index finger runs parallel to the palm axis (cos ≥ 0.95).
 */
const THUMB_ALONG_INDEX_COS_MIN = 0.85;

/**
 * Maximum lateral distance (normalized by knuckle width) from the palm midline
 * for a thumb tucked along the index finger or resting on the palm. A tucked
 * thumb stays within ~0.40–0.45 of the palm midline; an open/splayed thumb reaches
 * ~0.64–1.4 (even at modest 25° splay).
 */
const THUMB_ALONG_INDEX_LATERAL_MAX = 0.55;

/**
 * Minimum knuckle-line alignment cosine (vector from pinky MCP to index MCP)
 * for an open/extended thumb. When the thumb is folded across the palm towards
 * middle, ring, or pinky base, it points towards the pinky side (cosKnuckleThumb < 0).
 * An open thumb always points away from pinky past the index knuckle (cosKnuckleThumb >= 0.40).
 */
const THUMB_ACROSS_PALM_KNUCKLE_COS_MIN = 0.10;

/**
 * Phantom-thumb guard: when ≥ 1 finger is extended, the thumb tip must not
 * project more than 1.15× the farthest extended fingertip's distance along
 * the palm→fingertip axis. A real open thumb with fingers up never extends
 * past the fingertips along their own axis (it splays sideways, projecting
 * ≈ 0.3–0.6); the jaw/cheek phantom runs parallel to the fingers and past
 * them (≈ 1.2–1.6). Only rejects phantoms that OVERSHOOT the envelope — a
 * phantom landing exactly at fingertip level is geometrically identical to a
 * genuinely raised thumb and is left to the temporal stabilizer.
 */
const THUMB_AXIS_ENVELOPE_RATIO = 1.15;

/** Min fingertip distance (in palm lengths) for the envelope test to engage. */
const MIN_FINGER_ENVELOPE_PALMS = 0.8;

function distSq(a: Landmark, b: Landmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function dist(a: Landmark, b: Landmark): number {
  return Math.sqrt(distSq(a, b));
}

/**
 * Cosine of the angle at joint `b` between the bone directions `a → b` and
 * `b → c` (2D): 1.0 for a perfectly straight chain, ~0 for a 90° bend,
 * negative for a reflex curl. A degenerate (zero-length) bone means the
 * skeleton collapsed — treated as maximally NOT straight so garbage data can
 * never add a phantom extended finger.
 */
/**
 * Cosine of the angle between two 2D vectors (ax, ay) and (bx, by).
 * Returns 1.0 for colinear matching direction, 0 for perpendicular, -1 for opposite/degenerate.
 */
function cosVectors2D(ax: number, ay: number, bx: number, by: number): number {
  const dot = ax * bx + ay * by;
  const na = Math.sqrt(ax * ax + ay * ay);
  const nb = Math.sqrt(bx * bx + by * by);
  if (na === 0 || nb === 0 || !Number.isFinite(dot)) return -1;
  const cos = dot / (na * nb);
  return Number.isFinite(cos) ? cos : -1;
}

function cosAtJoint2D(a: Landmark, b: Landmark, c: Landmark): number {
  return cosVectors2D(b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y);
}

/**
 * Is the finger whose PIP joint is at `pip` (tip at `tip`, MCP derived as
 * `pip - 1`) extended? Pure 2D: joint angle + phalanx length ratio +
 * outward extension direction from wrist. Both properties survive projection
 * for a straight chain at ANY hand tilt — this is the palm-front/palm-back
 * robustness the old distance ratios lacked.
 */
export function isFingerExtended(landmarks: Landmark[], tip: number, pip: number): boolean {
  const t = landmarks[tip];
  const p = landmarks[pip];
  const m = landmarks[pip - 1];
  const w = landmarks[WRIST];
  if (!t || !p || !m || !w) return false;
  if (
    !Number.isFinite(t.x) ||
    !Number.isFinite(t.y) ||
    !Number.isFinite(p.x) ||
    !Number.isFinite(p.y) ||
    !Number.isFinite(m.x) ||
    !Number.isFinite(m.y) ||
    !Number.isFinite(w.x) ||
    !Number.isFinite(w.y)
  ) {
    return false;
  }

  // DIP joint (pip + 1) for full-chain joint curvature and span analysis
  const d = landmarks[pip + 1];
  const hasDip = Boolean(d && Number.isFinite(d.x) && Number.isFinite(d.y));

  // 1. Joint angles & cumulative chain curvature:
  // Overall PIP->TIP direction must not bend > ~23° relative to MCP->PIP (cos >= 0.92)
  if (cosAtJoint2D(m, p, t) < FINGER_PIP_COS_EXTENDED) {
    return false;
  }

  const proximal = dist(m, p);
  if (proximal === 0) return false;
  const distal = dist(p, t);
  const totalBone = proximal + distal;
  if (totalBone > 0 && dist(m, t) < totalBone * MIN_KNUCKLE_TIP_SPAN_RATIO) {
    return false;
  }

  if (hasDip && d) {
    const distLen = dist(d, t);
    // When distal segment is sufficiently resolved (>= 0.025 screen units, ~half proximal bone),
    // enforce DIP joint straightness and chain vector colinearity.
    if (distLen >= 0.025) {
      if (cosAtJoint2D(p, d, t) < FINGER_PIP_COS_EXTENDED) {
        return false;
      }
      if (cosVectors2D(p.x - m.x, p.y - m.y, t.x - d.x, t.y - d.y) < FINGER_PIP_COS_EXTENDED) {
        return false;
      }
    }
  }

  // 2. Length ratio: projected PIP->TIP must be between 0.45x and 1.35x MCP->PIP.
  // Lower bound rejects collapsed stubs; upper bound rejects phantom fingertips snapped to facial contours.
  if (
    distal < proximal * FINGER_PIP_LENGTH_RATIO_MIN ||
    distal > proximal * FINGER_PIP_LENGTH_RATIO_MAX
  ) {
    return false;
  }

  // 3. Outward extension direction from wrist: the finger must extend outward
  // from the palm, not curl back into the palm (e.g. downward-curled fingers where
  // MCP->PIP and PIP->TIP both point down on screen).
  if (cosAtJoint2D(w, m, p) < FINGER_MCP_COS_MIN) {
    return false;
  }

  // 4. Fingertip distance guard: an extended fingertip must be farther from the
  // wrist than its base MCP knuckle.
  if (distSq(w, t) <= distSq(w, m)) {
    return false;
  }

  // 5. Anatomical proportion guards: knuckle span collapse and palm envelope.
  const indexMcp = landmarks[INDEX_MCP];
  const pinkyMcp = landmarks[PINKY_MCP];
  const middleMcp = landmarks[MIDDLE_MCP];
  if (
    indexMcp &&
    pinkyMcp &&
    middleMcp &&
    Number.isFinite(indexMcp.x) &&
    Number.isFinite(pinkyMcp.x) &&
    Number.isFinite(middleMcp.x)
  ) {
    const palmSpan = dist(w, middleMcp);
    const knuckleSpan = dist(indexMcp, pinkyMcp);
    if (palmSpan > 0) {
      if (knuckleSpan < palmSpan * MIN_KNUCKLE_PALM_RATIO) {
        return false;
      }
      if (dist(m, t) > palmSpan * MAX_FINGER_PALM_RATIO) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Is the thumb extended? Geometry-only (handedness is unreliable on
 * back-of-hand views): joint straightness, pinky-base clearance, adduction/
 * along-index guard, and the phantom envelope guard.
 */
export function isThumbExtended(landmarks: Landmark[]): boolean {
  const cmc = landmarks[THUMB_CMC];
  const mcp = landmarks[THUMB_MCP];
  const ip = landmarks[THUMB_IP];
  const tip = landmarks[THUMB_TIP];
  if (!cmc || !mcp || !ip || !tip) return false;
  if (
    !Number.isFinite(cmc.x) ||
    !Number.isFinite(cmc.y) ||
    !Number.isFinite(mcp.x) ||
    !Number.isFinite(mcp.y) ||
    !Number.isFinite(ip.x) ||
    !Number.isFinite(ip.y) ||
    !Number.isFinite(tip.x) ||
    !Number.isFinite(tip.y)
  ) {
    return false;
  }

  const wrist = landmarks[WRIST];
  const middleMcp = landmarks[MIDDLE_MCP];
  const indexMcp = landmarks[INDEX_MCP];
  const pinkyMcp = landmarks[PINKY_MCP];

  // Robustness guard: validate required palm reference landmarks
  if (
    !wrist ||
    !middleMcp ||
    !indexMcp ||
    !pinkyMcp ||
    !Number.isFinite(wrist.x) ||
    !Number.isFinite(wrist.y) ||
    !Number.isFinite(middleMcp.x) ||
    !Number.isFinite(middleMcp.y) ||
    !Number.isFinite(indexMcp.x) ||
    !Number.isFinite(indexMcp.y) ||
    !Number.isFinite(pinkyMcp.x) ||
    !Number.isFinite(pinkyMcp.y)
  ) {
    return false;
  }

  // 1. Straightness at BOTH joints — rejects the tucked/flexed thumb.
  if (
    cosAtJoint2D(cmc, mcp, ip) < THUMB_COS_EXTENDED ||
    cosAtJoint2D(mcp, ip, tip) < THUMB_COS_EXTENDED
  ) {
    return false;
  }

  // Anatomical bone segment scaling guard: rejects phantom thumb tip snapped to jawline/cheek
  const mcpToIp = dist(mcp, ip);
  const ipToTip = dist(ip, tip);
  if (mcpToIp > 0) {
    const distalToProximal = ipToTip / mcpToIp;
    if (
      distalToProximal > THUMB_DISTAL_PROXIMAL_RATIO_MAX ||
      distalToProximal < THUMB_DISTAL_PROXIMAL_RATIO_MIN
    ) {
      return false;
    }
  }
  const cmcToMcp = dist(cmc, mcp);
  if (cmcToMcp > 0 && mcpToIp > 0) {
    const proximalToMeta = mcpToIp / cmcToMcp;
    if (proximalToMeta > 1.65 || proximalToMeta < 0.35) {
      return false;
    }
  }

  // Strict thumb-to-palm ratio guard (R2): rejects phantom thumb snapped to jawline/cheek
  const palmSpanRef = dist(wrist, middleMcp);
  if (palmSpanRef > 0) {
    const cmcToTip = dist(cmc, tip);
    const mcpToTip = dist(mcp, tip);
    if (
      cmcToTip > palmSpanRef * THUMB_CMC_PALM_RATIO_MAX ||
      mcpToTip > palmSpanRef * THUMB_MCP_PALM_RATIO_MAX
    ) {
      return false;
    }
  }

  // 2. Pinky-base clearance — rejects the straight thumb folded flat across
  //    the palm toward the pinky base (the hiding pose when showing 4).
  const ipToPinky = dist(ip, pinkyMcp);
  if (ipToPinky > 0 && dist(tip, pinkyMcp) < ipToPinky * THUMB_PINKY_CLEAR_RATIO) {
    return false;
  }

  // Check which other fingers are extended.
  const extended = [
    isFingerExtended(landmarks, INDEX_TIP, INDEX_PIP),
    isFingerExtended(landmarks, MIDDLE_TIP, MIDDLE_PIP),
    isFingerExtended(landmarks, RING_TIP, RING_PIP),
    isFingerExtended(landmarks, PINKY_TIP, PINKY_PIP),
  ];
  const hasExtendedFingers = extended.some(Boolean);

  // 3. Palm & knuckle reference frame:
  const palmDx = middleMcp.x - wrist.x;
  const palmDy = middleMcp.y - wrist.y;
  const palmSpan = Math.hypot(palmDx, palmDy);
  if (palmSpan <= 0) return false;

  const ux = palmDx / palmSpan;
  const uy = palmDy / palmSpan;

  const knuckleDx = indexMcp.x - pinkyMcp.x;
  const knuckleDy = indexMcp.y - pinkyMcp.y;
  const knuckleSpan = Math.hypot(knuckleDx, knuckleDy);
  if (knuckleSpan <= 0) return false;

  // Reject collapsed knuckle frames
  if (knuckleSpan < palmSpan * MIN_KNUCKLE_PALM_RATIO) {
    return false;
  }

  const kx = knuckleDx / knuckleSpan;
  const ky = knuckleDy / knuckleSpan;

  const tdx = tip.x - cmc.x;
  const tdy = tip.y - cmc.y;
  const tLen = Math.hypot(tdx, tdy);
  if (tLen <= 0) return false;

  const cosPalmThumb = (tdx * ux + tdy * uy) / tLen;
  const cosKnuckleThumb = (tdx * kx + tdy * ky) / tLen;

  // Lateral distance from palm midline (wrist -> middleMcp) normalized by knuckle width:
  const refSpan = knuckleSpan > palmSpan * 0.15 ? knuckleSpan : palmSpan * 0.5;
  const vtx = tip.x - middleMcp.x;
  const vty = tip.y - middleMcp.y;
  const perpDist = Math.abs(vtx * uy - vty * ux);
  const lateralRatio = perpDist / refSpan;

  if (hasExtendedFingers) {
    // When >= 1 finger is extended (Poses 1 to 5):
    // A. Across-palm fold guard:
    // When the thumb folds across the palm towards middle, ring, or pinky base,
    // it points towards the pinky side across knuckles (cosKnuckleThumb < 0.10).
    // An open thumb points away from pinky past the index knuckle (cosKnuckleThumb >= 0.40).
    if (cosKnuckleThumb < THUMB_ACROSS_PALM_KNUCKLE_COS_MIN) {
      return false;
    }

    // B. Along-index fold guard:
    // When the thumb is tucked along the extended index finger (Poses 1 and 4),
    // it runs parallel to the palm axis (cosPalmThumb > 0.85) and stays laterally close (lateralRatio < 0.55).
    // An open thumb at 25° splay has lateralRatio >= 0.64.
    if (
      cosPalmThumb > THUMB_ALONG_INDEX_COS_MIN &&
      lateralRatio < THUMB_ALONG_INDEX_LATERAL_MAX
    ) {
      return false;
    }
  } else {
    // When 0 other fingers are extended (Fist vs Thumbs-Up):
    // A. If the thumb is folded across the curled fingers towards pinky:
    if (cosKnuckleThumb < THUMB_ACROSS_PALM_KNUCKLE_COS_MIN) {
      return false;
    }

    // B. Fist joints envelope:
    const fistJointIndices = [5, 6, 9, 10, 13, 14, 17, 18];
    let maxFistProj = 0;
    for (const idx of fistJointIndices) {
      const lm = landmarks[idx];
      if (lm && Number.isFinite(lm.x) && Number.isFinite(lm.y)) {
        const p = (lm.x - wrist.x) * ux + (lm.y - wrist.y) * uy;
        if (p > maxFistProj) maxFistProj = p;
      }
    }
    const thumbProj = (tip.x - wrist.x) * ux + (tip.y - wrist.y) * uy;

    // In a fist with thumb resting along index or on knuckles, thumbProj does not reach past the fist.
    if (cosPalmThumb > THUMB_ALONG_INDEX_COS_MIN) {
      if (maxFistProj > 0 && thumbProj <= maxFistProj * 1.02) {
        return false;
      }
    } else {
      if (
        maxFistProj > 0 &&
        thumbProj <= maxFistProj * 1.02 &&
        lateralRatio < THUMB_ALONG_INDEX_LATERAL_MAX
      ) {
        return false;
      }
    }
  }

  // 4. Axis envelope (only meaningful when a finger is extended to define
  //    the axis) — rejects the phantom thumb painted past the fingertips.
  if (wrist && middleMcp && hasExtendedFingers) {
    const cx = (wrist.x + middleMcp.x) / 2;
    const cy = (wrist.y + middleMcp.y) / 2;
    const palmSpan = dist(wrist, middleMcp);
    let env = 0;
    let ax = 0;
    let ay = -1;
    for (let i = 0; i < 4; i++) {
      if (!extended[i]) continue;
      const tipLm = landmarks[[INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP][i]];
      const dx = tipLm.x - cx;
      const dy = tipLm.y - cy;
      const d = Math.hypot(dx, dy);
      if (d > env) {
        env = d;
        ax = dx / d;
        ay = dy / d;
      }
    }
    if (env >= palmSpan * MIN_FINGER_ENVELOPE_PALMS) {
      const proj = (tip.x - cx) * ax + (tip.y - cy) * ay;
      if (proj > env * THUMB_AXIS_ENVELOPE_RATIO) {
        return false;
      }
    }
  }

  return true;
}

/** Count extended fingers (0–5). Pure geometry — no handedness involved. */
export function countExtendedFingers(landmarks: Landmark[]): number {
  let count = 0;
  if (isFingerExtended(landmarks, INDEX_TIP, INDEX_PIP)) count++;
  if (isFingerExtended(landmarks, MIDDLE_TIP, MIDDLE_PIP)) count++;
  if (isFingerExtended(landmarks, RING_TIP, RING_PIP)) count++;
  if (isFingerExtended(landmarks, PINKY_TIP, PINKY_PIP)) count++;
  if (isThumbExtended(landmarks)) count++;
  return count;
}

/**
 * Map a 1-based finger count to a 0-based option index. The single owner of
 * the clamp: returns `null` when `fingerCount` is outside `1..optionCount`
 * (covers 0 fingers, >5 fingers, and finger-count > option-count such as 4
 * fingers on a true/false question). Non-integer counts are rejected (the
 * tracker only ever produces integers, but the clamp is the single authority).
 */
export function mapFingersToOption(
  fingerCount: number,
  optionCount: number,
): number | null {
  if (optionCount <= 0) return null;
  if (!Number.isInteger(fingerCount) || fingerCount < 1 || fingerCount > optionCount) {
    return null;
  }
  return fingerCount - 1;
}

/**
 * Convert a MediaPipe detection result into a `HandFrame`. Pure and testable —
 * the browser glue (`hand-tracker.ts`) calls this; it has no DOM dependency.
 *
 * - No landmarks (or < 21 points) → `{ handPresent: false, fingerCount: 0 }`.
 * - Otherwise counts extended fingers from the 2D screen landmarks (see the
 *   module doc for why the metric `worldLandmarks` copy is deliberately
 *   ignored). Handedness is reported on the frame for the UI but never used
 *   for counting.
 */
export function landmarksToHandFrame(results: {
  landmarks?: Landmark[][];
  handedness?: { categoryName?: string }[][];
}): HandFrame {
  const landmarks = results.landmarks?.[0];
  if (!landmarks || landmarks.length < 21) {
    return { handPresent: false, fingerCount: 0 };
  }
  const handednessName = results.handedness?.[0]?.[0]?.categoryName;
  const handedness: Handedness | undefined =
    handednessName === "Left" || handednessName === "Right" ? handednessName : undefined;
  return {
    handPresent: true,
    fingerCount: countExtendedFingers(landmarks),
    handedness,
  };
}
