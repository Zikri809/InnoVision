import { describe, it, expect } from "vitest";
import {
  countExtendedFingers,
  isFingerExtended,
  isThumbExtended,
  landmarksToHandFrame,
  mapFingersToOption,
} from "./finger-count";
import type { Landmark } from "./types";

/**
 * Parametric 2D hand fixture. Upright pose: wrist at the bottom, palm axis
 * pointing up the screen (-y), fingers splayed slightly. Every claim the
 * implementation makes is projection-derived, so the builder composes:
 *  - `tiltDeg`: rigid rotation of the WHOLE hand about the wrist (in-plane
 *    orientation — must never change a count).
 *  - `squashY`: anisotropic y-scale about the wrist (simulates out-of-plane
 *    palm tilt / foreshortening — straight chains stay colinear and their
 *    bone-length ratios are preserved, so counts must also never change).
 * Thumb poses: "out" (splayed sideways, straight), "tucked" (flexed ~75°),
 * "across" (straight but folded flat toward the pinky base — the hiding
 * pose), "phantom" (straight chain running PAST the fingertips — the
 * jaw-line hallucination from the 4-finger screenshot).
 */
type FingerName = "index" | "middle" | "ring" | "pinky";
type ThumbPose = "out" | "tucked" | "across" | "across-mid" | "along-index" | "phantom" | "thumbs-up-straight";
type FingerBendSpec = number | { pip?: number; dip?: number };
type Pt = { x: number; y: number; z?: number };

function rotateAbout(p: Pt, cx: number, cy: number, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = p.x - cx;
  const dy = p.y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos, z: p.z };
}

function buildHand(opts: {
  fingers?: FingerName[];
  thumb?: ThumbPose;
  thumbSplayDeg?: number;
  tiltDeg?: number;
  squashY?: number;
  squashX?: number;
  mirrorX?: boolean;
  jitter?: number;
  curlDirection?: "normal" | "downward";
  fingerBends?: Partial<Record<FingerName, FingerBendSpec>>;
  knuckleCollapse?: number;
}): Landmark[] {
  const extended = new Set(opts.fingers ?? []);
  const lm: Pt[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));

  const wrist = { x: 0.5, y: 0.9 };
  lm[0] = { ...wrist };
  lm[9] = { x: 0.48, y: 0.775 }; // middle-finger MCP (palm-length reference)

  const knuckles: Record<FingerName, { joint: Pt; splay: number }> = {
    index: { joint: { x: 0.44, y: 0.78 }, splay: -0.02 },
    middle: { joint: { x: 0.48, y: 0.775 }, splay: 0 },
    ring: { joint: { x: 0.52, y: 0.78 }, splay: 0.02 },
    pinky: { joint: { x: 0.56, y: 0.79 }, splay: 0.04 },
  };
  const indices: Record<FingerName, [number, number, number, number]> = {
    index: [5, 6, 7, 8],
    middle: [9, 10, 11, 12],
    ring: [13, 14, 15, 16],
    pinky: [17, 18, 19, 20],
  };
  for (const name of ["index", "middle", "ring", "pinky"] as FingerName[]) {
    const { joint, splay } = knuckles[name];
    const uLen = Math.hypot(splay, 1);
    const u = { x: splay / uLen, y: -1 / uLen };
    const [mcp, pip, dip, tip] = indices[name];
    lm[mcp] = { ...joint };
    if (opts.fingerBends?.[name] !== undefined) {
      const bendSpec = opts.fingerBends[name]!;
      const pipDeg = typeof bendSpec === "number" ? bendSpec : (bendSpec.pip ?? 0);
      const dipDeg = typeof bendSpec === "number" ? 0 : (bendSpec.dip ?? 0);
      const pipRad = (pipDeg * Math.PI) / 180;
      const bx = u.x * Math.cos(pipRad) - u.y * Math.sin(pipRad);
      const by = u.x * Math.sin(pipRad) + u.y * Math.cos(pipRad);
      const totalRad = ((pipDeg + dipDeg) * Math.PI) / 180;
      const tx = u.x * Math.cos(totalRad) - u.y * Math.sin(totalRad);
      const ty = u.x * Math.sin(totalRad) + u.y * Math.cos(totalRad);
      const dipLen = typeof bendSpec === "number" ? 0.015 : 0.03;
      lm[pip] = { x: joint.x + u.x * 0.07, y: joint.y + u.y * 0.07 };
      lm[dip] = { x: lm[pip].x + bx * 0.035, y: lm[pip].y + by * 0.035 };
      lm[tip] = { x: lm[dip].x + tx * dipLen, y: lm[dip].y + ty * dipLen };
    } else if (extended.has(name)) {
      lm[pip] = { x: joint.x + u.x * 0.07, y: joint.y + u.y * 0.07 };
      lm[dip] = { x: joint.x + u.x * 0.105, y: joint.y + u.y * 0.105 };
      lm[tip] = { x: joint.x + u.x * 0.12, y: joint.y + u.y * 0.12 }; // colinear
    } else if (opts.curlDirection === "downward") {
      // Downward curled: MCP->PIP and PIP->TIP both point down on screen (+y)
      lm[pip] = { x: joint.x, y: joint.y + 0.06 };
      lm[dip] = { x: joint.x, y: joint.y + 0.09 };
      lm[tip] = { x: joint.x, y: joint.y + 0.11 };
    } else {
      // 90° bend at the PIP (folded): cos = 0 — decisively not straight.
      lm[pip] = { x: joint.x + u.x * 0.07, y: joint.y + u.y * 0.07 };
      lm[tip] = { x: lm[pip].x - u.y * 0.05, y: lm[pip].y + u.x * 0.05 };
      lm[dip] = { x: (lm[pip].x + lm[tip].x) / 2, y: (lm[pip].y + lm[tip].y) / 2 };
    }
  }

  if (opts.knuckleCollapse !== undefined) {
    const midX = 0.5;
    for (const idx of [5, 9, 13, 17]) {
      lm[idx] = {
        ...lm[idx],
        x: midX + (lm[idx].x - midX) * opts.knuckleCollapse,
      };
    }
  }

  if (opts.thumbSplayDeg !== undefined) {
    const rad = (opts.thumbSplayDeg * Math.PI) / 180;
    const ux = -Math.sin(rad);
    const uy = -Math.cos(rad);
    lm[1] = { x: 0.45, y: 0.87 };
    lm[2] = { x: lm[1].x + ux * 0.04, y: lm[1].y + uy * 0.04 };
    lm[3] = { x: lm[1].x + ux * 0.08, y: lm[1].y + uy * 0.08 };
    lm[4] = { x: lm[1].x + ux * 0.12, y: lm[1].y + uy * 0.12 };
  } else {
    switch (opts.thumb ?? "tucked") {
      case "out": {
        // Splayed left, perfectly straight chain (~0.95× palm length).
        lm[1] = { x: 0.45, y: 0.87 };
        lm[2] = { x: 0.41, y: 0.855 };
        lm[3] = { x: 0.37, y: 0.84 };
        lm[4] = { x: 0.33, y: 0.825 };
        break;
      }
      case "tucked": {
        // Flexed ~75° at the MCP — never counts.
        lm[1] = { x: 0.45, y: 0.87 };
        lm[2] = { x: 0.42, y: 0.855 };
        lm[3] = { x: 0.405, y: 0.875 };
        lm[4] = { x: 0.415, y: 0.895 };
        break;
      }
      case "across": {
        // Straight chain folded flat across the palm, tip landing near the
        // pinky base (dist(TIP,17)/dist(IP,17) ≈ 0.64) — the hiding pose.
        lm[1] = { x: 0.43, y: 0.875 };
        lm[2] = { x: 0.46, y: 0.86 };
        lm[3] = { x: 0.49, y: 0.845 };
        lm[4] = { x: 0.52, y: 0.83 };
        break;
      }
      case "across-mid": {
        // Straight chain folded across the palm with tip over middle/ring metacarpals
        lm[1] = { x: 0.45, y: 0.87 };
        lm[2] = { x: 0.465, y: 0.85 };
        lm[3] = { x: 0.48, y: 0.83 };
        lm[4] = { x: 0.495, y: 0.81 };
        break;
      }
      case "along-index": {
        // Straight chain tucked alongside the index finger (natural pose when
        // showing 1 or 4) — lands parallel to the palm/index axis.
        lm[1] = { x: 0.45, y: 0.87 };
        lm[2] = { x: 0.435, y: 0.82 };
        lm[3] = { x: 0.425, y: 0.77 };
        lm[4] = { x: 0.42, y: 0.72 };
        break;
      }
      case "phantom": {
        // Jaw-line hallucination: colinear chain whose tip reaches well past
        // the extended fingertips (y 0.57 vs ~0.66).
        lm[1] = { x: 0.47, y: 0.87 };
        lm[2] = { x: 0.4747, y: 0.8267 };
        lm[3] = { x: 0.4793, y: 0.7833 };
        lm[4] = { x: 0.5027, y: 0.5667 };
        break;
      }
      case "thumbs-up-straight": {
        // Thumb pointing straight up, tip reaching past fist knuckles (0.65)
        lm[1] = { x: 0.45, y: 0.87 };
        lm[2] = { x: 0.44, y: 0.80 };
        lm[3] = { x: 0.43, y: 0.73 };
        lm[4] = { x: 0.42, y: 0.65 };
        break;
      }
    }
  }

  if (opts.mirrorX) {
    for (let i = 0; i < 21; i++) {
      lm[i] = {
        ...lm[i],
        x: 1 - lm[i].x,
      };
    }
  }

  if (opts.squashX !== undefined) {
    const midX = opts.mirrorX ? 1 - wrist.x : wrist.x;
    for (let i = 0; i < 21; i++) {
      lm[i] = {
        ...lm[i],
        x: midX + (lm[i].x - midX) * opts.squashX,
      };
    }
  }

  if (opts.squashY !== undefined) {
    for (let i = 0; i < 21; i++) {
      lm[i] = {
        ...lm[i],
        y: wrist.y + (lm[i].y - wrist.y) * opts.squashY,
      };
    }
  }

  if (opts.jitter !== undefined && opts.jitter > 0) {
    for (let i = 0; i < 21; i++) {
      // Deterministic pseudo-jitter to maintain test reproducibility
      const jx = Math.sin((i + 1) * 3.7) * opts.jitter;
      const jy = Math.cos((i + 1) * 5.1) * opts.jitter;
      lm[i] = {
        ...lm[i],
        x: lm[i].x + jx,
        y: lm[i].y + jy,
      };
    }
  }

  const tilt = opts.tiltDeg ?? 0;
  if (tilt !== 0) {
    const pivotX = opts.mirrorX ? 1 - wrist.x : wrist.x;
    for (let i = 0; i < 21; i++) {
      lm[i] = rotateAbout(lm[i], pivotX, wrist.y, tilt);
    }
  }
  return lm.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 }));
}

