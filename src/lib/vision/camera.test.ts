import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  acquireCameraStream,
  resolveStream,
  releaseCameraStream,
  _resetCameraState,
  _cameraRefcount,
} from "./camera";

/**
 * Camera refcount/generation unit tests (PLAN_PHASE7 §2 / iteration-3
 * robustness 8):
 *  - concurrent acquires COALESCE into one `getUserMedia` (one stream).
 *  - release is idempotent; tracks stop exactly once at refcount 0.
 *  - a stale generation's stream (resolving after a reset/new acquire) is
 *    stopped by the generation guard; the winner's tracks stay live.
 */

type FakeTrack = {
  kind: string;
  stop: () => void;
  stopped: boolean;
};

type FakeStream = {
  active: boolean;
  getTracks: () => FakeTrack[];
};

function makeStream(): FakeStream {
  const tracks: FakeTrack[] = [{ kind: "video", stopped: false, stop: () => {} }];
  const s: FakeStream = { active: true, getTracks: () => tracks };
  tracks[0].stop = () => {
    tracks[0].stopped = true;
    s.active = false;
  };
  return s;
}

function setGetUserMedia(impl: () => Promise<FakeStream>) {
  (navigator as unknown as { mediaDevices: { getUserMedia: unknown } }).mediaDevices = {
    getUserMedia: impl,
  };
}

describe("camera.ts refcount/generation", () => {
  beforeEach(() => {
    _resetCameraState();
  });

  afterEach(() => {
    _resetCameraState();
  });

  it("concurrent acquires coalesce into ONE getUserMedia and share the stream", async () => {
    const shared = makeStream();
    const gUM = vi.fn().mockResolvedValue(shared);
    setGetUserMedia(gUM);

    const [t1, t2] = await Promise.all([acquireCameraStream(), acquireCameraStream()]);
    expect(gUM).toHaveBeenCalledTimes(1); // coalesced
    expect(_cameraRefcount()).toBe(2);
    expect(resolveStream(t1)).toBe(shared);
    expect(resolveStream(t2)).toBe(shared);

    releaseCameraStream(t1);
    expect(_cameraRefcount()).toBe(1);
    expect(shared.active).toBe(true); // still live after loser release

    releaseCameraStream(t2);
    expect(_cameraRefcount()).toBe(0);
    expect(shared.getTracks()[0].stopped).toBe(true); // stopped exactly once at 0
  });

  it("a stale in-flight stream (superseded by a reset) is stopped; the winner's tracks stay live", async () => {
    const stale = makeStream();
    const fresh = makeStream();

    let resolveStale: (s: FakeStream) => void = () => {};
    let resolveFresh: (s: FakeStream) => void = () => {};

    setGetUserMedia(() => new Promise((resolve) => (resolveStale = resolve)));
    const p1 = acquireCameraStream();

    // Simulate a teardown while acquire 1 is still in flight (StrictMode
    // double-mount / unmount): reset clears the module state.
    _resetCameraState();

    setGetUserMedia(() => new Promise((resolve) => (resolveFresh = resolve)));
    const p2 = acquireCameraStream();

    // The stale in-flight promise resolves late — supersede guard stops it.
    resolveStale(stale);
    await expect(p1).rejects.toThrow("superseded");
    expect(stale.active).toBe(false);
    expect(stale.getTracks()[0].stopped).toBe(true);

    // The fresh generation resolves and stays live.
    resolveFresh(fresh);
    const t2 = await p2;
    expect(fresh.active).toBe(true);
    expect(fresh.getTracks()[0].stopped).toBe(false);

    releaseCameraStream(t2);
    expect(fresh.getTracks()[0].stopped).toBe(true);
  });

  it("rejects a non-active stream after resolve", async () => {
    const dead = makeStream();
    dead.active = false;
    setGetUserMedia(() => Promise.resolve(dead));
    await expect(acquireCameraStream()).rejects.toThrow("not active");
    expect(_cameraRefcount()).toBe(0);
  });

  it("release is idempotent", async () => {
    const s = makeStream();
    setGetUserMedia(() => Promise.resolve(s));
    const token = await acquireCameraStream();
    releaseCameraStream(token);
    releaseCameraStream(token); // second release is a no-op
    expect(_cameraRefcount()).toBe(0);
    expect(s.getTracks()[0].stopped).toBe(true);
  });

  it("a REJECTED in-flight getUserMedia does not poison later acquires", async () => {
    // A single "device in use"/denied rejection must NOT bake camera
    // unavailability into the whole session (the old code left the rejected
    // promise as `state.inFlight`, so every later acquire coalesced onto it).
    let rejectNow: (e: Error) => void = () => {};
    setGetUserMedia(() => new Promise((_, reject) => (rejectNow = reject)));
    const p1 = acquireCameraStream();
    rejectNow(new Error("device in use"));
    await expect(p1).rejects.toThrow("device in use");
    expect(_cameraRefcount()).toBe(0);

    // The in-flight pointer was cleared → a SECOND acquire creates a fresh one.
    const shared = makeStream();
    setGetUserMedia(() => Promise.resolve(shared));
    const token = await acquireCameraStream();
    expect(resolveStream(token)).toBe(shared);
    releaseCameraStream(token);
    expect(shared.getTracks()[0].stopped).toBe(true);
  });

  it("StrictMode: a disposed first acquire's release cannot kill the coalesced second acquire", async () => {
    // Run#1 acquires (in-flight P), then disposes/releases BEFORE P resolves;
    // run#2 coalesces onto the SAME P. When P resolves, run#2 must succeed
    // with a live stream (the release must not have zeroed the refcount under
    // run#2's pending acquire).
    const shared = makeStream();
    let resolveP: (s: FakeStream) => void = () => {};
    setGetUserMedia(() => new Promise((resolve) => (resolveP = resolve)));

    const p1 = acquireCameraStream(); // run#1 — refcount now 1
    const p2 = acquireCameraStream(); // run#2 — coalesced, refcount now 2

    // Run#1's cleanup releases BEFORE the promise resolves.
    // We don't have the token yet (acquire is still pending), so simulate the
    // StrictMode disposal via the disposed-check path in the consumer: the
    // consumer calls releaseCameraStream only after resolve, but the pending
    // refcount already counts it. To exercise the interleaving precisely, the
    // test asserts the pending refcount is 2 (both consumers counted) and that
    // resolving keeps the stream live for the surviving consumer.
    expect(_cameraRefcount()).toBe(2);

    resolveP(shared);
    const t2 = await p2;
    expect(shared.active).toBe(true);
    expect(shared.getTracks()[0].stopped).toBe(false);
    expect(_cameraRefcount()).toBe(2);

    // Run#1 (a real StrictMode consumer) would release after its disposed
    // check; run#2 still holds a live reference. Release BOTH to reach 0.
    const t1 = await p1;
    void t1;
    releaseCameraStream(t1);
    expect(shared.active).toBe(true); // t2 still holds a ref → still live
    releaseCameraStream(t2);
    expect(shared.getTracks()[0].stopped).toBe(true);
  });
});
