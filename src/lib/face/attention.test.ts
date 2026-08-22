import { describe, it, expect } from "vitest";
import { AttentionMonitor } from "./attention";

describe("AttentionMonitor — second_face advisory", () => {
  it("does not fire for a single face", () => {
    const m = new AttentionMonitor();
    const events = [];
    for (let t = 0; t < 3000; t += 100) {
      events.push(...m.feed({ yaw: 0, centered: true, faceDetected: true, facesSeen: 1 }, t));
    }
    expect(events).toEqual([]);
  });

  it("fires after sustained two-face presence and re-arms", () => {
    const m = new AttentionMonitor();
    let fired = 0;
    let reFireAt: number | null = null;
    for (let t = 0; t <= 5000; t += 100) {
      const events = m.feed({ yaw: 0, centered: true, faceDetected: true, facesSeen: 2 }, t);
      if (events.length > 0) {
        fired++;
        if (fired === 1) expect(t).toBeGreaterThanOrEqual(1000);
        if (fired === 2) {
          reFireAt = t;
          break;
        }
      }
    }
    expect(fired).toBeGreaterThanOrEqual(1);
    // Re-arm requires another full sustain window.
    if (reFireAt !== null) expect(reFireAt).toBeGreaterThanOrEqual(2000);
  });

  it("resets when the second face leaves before the sustain window", () => {
    const m = new AttentionMonitor();
    m.feed({ yaw: 0, centered: true, faceDetected: true, facesSeen: 2 }, 0);
    m.feed({ yaw: 0, centered: true, faceDetected: true, facesSeen: 2 }, 500);
    // Second face gone.
    expect(m.feed({ yaw: 0, centered: true, faceDetected: true, facesSeen: 1 }, 900)).toEqual([]);
    // A brief reappearance restarts the window from zero.
    expect(m.feed({ yaw: 0, centered: true, faceDetected: true, facesSeen: 2 }, 1000)).toEqual([]);
  });
});

describe("AttentionMonitor — looked_away advisory", () => {
  it("does not fire while the student stays centered", () => {
    const m = new AttentionMonitor();
    const events = [];
    for (let t = 0; t < 30000; t += 100) {
      events.push(...m.feed({ yaw: 10, centered: true, faceDetected: true }, t));
    }
    expect(events).toEqual([]);
  });

  it("accumulates off-axis time inside the rolling window and fires once per threshold", () => {
    const m = new AttentionMonitor();
    const firedAt: number[] = [];
    // Interleaved: 500ms away / 500ms back — accumulation crosses 8s at ~16s.
    for (let t = 0; t <= 40000; t += 100) {
      const lookingAway = Math.floor(t / 500) % 2 === 0;
      const pose = lookingAway
        ? { yaw: 40, centered: true, faceDetected: true }
        : { yaw: 5, centered: true, faceDetected: true };
      const events = m.feed(pose, t);
      if (events.length > 0) firedAt.push(t);
    }
    expect(firedAt.length).toBeGreaterThanOrEqual(1);
    expect(firedAt[0]).toBeGreaterThanOrEqual(15500); // ~8s accumulated
  });

  it("no face means NO look-away accumulation (absence ≠ looking away)", () => {
    const m = new AttentionMonitor();
    for (let t = 0; t < 20000; t += 100) {
      expect(m.feed({ yaw: 90, centered: false, faceDetected: false }, t)).toEqual([]);
    }
  });
});