describe("2D joint-angle counting — basic counts", () => {
  it("counts 0 for a fist (all fingers folded, thumb tucked or along index)", () => {
    expect(countExtendedFingers(buildHand({}))).toBe(0);
    expect(countExtendedFingers(buildHand({ thumb: "along-index" }))).toBe(0);
    expect(countExtendedFingers(buildHand({ thumb: "across" }))).toBe(0);
    expect(countExtendedFingers(buildHand({ thumb: "across-mid" }))).toBe(0);
  });

  it("counts 1 for index only (thumb tucked, across, or along index)", () => {
    expect(countExtendedFingers(buildHand({ fingers: ["index"] }))).toBe(1);
    expect(countExtendedFingers(buildHand({ fingers: ["index"], thumb: "across" }))).toBe(1);
    expect(countExtendedFingers(buildHand({ fingers: ["index"], thumb: "across-mid" }))).toBe(1);
  });

  it("counts 2 for index + middle", () => {
    expect(countExtendedFingers(buildHand({ fingers: ["index", "middle"] }))).toBe(2);
  });

  it("counts 3 for index + middle + ring", () => {
    expect(
      countExtendedFingers(buildHand({ fingers: ["index", "middle", "ring"] })),
    ).toBe(3);
  });

  it("counts 4 for index..pinky (thumb tucked)", () => {
    expect(
      countExtendedFingers(
        buildHand({ fingers: ["index", "middle", "ring", "pinky"] }),
      ),
    ).toBe(4);
  });

  it("counts 5 with the thumb splayed sideways (back-of-palm screenshot pose)", () => {
    expect(
      countExtendedFingers(
        buildHand({ fingers: ["index", "middle", "ring", "pinky"], thumb: "out" }),
      ),
    ).toBe(5);
  });

  it("counts 1 for a thumbs-up (both splayed out and pointing straight up)", () => {
    expect(countExtendedFingers(buildHand({ thumb: "out" }))).toBe(1);
    expect(countExtendedFingers(buildHand({ thumb: "thumbs-up-straight" }))).toBe(1);
  });

  it("counts 2 for the gun pose (index + splayed thumb beside it)", () => {
    expect(countExtendedFingers(buildHand({ fingers: ["index"], thumb: "out" }))).toBe(2);
  });
});

