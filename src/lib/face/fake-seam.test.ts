import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getFakeFaceTracker, getFakeFaceControl } from "./fake-seam";

/**
 * fake-seam accessors — shape-validated typed reads of the E2E globals.
 */
const TRACKER_KEY = "__INNOVISION_FAKE_FACE_TRACKER__";
const CONTROL_KEY = "__INNOVISION_FAKE_FACE_CONTROL__";

function setGlobal(key: string, value: unknown) {
  (globalThis as Record<string, unknown>)[key] = value;
}

beforeEach(() => {
  setGlobal(TRACKER_KEY, undefined);
  setGlobal(CONTROL_KEY, undefined);
});

afterEach(() => {
  setGlobal(TRACKER_KEY, undefined);
  setGlobal(CONTROL_KEY, undefined);
});

describe("getFakeFaceTracker", () => {
  it("returns undefined when not installed", () => {
    expect(getFakeFaceTracker()).toBeUndefined();
  });

  it("returns the tracker when well-shaped", () => {
    const tracker = {
      start: () => {},
      stop: () => {},
      captureFrame: async () => "data:image/jpeg;base64,abc",
      waitForBlink: async () => "passed" as const,
    };
    setGlobal(TRACKER_KEY, tracker);
    expect(getFakeFaceTracker()).toBe(tracker);
  });

  it("rejects malformed installs", () => {
    setGlobal(TRACKER_KEY, { start: () => {} });
    expect(getFakeFaceTracker()).toBeUndefined();
    setGlobal(TRACKER_KEY, "nope");
    expect(getFakeFaceTracker()).toBeUndefined();
    setGlobal(TRACKER_KEY, null);
    expect(getFakeFaceTracker()).toBeUndefined();
  });
});

describe("getFakeFaceControl", () => {
  it("returns undefined when not installed", () => {
    expect(getFakeFaceControl()).toBeUndefined();
  });

  it("returns the control when well-shaped", () => {
    const control = {
      setVerifyMode: () => {},
      triggerBlink: () => {},
      setFacePeriodic: () => {},
    };
    setGlobal(CONTROL_KEY, control);
    expect(getFakeFaceControl()).toBe(control);
  });

  it("rejects malformed installs", () => {
    setGlobal(CONTROL_KEY, { setVerifyMode: () => {} });
    expect(getFakeFaceControl()).toBeUndefined();
    setGlobal(CONTROL_KEY, 42);
    expect(getFakeFaceControl()).toBeUndefined();
  });
});
