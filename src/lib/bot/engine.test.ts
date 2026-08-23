import { describe, expect, it } from "vitest";
import {
  BOT_MORPH_SEC,
  BOT_STATES,
  sampleBot,
  type BotMachine,
} from "./engine";

function machine(
  current: (typeof BOT_STATES)[number],
  prev: (typeof BOT_STATES)[number] | null = null,
  switchAt = 0,
): BotMachine {
  return { current, prev, switchAt };
}

describe("bot engine", () => {
  it("is deterministic for identical inputs", () => {
    const m = machine("thinking", "idle", 3.4);
    const a = sampleBot(3.7, m);
    const b = sampleBot(3.7, m);
    expect(a).toEqual(b);
  });

  it("bounces the paused body vertically", () => {
    const m = machine("paused");
    const minY = (t: number) =>
      Math.min(...sampleBot(t, m).points.map((pt) => pt.y));
    expect(minY(0.16) - minY(0)).toBeGreaterThan(0.1);
    expect(minY(0) - minY(0.47)).toBeGreaterThan(0.1);
  });

  it("shrinks the paused body well below idle", () => {
    const extent = (state: (typeof BOT_STATES)[number]) => {
      let min = Infinity;
      let max = -Infinity;
      for (const pt of sampleBot(1.1, machine(state)).points) {
        min = Math.min(min, pt.y);
        max = Math.max(max, pt.y);
      }
      return max - min;
    };
    expect(extent("paused")).toBeLessThan(extent("idle") * 0.6);
  });

  it("opens the warn eyes wider than idle", () => {
    const t = 1.0;
    expect(sampleBot(t, machine("warn")).leftEye.ry).toBeGreaterThan(
      sampleBot(t, machine("idle")).leftEye.ry * 1.2,
    );
  });

  it("renders a perfect circle when wobble is scaled to zero", () => {
    const pts = sampleBot(3.3, machine("thinking"), undefined, 1, 1, 0).points;
    const cx = pts.reduce((s, pt) => s + pt.x, 0) / pts.length;
    const cy = pts.reduce((s, pt) => s + pt.y, 0) / pts.length;
    const radii = pts.map((pt) => Math.hypot(pt.x - cx, pt.y - cy));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1e-6);
  });

  it("emits finite points and eyes for every state", () => {
    for (const state of BOT_STATES) {
      const f = sampleBot(1.234, machine(state));
      expect(f.points).toHaveLength(48);
      for (const pt of f.points) {
        expect(Number.isFinite(pt.x)).toBe(true);
        expect(Number.isFinite(pt.y)).toBe(true);
        expect(Math.hypot(pt.x, pt.y)).toBeLessThan(2);
      }
      expect(Number.isFinite(f.leftEye.cx)).toBe(true);
      expect(Number.isFinite(f.leftEye.ry)).toBe(true);
      expect(f.leftEye.ry).toBeGreaterThan(0.005);
    }
  });

  it("starts a morph exactly at the previous state's body", () => {
    const t = 10;
    const morphing = sampleBot(t, machine("celebrate", "idle", t));
    const pure = sampleBot(t, machine("idle"));
    expect(morphing.points).toEqual(pure.points);
  });

  it("completes a morph to the target state's body", () => {
    const t = 10 + BOT_MORPH_SEC * 4;
    const morphing = sampleBot(t, machine("celebrate", "idle", 10));
    const pure = sampleBot(t, machine("celebrate"));
    expect(morphing.points).toEqual(pure.points);
    expect(morphing.leftEye.expr).toBe("happy");
  });

  it("keeps the previous expression during the first half of a morph", () => {
    const m = machine("success", "fail", 5);
    const early = sampleBot(5 + BOT_MORPH_SEC * 0.25, m);
    expect(early.leftEye.expr).toBe("open");
  });

  it("clears the success burst after it settles", () => {
    const m = machine("success", "idle", 20);
    expect(sampleBot(20.4, m).dots.length).toBeGreaterThan(0);
    expect(sampleBot(21.2, m).dots).toHaveLength(0);
  });

  it("loops celebration dots indefinitely", () => {
    const m = machine("celebrate", "idle", 0);
    expect(sampleBot(0.3, m).dots.length).toBeGreaterThan(0);
    expect(sampleBot(97.3, m).dots.length).toBeGreaterThan(0);
  });

  it("accepts a gaze override for cursor tracking", () => {
    const t = 1.0;
    const base = sampleBot(t, machine("idle"));
    const overridden = sampleBot(t, machine("idle"), { x: 0.1, y: -0.05 });
    expect(overridden.leftEye.cx).toBeCloseTo(-0.34 + 0.1, 5);
    expect(overridden.leftEye.cy).toBeCloseTo(-0.16 - 0.05, 5);
    expect(overridden.leftEye.cx).not.toBeCloseTo(base.leftEye.cx, 3);
  });

  it("shows a scanning ring", () => {
    const f = sampleBot(0.6, machine("scanning"));
    expect(f.ring).not.toBeNull();
    expect(f.ring!.alpha).toBeGreaterThan(0);
  });

  it("blinks within physical bounds across time", () => {
    const m = machine("idle");
    for (let t = 0; t < 12; t += 0.05) {
      const ry = sampleBot(t, m).leftEye.ry;
      expect(ry).toBeGreaterThan(0.008);
      expect(ry).toBeLessThanOrEqual(0.15);
    }
  });

  it("renders celebration spikier than idle at rest", () => {
    let maxC = 0;
    let maxI = 0;
    for (const pt of sampleBot(2, machine("celebrate")).points) {
      maxC = Math.max(maxC, Math.hypot(pt.x, pt.y));
    }
    for (const pt of sampleBot(2, machine("idle")).points) {
      maxI = Math.max(maxI, Math.hypot(pt.x, pt.y));
    }
    expect(maxC).toBeGreaterThan(maxI * 1.02);
  });
});