describe("thumb guards — tucked, across-palm fold, along-index fold, jaw phantom", () => {
  it("does NOT count a tucked flexed thumb (4 fingers stay 4)", () => {
    expect(
      countExtendedFingers(
        buildHand({ fingers: ["index", "middle", "ring", "pinky"], thumb: "tucked" }),
      ),
    ).toBe(4);
  });

  it("does NOT count a straight thumb folded across the palm toward the pinky base", () => {
    expect(
      countExtendedFingers(
        buildHand({ fingers: ["index", "middle", "ring", "pinky"], thumb: "across" }),
      ),
    ).toBe(4);
    expect(
      countExtendedFingers(
        buildHand({ fingers: ["index", "middle", "ring", "pinky"], thumb: "across-mid" }),
      ),
    ).toBe(4);
  });

  it("does NOT count a straight thumb tucked along the index finger (1 finger stays 1, never 2)", () => {
    // Both index-only and thumb-tucked variants evaluate to 1 (never 2)
    expect(countExtendedFingers(buildHand({ fingers: ["index"], thumb: "tucked" }))).toBe(1);
    expect(countExtendedFingers(buildHand({ fingers: ["index"], thumb: "along-index" }))).toBe(1);
  });

  it("does NOT count a straight thumb tucked along the index finger (4 fingers stay 4, never 5)", () => {
    // Both thumb-tucked-along-index and thumb-across-palm evaluate to 4 (never 5)
    expect(
      countExtendedFingers(
        buildHand({ fingers: ["index", "middle", "ring", "pinky"], thumb: "along-index" }),
      ),
    ).toBe(4);
    expect(
      countExtendedFingers(
        buildHand({ fingers: ["index", "middle", "ring", "pinky"], thumb: "across" }),
      ),
    ).toBe(4);
  });

  it("rejects the jaw-line phantom: straight chain reaching past the fingertips (4 stays 4)", () => {
    expect(
      countExtendedFingers(
        buildHand({ fingers: ["index", "middle", "ring", "pinky"], thumb: "phantom" }),
      ),
    ).toBe(4);
  });

  it("rejects the phantom with a single extended finger (the held-1 face-height pose)", () => {
    expect(countExtendedFingers(buildHand({ fingers: ["index"], thumb: "phantom" }))).toBe(1);
  });

  it("isThumbExtended: missing landmarks are rejected", () => {
    expect(isThumbExtended([])).toBe(false);
    expect(isThumbExtended([{ x: 0, y: 0, z: 0 }])).toBe(false);
  });
});

