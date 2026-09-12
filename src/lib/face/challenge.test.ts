import { describe, it, expect } from "vitest";
import { HeadTurnChallenge, randomTurnSide } from "./challenge";
import { HEAD_TURN_SUSTAIN_MS, HEAD_TURN_YAW_MIN } from "./constants";

describe("HeadTurnChallenge — left", () => {
  it("does not pass while the student stays centered", () => {
    const c = new HeadTurnChallenge("left");
    let prev: number | null = null;
    for (let t = 0; t < 5000; t += 50) {
      expect(c.feed({ yaw: 0, faceDetected: true }, t, prev)).toBe(false);
      prev = t;
    }
  });

  it("passes only after the yaw is sustained past the threshold in the required direction", () => {
    const c = new HeadTurnChallenge("left");
    let prev: number | null = null;
    let passedAt: number | null = null;
    for (let t = 0; t <= 2000; t += 50) {
      // +40 ≥ +15 (left). Sustain completes HEAD_TURN_SUSTAIN_MS after the
      // FIRST crossing sample.
      if (c.feed({ yaw: 40, faceDetected: true }, t, prev)) {
        passedAt = t;
        break;
      }
      prev = t;
    }
    expect(passedAt).not.toBeNull();
    expect(passedAt!).toBeGreaterThanOrEqual(HEAD_TURN_SUSTAIN_MS);
    // Exactly one resolution.
    expect(c.feed({ yaw: 40, faceDetected: true }, 3000, 2000)).toBe(false);
  });

  it("a turn in the WRONG direction never passes (right required to move negative)", () => {
    const c = new HeadTurnChallenge("left");
    let prev: number | null = null;
    for (let t = 0; t < 5000; t += 50) {
      expect(c.feed({ yaw: -40, faceDetected: true }, t, prev)).toBe(false);
      prev = t;
    }
  });

  it("a wobble past the threshold that returns does not pass (sustain resets)", () => {
    const c = new HeadTurnChallenge("left");
    let prev: number | null = null;
    let t = 0;
    // 200ms past threshold (< HEAD_TURN_SUSTAIN_MS)…
    for (; t <= 200; t += 50) {
      c.feed({ yaw: 40, faceDetected: true }, t, prev);
      prev = t;
    }
    // …then back to center for a while…
    for (; t <= 2000; t += 50) {
      c.feed({ yaw: 0, faceDetected: true }, t, prev);
      prev = t;
    }
    // …then past again — the sustain restarts from scratch.
    let passedAt: number | null = null;
    for (; t <= 4000; t += 50) {
      if (c.feed({ yaw: 40, faceDetected: true }, t, prev)) {
        passedAt = t;
        break;
      }
      prev = t;
    }
    expect(passedAt).not.toBeNull();
    expect(passedAt! - 2000).toBeGreaterThanOrEqual(HEAD_TURN_SUSTAIN_MS);
  });

  it("face loss mid-challenge resets the sustain window", () => {
    const c = new HeadTurnChallenge("left");
    let prev: number | null = null;
    let t = 0;
    for (; t <= 200; t += 50) {
      c.feed({ yaw: 40, faceDetected: true }, t, prev);
      prev = t;
    }
    // Face gone (a sample gap larger than the sustain window).
    expect(c.feed({ yaw: 40, faceDetected: false }, 2000, prev)).toBe(false);
    // Turn resumes — full sustain required again.
    let passedAt: number | null = null;
    prev = 2000;
    for (t = 2050; t <= 4000; t += 50) {
      if (c.feed({ yaw: 40, faceDetected: true }, t, prev)) {
        passedAt = t;
        break;
      }
      prev = t;
    }
    expect(passedAt).not.toBeNull();
    expect(passedAt! - 2000).toBeGreaterThanOrEqual(HEAD_TURN_SUSTAIN_MS);
  });
});

describe("HeadTurnChallenge — right", () => {
  it("passes on a sustained NEGATIVE yaw", () => {
    const c = new HeadTurnChallenge("right");
    let prev: number | null = null;
    let passedAt: number | null = null;
    for (let t = 0; t <= 2000; t += 50) {
      if (c.feed({ yaw: -(HEAD_TURN_YAW_MIN + 10), faceDetected: true }, t, prev)) {
        passedAt = t;
        break;
      }
      prev = t;
    }
    expect(passedAt).not.toBeNull();
    expect(passedAt!).toBeGreaterThanOrEqual(HEAD_TURN_SUSTAIN_MS);
  });

  it("a positive yaw (wrong way) never passes", () => {
    const c = new HeadTurnChallenge("right");
    let prev: number | null = null;
    for (let t = 0; t < 5000; t += 50) {
      expect(c.feed({ yaw: 40, faceDetected: true }, t, prev)).toBe(false);
      prev = t;
    }
  });
});

describe("HeadTurnChallenge — coverage of remaining branches", () => {
  it("exposes the required side and is resettable", () => {
    const c = new HeadTurnChallenge("right");
    expect(c.turnSide).toBe("right");
    c.feed({ yaw: -40, faceDetected: true }, 0, null);
    c.reset();
    // After a reset the challenge must require a FULL new sustain window.
    let passedAt: number | null = null;
    let prev: number | null = null;
    for (let t = 0; t <= 2000; t += 50) {
      if (c.feed({ yaw: -40, faceDetected: true }, t, prev)) {
        passedAt = t;
        break;
      }
      prev = t;
    }
    expect(passedAt).not.toBeNull();
    expect(passedAt!).toBeGreaterThanOrEqual(HEAD_TURN_SUSTAIN_MS);
  });

  it("sustain restarting via a sample GAP larger than the sustain window", () => {
    const c = new HeadTurnChallenge("left");
    // Cross the threshold, then a >SUSTAIN gap before the next sample —
    // the gap branch (prevSampleMs path) restarts the window from `nowMs`.
    c.feed({ yaw: 40, faceDetected: true }, 0, null);
    expect(c.feed({ yaw: 40, faceDetected: true }, HEAD_TURN_SUSTAIN_MS + 100, 0)).toBe(false);
    // Hold continuously from the restart → passes after a full window.
    let passedAt: number | null = null;
    let prev = HEAD_TURN_SUSTAIN_MS + 100;
    for (let t = prev + 50; t <= prev + 2000; t += 50) {
      if (c.feed({ yaw: 40, faceDetected: true }, t, prev)) {
        passedAt = t;
        break;
      }
      prev = t;
    }
    expect(passedAt).not.toBeNull();
    expect(passedAt! - (HEAD_TURN_SUSTAIN_MS + 100)).toBeGreaterThanOrEqual(
      HEAD_TURN_SUSTAIN_MS,
    );
  });
});

describe("randomTurnSide", () => {
  it("maps the RNG uniformly and honors an injected rng", () => {
    expect(randomTurnSide(() => 0)).toBe("left");
    expect(randomTurnSide(() => 0.49)).toBe("left");
    expect(randomTurnSide(() => 0.5)).toBe("right");
    expect(randomTurnSide(() => 0.99)).toBe("right");
  });
});
