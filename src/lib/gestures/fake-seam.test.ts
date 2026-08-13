import { describe, it, expect, afterEach } from "vitest";
import { getFakeHandTracker, getFakeHandControl } from "./fake-seam";

const TRACKER_KEY = "__INNOVISION_FAKE_HAND_TRACKER__";
const CONTROL_KEY = "__INNOVISION_FAKE_HAND_CONTROL__";

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[TRACKER_KEY];
  delete (globalThis as Record<string, unknown>)[CONTROL_KEY];
});

describe("getFakeHandTracker — typed accessor shape-validation", () => {
  it("returns undefined when the global is absent", () => {
    expect(getFakeHandTracker()).toBeUndefined();
  });

  it("returns the tracker when start/stop are functions", () => {
    const tracker = { start: () => {}, stop: () => {} };
    (globalThis as Record<string, unknown>)[TRACKER_KEY] = tracker;
    expect(getFakeHandTracker()).toBe(tracker);
  });

  it("rejects a non-object global", () => {
    (globalThis as Record<string, unknown>)[TRACKER_KEY] = "not-an-object";
    expect(getFakeHandTracker()).toBeUndefined();
    (globalThis as Record<string, unknown>)[TRACKER_KEY] = 42;
    expect(getFakeHandTracker()).toBeUndefined();
  });

  it("rejects missing start/stop", () => {
    (globalThis as Record<string, unknown>)[TRACKER_KEY] = { start: () => {} };
    expect(getFakeHandTracker()).toBeUndefined();
    (globalThis as Record<string, unknown>)[TRACKER_KEY] = { stop: () => {} };
    expect(getFakeHandTracker()).toBeUndefined();
    (globalThis as Record<string, unknown>)[TRACKER_KEY] = { start: 1, stop: 2 };
    expect(getFakeHandTracker()).toBeUndefined();
  });
});

describe("getFakeHandControl — typed accessor shape-validation", () => {
  it("returns undefined when the global is absent", () => {
    expect(getFakeHandControl()).toBeUndefined();
  });

  it("returns the control when sequence/frame are functions", () => {
    const control = { sequence: () => {}, frame: () => {} };
    (globalThis as Record<string, unknown>)[CONTROL_KEY] = control;
    expect(getFakeHandControl()).toBe(control);
  });

  it("rejects malformed controls", () => {
    (globalThis as Record<string, unknown>)[CONTROL_KEY] = { sequence: () => {} };
    expect(getFakeHandControl()).toBeUndefined();
    (globalThis as Record<string, unknown>)[CONTROL_KEY] = null;
    expect(getFakeHandControl()).toBeUndefined();
  });
});