describe("projection invariance — palm orientation must never change a count", () => {
  const TILTS = [47, 90, 143, 180, 233, 270, 317];
  const IN_PLANE_ROTATIONS = [-60, -45, -30, -15, 0, 15, 30, 45, 60];

  it("poses 0 through 5 maintain correct counts across in-plane rotations from -60° to +60°", () => {
    for (const deg of IN_PLANE_ROTATIONS) {
      // 0 fingers / fist
      expect(countExtendedFingers(buildHand({ tiltDeg: deg }))).toBe(0);
      expect(countExtendedFingers(buildHand({ thumb: "along-index", tiltDeg: deg }))).toBe(0);
      expect(countExtendedFingers(buildHand({ thumb: "across-mid", tiltDeg: deg }))).toBe(0);

      // Thumbs-up (both upright and splayed out)
      expect(countExtendedFingers(buildHand({ thumb: "thumbs-up-straight", tiltDeg: deg }))).toBe(1);
      expect(countExtendedFingers(buildHand({ thumb: "out", tiltDeg: deg }))).toBe(1);

      // 1 finger (index-only, thumb-tucked, along-index, and across-mid variants)
      expect(
        countExtendedFingers(buildHand({ fingers: ["index"], thumb: "tucked", tiltDeg: deg })),
      ).toBe(1);
      expect(
        countExtendedFingers(
          buildHand({ fingers: ["index"], thumb: "along-index", tiltDeg: deg }),
        ),
      ).toBe(1);
      expect(
        countExtendedFingers(
          buildHand({ fingers: ["index"], thumb: "across-mid", tiltDeg: deg }),
        ),
      ).toBe(1);

      // 2 fingers
      expect(
        countExtendedFingers(buildHand({ fingers: ["index", "middle"], tiltDeg: deg })),
      ).toBe(2);

      // 3 fingers
      expect(
        countExtendedFingers(
          buildHand({ fingers: ["index", "middle", "ring"], tiltDeg: deg }),
        ),
      ).toBe(3);

      // 4 fingers (thumb-tucked-along-index, thumb-across-pinky, and thumb-across-mid variants)
      expect(
        countExtendedFingers(
          buildHand({
            fingers: ["index", "middle", "ring", "pinky"],
            thumb: "along-index",
            tiltDeg: deg,
          }),
        ),
      ).toBe(4);
      expect(
        countExtendedFingers(
          buildHand({
            fingers: ["index", "middle", "ring", "pinky"],
            thumb: "across",
            tiltDeg: deg,
          }),
        ),
      ).toBe(4);
      expect(
        countExtendedFingers(
          buildHand({
            fingers: ["index", "middle", "ring", "pinky"],
            thumb: "across-mid",
            tiltDeg: deg,
          }),
        ),
      ).toBe(4);

      // 5 fingers (thumb splayed out)
      expect(
        countExtendedFingers(
          buildHand({
            fingers: ["index", "middle", "ring", "pinky"],
            thumb: "out",
            tiltDeg: deg,
          }),
        ),
      ).toBe(5);
    }
  });

  it("full hand (5) counts 5 at every in-plane tilt", () => {
    for (const tilt of TILTS) {
      expect(
        countExtendedFingers(
          buildHand({
            fingers: ["index", "middle", "ring", "pinky"],
            thumb: "out",
            tiltDeg: tilt,
          }),
        ),
      ).toBe(5);
    }
  });

  it("fist counts 0 at every in-plane tilt", () => {
    for (const tilt of TILTS) {
      expect(countExtendedFingers(buildHand({ tiltDeg: tilt }))).toBe(0);
    }
  });

  it("3 fingers (folded pinky) count 3 at every in-plane tilt — the original 3→4 regression", () => {
    for (const tilt of TILTS) {
      expect(
        countExtendedFingers(
          buildHand({ fingers: ["index", "middle", "ring"], tiltDeg: tilt }),
        ),
      ).toBe(3);
    }
  });

  it("out-of-plane foreshortening (y-squash 0.5) never changes counts", () => {
    expect(
      countExtendedFingers(
        buildHand({
          fingers: ["index", "middle", "ring", "pinky"],
          thumb: "out",
          squashY: 0.5,
        }),
      ),
    ).toBe(5);
    expect(
      countExtendedFingers(buildHand({ fingers: ["index", "middle", "ring"], squashY: 0.5 })),
    ).toBe(3);
    expect(countExtendedFingers(buildHand({ squashY: 0.5 }))).toBe(0);
  });

  it("poses 0 through 5 maintain counts under side-angle camera perspectives (squashX 0.35)", () => {
    // 0 fingers (fist with along-index, across, or tucked thumb under side angle)
    expect(countExtendedFingers(buildHand({ thumb: "along-index", squashX: 0.35 }))).toBe(0);
    expect(countExtendedFingers(buildHand({ thumb: "across", squashX: 0.35 }))).toBe(0);
    expect(countExtendedFingers(buildHand({ thumb: "tucked", squashX: 0.35 }))).toBe(0);

    // 1 finger (index extended, thumb along index) under side angle
    expect(
      countExtendedFingers(
        buildHand({ fingers: ["index"], thumb: "along-index", squashX: 0.35 }),
      ),
    ).toBe(1);

    // 2 fingers under side angle
    expect(
      countExtendedFingers(
        buildHand({ fingers: ["index", "middle"], thumb: "along-index", squashX: 0.35 }),
      ),
    ).toBe(2);

    // 3 fingers under side angle
    expect(
      countExtendedFingers(
        buildHand({ fingers: ["index", "middle", "ring"], thumb: "along-index", squashX: 0.35 }),
      ),
    ).toBe(3);

    // 4 fingers (thumb along index or across) under side angle
    expect(
      countExtendedFingers(
        buildHand({
          fingers: ["index", "middle", "ring", "pinky"],
          thumb: "along-index",
          squashX: 0.35,
        }),
      ),
    ).toBe(4);
    expect(
      countExtendedFingers(
        buildHand({
          fingers: ["index", "middle", "ring", "pinky"],
          thumb: "across",
          squashX: 0.35,
        }),
      ),
    ).toBe(4);

    // 5 fingers under side angle
    expect(
      countExtendedFingers(
        buildHand({
          fingers: ["index", "middle", "ring", "pinky"],
          thumb: "out",
          squashX: 0.35,
        }),
      ),
    ).toBe(5);
  });

  it("maintains correct counts under combined side-angle perspective (squashX 0.5) and in-plane tilt (-45° to +45°)", () => {
    for (const deg of [-45, -30, 0, 30, 45]) {
      // 0 fingers
      expect(countExtendedFingers(buildHand({ thumb: "along-index", squashX: 0.5, tiltDeg: deg }))).toBe(0);
      expect(countExtendedFingers(buildHand({ thumb: "across", squashX: 0.5, tiltDeg: deg }))).toBe(0);
      expect(countExtendedFingers(buildHand({ thumb: "across-mid", squashX: 0.5, tiltDeg: deg }))).toBe(0);

      // Thumbs-up
      expect(countExtendedFingers(buildHand({ thumb: "thumbs-up-straight", squashX: 0.5, tiltDeg: deg }))).toBe(1);
      expect(countExtendedFingers(buildHand({ thumb: "out", squashX: 0.5, tiltDeg: deg }))).toBe(1);

      // 1 finger
      expect(
        countExtendedFingers(
          buildHand({ fingers: ["index"], thumb: "along-index", squashX: 0.5, tiltDeg: deg }),
        ),
      ).toBe(1);
      expect(
        countExtendedFingers(
          buildHand({ fingers: ["index"], thumb: "across-mid", squashX: 0.5, tiltDeg: deg }),
        ),
      ).toBe(1);

      // 4 fingers
      expect(
        countExtendedFingers(
          buildHand({
            fingers: ["index", "middle", "ring", "pinky"],
            thumb: "along-index",
            squashX: 0.5,
            tiltDeg: deg,
          }),
        ),
      ).toBe(4);
      expect(
        countExtendedFingers(
          buildHand({
            fingers: ["index", "middle", "ring", "pinky"],
            thumb: "across",
            squashX: 0.5,
            tiltDeg: deg,
          }),
        ),
      ).toBe(4);
      expect(
        countExtendedFingers(
          buildHand({
            fingers: ["index", "middle", "ring", "pinky"],
            thumb: "across-mid",
            squashX: 0.5,
            tiltDeg: deg,
          }),
        ),
      ).toBe(4);

      // 5 fingers
      expect(
        countExtendedFingers(
          buildHand({
            fingers: ["index", "middle", "ring", "pinky"],
            thumb: "out",
            squashX: 0.5,
            tiltDeg: deg,
          }),
        ),
      ).toBe(5);
    }
  });

  it("pose 5 maintains count 5 across natural thumb splay angles (25° to 70°) and side angles (squashX 0.35 to 0.7)", () => {
    for (const splay of [25, 30, 35, 40, 45, 55, 70]) {
      for (const sx of [1.0, 0.7, 0.5, 0.4, 0.35]) {
        expect(
          countExtendedFingers(
            buildHand({
              fingers: ["index", "middle", "ring", "pinky"],
              thumbSplayDeg: splay,
              squashX: sx,
            }),
          ),
        ).toBe(5);
      }
    }
  });

  it("mirrored Left hand maintains identical counts across all poses (0 to 5) and tilts", () => {
    for (const deg of [-45, 0, 45]) {
      // 0 fingers
      expect(countExtendedFingers(buildHand({ mirrorX: true, thumb: "along-index", tiltDeg: deg }))).toBe(0);
      expect(countExtendedFingers(buildHand({ mirrorX: true, thumb: "across", tiltDeg: deg }))).toBe(0);
      expect(countExtendedFingers(buildHand({ mirrorX: true, thumb: "across-mid", tiltDeg: deg }))).toBe(0);

      // Thumbs-up
      expect(countExtendedFingers(buildHand({ mirrorX: true, thumb: "thumbs-up-straight", tiltDeg: deg }))).toBe(1);
      expect(countExtendedFingers(buildHand({ mirrorX: true, thumb: "out", tiltDeg: deg }))).toBe(1);

      // 1 finger
      expect(
        countExtendedFingers(
          buildHand({ mirrorX: true, fingers: ["index"], thumb: "along-index", tiltDeg: deg }),
        ),
      ).toBe(1);
      expect(
        countExtendedFingers(
          buildHand({ mirrorX: true, fingers: ["index"], thumb: "across-mid", tiltDeg: deg }),
        ),
      ).toBe(1);

      // 2 fingers
      expect(
        countExtendedFingers(
          buildHand({ mirrorX: true, fingers: ["index", "middle"], thumb: "along-index", tiltDeg: deg }),
        ),
      ).toBe(2);

      // 3 fingers
      expect(
        countExtendedFingers(
          buildHand({ mirrorX: true, fingers: ["index", "middle", "ring"], thumb: "along-index", tiltDeg: deg }),
        ),
      ).toBe(3);

      // 4 fingers
      expect(
        countExtendedFingers(
          buildHand({
            mirrorX: true,
            fingers: ["index", "middle", "ring", "pinky"],
            thumb: "along-index",
            tiltDeg: deg,
          }),
        ),
      ).toBe(4);
      expect(
        countExtendedFingers(
          buildHand({
            mirrorX: true,
            fingers: ["index", "middle", "ring", "pinky"],
            thumb: "across",
            tiltDeg: deg,
          }),
        ),
      ).toBe(4);
      expect(
        countExtendedFingers(
          buildHand({
            mirrorX: true,
            fingers: ["index", "middle", "ring", "pinky"],
            thumb: "across-mid",
            tiltDeg: deg,
          }),
        ),
      ).toBe(4);

      // 5 fingers
      expect(
        countExtendedFingers(
          buildHand({
            mirrorX: true,
            fingers: ["index", "middle", "ring", "pinky"],
            thumb: "out",
            tiltDeg: deg,
          }),
        ),
      ).toBe(5);
    }
  });

  it("maintains stable counts under simulated webcam sensor landmark jitter", () => {
    const JITTER_AMPLITUDE = 0.008; // realistic landmark jitter in low-light / noisy conditions
    for (const deg of [-30, 0, 30]) {
      // Fist with along-index thumb stays 0
      expect(
        countExtendedFingers(
          buildHand({ thumb: "along-index", jitter: JITTER_AMPLITUDE, tiltDeg: deg }),
        ),
      ).toBe(0);

      // Pose 1 with along-index thumb stays 1 (never 2)
      expect(
        countExtendedFingers(
          buildHand({
            fingers: ["index"],
            thumb: "along-index",
            jitter: JITTER_AMPLITUDE,
            tiltDeg: deg,
          }),
        ),
      ).toBe(1);

      // Pose 4 with along-index thumb stays 4 (never 5)
      expect(
        countExtendedFingers(
          buildHand({
            fingers: ["index", "middle", "ring", "pinky"],
            thumb: "along-index",
            jitter: JITTER_AMPLITUDE,
            tiltDeg: deg,
          }),
        ),
      ).toBe(4);

      // Pose 5 stays 5
      expect(
        countExtendedFingers(
          buildHand({
            fingers: ["index", "middle", "ring", "pinky"],
            thumb: "out",
            jitter: JITTER_AMPLITUDE,
            tiltDeg: deg,
          }),
        ),
      ).toBe(5);
    }
  });
});

describe("downward-curled finger rejection in palm-facing view", () => {
  it("evaluates downward-curled fingers (MCP->PIP and PIP->TIP both point down on screen) as folded, not extended", () => {
    const indices: Record<FingerName, [number, number]> = {
      index: [8, 6],
      middle: [12, 10],
      ring: [16, 14],
      pinky: [20, 18],
    };
    const handDownCurled = buildHand({ curlDirection: "downward" });
    for (const name of ["index", "middle", "ring", "pinky"] as FingerName[]) {
      const [tip, pip] = indices[name];
      expect(isFingerExtended(handDownCurled, tip, pip)).toBe(false);
    }
    // Full hand with downward-curled fingers evaluates to 0 (fist)
    expect(countExtendedFingers(handDownCurled)).toBe(0);
  });

  it("accurately counts extended fingers when non-extended fingers are curled downward", () => {
    // Holding 1 with remaining digits downward-curled
    expect(
      countExtendedFingers(
        buildHand({ fingers: ["index"], thumb: "tucked", curlDirection: "downward" }),
      ),
    ).toBe(1);
    expect(
      countExtendedFingers(
        buildHand({ fingers: ["index"], thumb: "along-index", curlDirection: "downward" }),
      ),
    ).toBe(1);

    // Holding 2 with remaining digits downward-curled
    expect(
      countExtendedFingers(
        buildHand({ fingers: ["index", "middle"], curlDirection: "downward" }),
      ),
    ).toBe(2);

    // Holding 3 with remaining digits downward-curled
    expect(
      countExtendedFingers(
        buildHand({ fingers: ["index", "middle", "ring"], curlDirection: "downward" }),
      ),
    ).toBe(3);
  });

  it("maintains folded evaluation of downward-curled fingers across in-plane rotations (-60° to +60°)", () => {
    for (const deg of [-60, -45, -30, -15, 0, 15, 30, 45, 60]) {
      const lm = buildHand({ curlDirection: "downward", tiltDeg: deg });
      expect(isFingerExtended(lm, 8, 6)).toBe(false); // index
      expect(isFingerExtended(lm, 12, 10)).toBe(false); // middle
      expect(isFingerExtended(lm, 16, 14)).toBe(false); // ring
      expect(isFingerExtended(lm, 20, 18)).toBe(false); // pinky
      expect(countExtendedFingers(lm)).toBe(0);
    }
  });
});

describe("length-ratio guard — hallucinated stub tips", () => {
  it("rejects a colinear but stubby tip (PIP→TIP far shorter than MCP→PIP)", () => {
    const lm = buildHand({});
    // Index chain colinear but the tip only 0.02 past the PIP (ratio ≈ 0.29).
    lm[5] = { x: 0.44, y: 0.78, z: 0 };
    lm[6] = { x: 0.44, y: 0.71, z: 0 };
    lm[7] = { x: 0.44, y: 0.695, z: 0 };
    lm[8] = { x: 0.44, y: 0.69, z: 0 };
    expect(isFingerExtended(lm, 8, 6)).toBe(false);
    expect(countExtendedFingers(lm)).toBe(0);
  });

  it("isFingerExtended: missing landmarks are rejected", () => {
    expect(isFingerExtended([], 8, 6)).toBe(false);
    expect(isFingerExtended([{ x: 0, y: 0, z: 0 }], 8, 6)).toBe(false);
  });

  it("rejects landmarks with NaN or non-finite coordinates", () => {
    const lm = buildHand({ fingers: ["index"] });
    lm[8] = { x: Number.NaN, y: Number.NaN, z: 0 };
    expect(isFingerExtended(lm, 8, 6)).toBe(false);
    expect(countExtendedFingers(lm)).toBe(0);

    const lmInf = buildHand({ fingers: ["index"] });
    lmInf[8] = { x: Number.POSITIVE_INFINITY, y: 0.5, z: 0 };
    expect(isFingerExtended(lmInf, 8, 6)).toBe(false);
    expect(countExtendedFingers(lmInf)).toBe(0);

    const lmThumb = buildHand({ fingers: [], thumb: "out" });
    lmThumb[4] = { x: Number.NaN, y: Number.NaN, z: 0 };
    expect(isThumbExtended(lmThumb)).toBe(false);
    expect(countExtendedFingers(lmThumb)).toBe(0);

    const lmThumbInf = buildHand({ fingers: [], thumb: "out" });
    lmThumbInf[4] = { x: Number.NEGATIVE_INFINITY, y: 0.5, z: 0 };
    expect(isThumbExtended(lmThumbInf)).toBe(false);
    expect(countExtendedFingers(lmThumbInf)).toBe(0);

    // Non-finite palm reference landmarks must not bypass guards or hallucinate extended thumb
    const lmCorruptWrist = buildHand({ thumb: "along-index" });
    lmCorruptWrist[0] = { x: Number.NaN, y: 0.9, z: 0 };
    expect(isThumbExtended(lmCorruptWrist)).toBe(false);
    expect(countExtendedFingers(lmCorruptWrist)).toBe(0);

    const lmCorruptMiddle = buildHand({ thumb: "along-index" });
    lmCorruptMiddle[9] = { x: Number.NaN, y: 0.775, z: 0 };
    expect(isThumbExtended(lmCorruptMiddle)).toBe(false);
    expect(countExtendedFingers(lmCorruptMiddle)).toBe(0);

    const lmCorruptPinky = buildHand({
      fingers: ["index", "middle", "ring", "pinky"],
      thumb: "along-index",
    });
    lmCorruptPinky[17] = { x: Number.NaN, y: 0.79, z: 0 };
    expect(isThumbExtended(lmCorruptPinky)).toBe(false);

    const lmCorruptIndex = buildHand({
      fingers: ["index", "middle", "ring", "pinky"],
      thumb: "along-index",
    });
    lmCorruptIndex[5] = { x: Number.NaN, y: 0.78, z: 0 };
    expect(isThumbExtended(lmCorruptIndex)).toBe(false);
  });

  it("degenerate zero-length bones are treated as NOT straight", () => {
    const lm = buildHand({ fingers: ["index"] });
    lm[5] = { x: 0.44, y: 0.71, z: 0 }; // MCP collapsed onto the PIP
    expect(isFingerExtended(lm, 8, 6)).toBe(false);

    // Palm collapsed: wrist collapsed onto middleMcp (palmSpan = 0)
    const lmCollapsedPalm = buildHand({ fingers: ["index", "middle", "ring", "pinky"], thumb: "out" });
    lmCollapsedPalm[0] = { ...lmCollapsedPalm[9] };
    expect(isThumbExtended(lmCollapsedPalm)).toBe(false);

    // Knuckles collapsed: pinkyMcp collapsed onto indexMcp (knuckleSpan = 0)
    const lmCollapsedKnuckles = buildHand({ fingers: ["index", "middle", "ring", "pinky"], thumb: "out" });
    lmCollapsedKnuckles[17] = { ...lmCollapsedKnuckles[5] };
    expect(isThumbExtended(lmCollapsedKnuckles)).toBe(false);

    // Thumb tip collapsed onto CMC (tLen = 0)
    const lmCollapsedThumb = buildHand({ fingers: ["index", "middle", "ring", "pinky"], thumb: "out" });
    lmCollapsedThumb[4] = { ...lmCollapsedThumb[1] };
    expect(isThumbExtended(lmCollapsedThumb)).toBe(false);
  });
});

describe("landmarksToHandFrame — MediaPipe result → HandFrame (pure, testable)", () => {
  it("returns handPresent:false when landmarks are absent or < 21 points", () => {
    expect(landmarksToHandFrame({})).toEqual({ handPresent: false, fingerCount: 0 });
    expect(
      landmarksToHandFrame({ landmarks: [buildHand({ fingers: ["index"] }).slice(0, 5)] }),
    ).toEqual({ handPresent: false, fingerCount: 0 });
  });

  it("counts extended fingers and passes handedness through (never used for counting)", () => {
    const frame = landmarksToHandFrame({
      landmarks: [buildHand({ fingers: ["index"], thumb: "out" })],
      handedness: [[{ categoryName: "Right" }]],
    });
    expect(frame.handPresent).toBe(true);
    expect(frame.fingerCount).toBe(2);
    expect(frame.handedness).toBe("Right");
  });

  it("normalizes unknown handedness to undefined", () => {
    const frame = landmarksToHandFrame({
      landmarks: [buildHand({})],
      handedness: [[{ categoryName: "Scissors" }]],
    });
    expect(frame.handPresent).toBe(true);
    expect(frame.handedness).toBeUndefined();
  });

  it("handles missing handedness arrays", () => {
    const frame = landmarksToHandFrame({ landmarks: [buildHand({ fingers: ["index"] })] });
    expect(frame.handPresent).toBe(true);
    expect(frame.fingerCount).toBe(1);
    expect(frame.handedness).toBeUndefined();
  });

  it("ignores the metric worldLandmarks copy entirely (predicted 3D is untrusted)", () => {
    // Collapsed garbage world points would zero every count if the
    // implementation ever read them — the 2D answer must win.
    const results = {
      landmarks: [buildHand({ fingers: ["index", "middle", "ring", "pinky"], thumb: "out" })],
      worldLandmarks: [Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }))],
      handedness: [[{ categoryName: "Right" }]],
    };
    expect(landmarksToHandFrame(results).fingerCount).toBe(5);
  });
});

describe("U-G2 — mapFingersToOption clamps 0 and >optionCount", () => {
  it("returns null for 0 and >5 fingers", () => {
    expect(mapFingersToOption(0, 4)).toBeNull();
    expect(mapFingersToOption(6, 5)).toBeNull();
  });

  it("full corner table", () => {
    expect(mapFingersToOption(0, 5)).toBeNull();
    expect(mapFingersToOption(1, 1)).toBe(0);
    expect(mapFingersToOption(4, 4)).toBe(3);
    expect(mapFingersToOption(5, 5)).toBe(4);
    expect(mapFingersToOption(5, 3)).toBeNull(); // > option count
    expect(mapFingersToOption(6, 5)).toBeNull();
    expect(mapFingersToOption(4, 2)).toBeNull(); // 4 fingers on a true/false
    expect(mapFingersToOption(3, 3)).toBe(2);
    expect(mapFingersToOption(2, 4)).toBe(1);
  });

  it("returns null for a non-positive option count", () => {
    expect(mapFingersToOption(1, 0)).toBeNull();
    expect(mapFingersToOption(1, -1)).toBeNull();
  });

  it("returns null for a non-integer finger count (clamp is the single authority)", () => {
    expect(mapFingersToOption(2.5, 4)).toBeNull();
    expect(mapFingersToOption(Number.NaN, 4)).toBeNull();
  });
});

describe("R1 & R5 — half-curl (25°–50°) bend rejection & pose differentiation", () => {
  it("a 30° half-curled finger evaluates to isFingerExtended === false", () => {
    // Acceptance criterion fixture: mcp(0.44, 0.78), pip(0.44, 0.71), tip(0.465, 0.6667)
    const lm: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    lm[0] = { x: 0.5, y: 0.9, z: 0 }; // WRIST
    lm[5] = { x: 0.44, y: 0.78, z: 0 }; // INDEX_MCP
    lm[6] = { x: 0.44, y: 0.71, z: 0 }; // INDEX_PIP
    lm[8] = { x: 0.465, y: 0.6667, z: 0 }; // INDEX_TIP
    lm[9] = { x: 0.48, y: 0.775, z: 0 }; // MIDDLE_MCP
    lm[17] = { x: 0.56, y: 0.79, z: 0 }; // PINKY_MCP

    expect(isFingerExtended(lm, 8, 6)).toBe(false);
  });

  it("evaluates bend angles 25°, 30°, 35°, 40°, 45°, 50°, and 55° as folded for all fingers", () => {
    const BEND_ANGLES = [25, 30, 35, 40, 45, 50, 55];
    const FINGERS: FingerName[] = ["index", "middle", "ring", "pinky"];
    const indices: Record<FingerName, [number, number]> = {
      index: [8, 6],
      middle: [12, 10],
      ring: [16, 14],
      pinky: [20, 18],
    };

    for (const finger of FINGERS) {
      const [tip, pip] = indices[finger];
      for (const bend of BEND_ANGLES) {
        const hand = buildHand({
          fingerBends: { [finger]: bend },
        });
        expect(isFingerExtended(hand, tip, pip)).toBe(false);
      }
    }
  });

  it("evaluates truly straight fingers (0° to 20° bend) as extended", () => {
    const EXTENDED_ANGLES = [0, 5, 10, 15, 20];
    const indices: Record<FingerName, [number, number]> = {
      index: [8, 6],
      middle: [12, 10],
      ring: [16, 14],
      pinky: [20, 18],
    };

    for (const finger of ["index", "middle", "ring", "pinky"] as FingerName[]) {
      const [tip, pip] = indices[finger];
      for (const bend of EXTENDED_ANGLES) {
        const hand = buildHand({
          fingerBends: { [finger]: bend },
        });
        expect(isFingerExtended(hand, tip, pip)).toBe(true);
      }
    }
  });

  it("evaluates 3-finger pose with relaxed half-curled pinky as count 3 (never 4)", () => {
    for (const bend of [25, 30, 35, 40, 45, 50]) {
      const hand = buildHand({
        fingers: ["index", "middle", "ring"],
        fingerBends: { pinky: bend },
        thumb: "tucked",
      });
      expect(countExtendedFingers(hand)).toBe(3);
    }
  });

  it("evaluates 2-finger pose with relaxed ring and pinky as count 2 (never 3)", () => {
    for (const bend of [25, 30, 35, 40, 45]) {
      const hand = buildHand({
        fingers: ["index", "middle"],
        fingerBends: { ring: bend, pinky: bend },
        thumb: "tucked",
      });
      expect(countExtendedFingers(hand)).toBe(2);
    }
  });

  it("evaluates distributed half-curls across PIP and DIP (15° PIP + 15° DIP = 30° cumulative) as folded for all fingers", () => {
    const indices: Record<FingerName, [number, number]> = {
      index: [8, 6],
      middle: [12, 10],
      ring: [16, 14],
      pinky: [20, 18],
    };

    for (const finger of ["index", "middle", "ring", "pinky"] as FingerName[]) {
      const [tip, pip] = indices[finger];
      const hand = buildHand({
        fingerBends: { [finger]: { pip: 15, dip: 15 } },
      });
      expect(isFingerExtended(hand, tip, pip)).toBe(false);
    }
  });

  it("evaluates intermediate distributed bends (12°+18°, 20°+15°, 25°+25°) as folded", () => {
    const distributedBends = [
      { pip: 12, dip: 18 }, // 30° cumulative
      { pip: 20, dip: 15 }, // 35° cumulative
      { pip: 25, dip: 25 }, // 50° cumulative
    ];
    for (const bend of distributedBends) {
      const hand = buildHand({
        fingerBends: { pinky: bend },
      });
      expect(isFingerExtended(hand, 20, 18)).toBe(false);
    }
  });

  it("evaluates isolated DIP joint half-curls (0° PIP, 25°–45° DIP) as folded", () => {
    const dipAngles = [25, 30, 35, 40, 45];
    for (const dip of dipAngles) {
      const hand = buildHand({
        fingerBends: { ring: { pip: 0, dip }, pinky: { pip: 0, dip } },
      });
      expect(isFingerExtended(hand, 16, 14)).toBe(false);
      expect(isFingerExtended(hand, 20, 18)).toBe(false);
    }
  });

  it("evaluates subtle natural finger curvature (<= 20° cumulative bend) as extended", () => {
    const straightVariations = [
      { pip: 8, dip: 10 }, // 18° total <= 20°
      { pip: 10, dip: 8 },  // 18° total <= 20°
      { pip: 5, dip: 12 },  // 17° total <= 20°
    ];
    for (const bend of straightVariations) {
      const hand = buildHand({
        fingerBends: { index: bend, middle: bend, ring: bend, pinky: bend },
      });
      expect(isFingerExtended(hand, 8, 6)).toBe(true);
      expect(isFingerExtended(hand, 12, 10)).toBe(true);
      expect(isFingerExtended(hand, 16, 14)).toBe(true);
      expect(isFingerExtended(hand, 20, 18)).toBe(true);
    }
  });

  it("evaluates 3-finger pose with relaxed pinky having distributed 15° PIP + 15° DIP bend as count 3 (never 4)", () => {
    const hand = buildHand({
      fingers: ["index", "middle", "ring"],
      fingerBends: { pinky: { pip: 15, dip: 15 } },
      thumb: "tucked",
    });
    expect(countExtendedFingers(hand)).toBe(3);
  });

  it("evaluates pinky with realistic distal bone (0.028 screen units) and 30° curl as folded (prevents 3->4 misfire at distance)", () => {
    // Pinky with realistic resolved distal bone (0.028 screen units)
    const hand = buildHand({ fingers: ["index", "middle", "ring"] });
    // Override pinky landmarks: mcp=17, pip=18, dip=19, tip=20
    const mcp = hand[17];
    hand[18] = { x: mcp.x, y: mcp.y - 0.045, z: 0 }; // proximal = 0.045
    // 30° DIP bend with 0.028 distal bone length
    const rad30 = (30 * Math.PI) / 180;
    hand[19] = { x: hand[18].x, y: hand[18].y - 0.028, z: 0 }; // midBone = 0.028
    hand[20] = {
      x: hand[19].x + Math.sin(rad30) * 0.028,
      y: hand[19].y - Math.cos(rad30) * 0.028,
      z: 0,
    };
    expect(isFingerExtended(hand, 20, 18)).toBe(false);
    expect(countExtendedFingers(hand)).toBe(3); // 3 stays 3, never 4
  });

  it("straight extended fingers continue to evaluate to true across in-plane rotations from -60° to +60°", () => {
    for (const deg of [-60, -45, -30, -15, 0, 15, 30, 45, 60]) {
      const hand = buildHand({
        fingers: ["index", "middle", "ring", "pinky"],
        thumb: "out",
        tiltDeg: deg,
      });
      expect(isFingerExtended(hand, 8, 6)).toBe(true);
      expect(isFingerExtended(hand, 12, 10)).toBe(true);
      expect(isFingerExtended(hand, 16, 14)).toBe(true);
      expect(isFingerExtended(hand, 20, 18)).toBe(true);
      expect(isThumbExtended(hand)).toBe(true);
      expect(countExtendedFingers(hand)).toBe(5);
    }
  });
});

describe("R2 & R5 — face-proximity & background clutter robustness", () => {
  it("rejects phantom fingertips snapped to facial contours (distal/proximal > 1.35)", () => {
    const hand = buildHand({ fingers: ["index", "middle"] });
    // Simulate index tip snapped to high-contrast jawline contour
    hand[8] = { x: hand[6].x, y: hand[6].y - 0.15, z: 0 }; // dist(p, t) = 0.15 vs proximal 0.07 (ratio 2.14)
    expect(isFingerExtended(hand, 8, 6)).toBe(false);
  });

  it("rejects phantom fingertip stretching past the palm envelope (dist(m, t) > 1.55 * palmSpan)", () => {
    const hand = buildHand({ fingers: ["index"] });
    // Middle MCP at 0.775, wrist at 0.90 -> palmSpan = 0.1266
    // Stretch index fingertip to y = 0.55 -> dist(5, 8) = 0.23 (1.82x palmSpan > 1.55 * palmSpan)
    hand[8] = { x: hand[5].x, y: 0.55, z: 0 };
    expect(isFingerExtended(hand, 8, 6)).toBe(false);
  });

  it("tolerates natural hand holding 5 fingers with out-of-plane palm tilt (~45°) where finger/palm ratio is ~1.35x", () => {
    const hand = buildHand({ fingers: ["index", "middle", "ring", "pinky"], thumb: "out" });
    // Foreshorten palm span by moving wrist closer to middle MCP (simulates 45° palm tilt: cos(45°) ≈ 0.71)
    // palmSpan becomes ~0.09 while middle finger length is 0.12 (ratio 1.33x)
    hand[0] = { x: 0.5, y: 0.865, z: 0 };
    expect(isFingerExtended(hand, 8, 6)).toBe(true);
    expect(isFingerExtended(hand, 12, 10)).toBe(true);
    expect(isFingerExtended(hand, 16, 14)).toBe(true);
    expect(isFingerExtended(hand, 20, 18)).toBe(true);
    expect(countExtendedFingers(hand)).toBe(5);
  });

  it("rejects phantom thumb tip snapped to jawline/cheek with distorted bone ratio", () => {
    const hand = buildHand({ fingers: ["index", "middle", "ring", "pinky"], thumb: "out" });
    // Stretched thumb distal phalanx snapped to facial cheek
    hand[4] = { x: hand[3].x - 0.18, y: hand[3].y - 0.05, z: 0 }; // dist(ip, tip) = 0.186 vs mcpToIp ~0.042 (ratio > 4.4)
    expect(isThumbExtended(hand)).toBe(false);
    expect(countExtendedFingers(hand)).toBe(4); // thumb rejected, 4 fingers remain
  });

  it("rejects stretched phantom thumb extending past palm ratio even when 0 other fingers are extended (fist near face)", () => {
    // Fist with phantom thumb stretched along facial contour
    const hand = buildHand({ thumb: "out" });
    // Stretch thumb tip so cmcToTip exceeds 1.85 * palmSpan
    hand[4] = { x: hand[1].x - 0.25, y: hand[1].y - 0.15, z: 0 };
    expect(isThumbExtended(hand)).toBe(false);
    expect(countExtendedFingers(hand)).toBe(0); // must remain 0, never misfire 1
  });

  it("rejects collapsed knuckle span caused by facial edge snapping", () => {
    const hand = buildHand({
      fingers: ["index", "middle"],
      knuckleCollapse: 0.15, // Knuckles collapsed onto jawline contour (< 0.20 of palmSpan)
    });
    expect(isFingerExtended(hand, 8, 6)).toBe(false);
    expect(isFingerExtended(hand, 12, 10)).toBe(false);
    expect(countExtendedFingers(hand)).toBe(0);
  });

  it("maintains accurate 0–5 counts for hands held at face height without phantom digit triggers", () => {
    // Face-height hand fixture: raised y-position with natural proportions
    for (let count = 0; count <= 5; count++) {
      let fingers: FingerName[] = [];
      let thumb: ThumbPose = "tucked";
      if (count === 1) fingers = ["index"];
      else if (count === 2) fingers = ["index", "middle"];
      else if (count === 3) fingers = ["index", "middle", "ring"];
      else if (count === 4) fingers = ["index", "middle", "ring", "pinky"];
      else if (count === 5) {
        fingers = ["index", "middle", "ring", "pinky"];
        thumb = "out";
      }

      const hand = buildHand({ fingers, thumb });
      // Shift whole hand up to face height (-0.3 y shift)
      const faceHeightHand = hand.map((pt) => ({
        x: pt.x,
        y: pt.y - 0.3,
        z: pt.z,
      }));

      expect(countExtendedFingers(faceHeightHand)).toBe(count);
    }
  });
});

