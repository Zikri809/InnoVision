import { describe, it, expect } from "vitest";
import { isLiveFeed, type LiveFeedVideo } from "./live-feed";

// Pins the audit-1 P0-2 decisive test: a paused/swapped video that still
// reports readyState ≥ 2 must be refused — captureFrame() on such a feed
// resolves null instead of re-uploading the frozen last good frame.

const STREAM = { id: "shared-camera-stream" };

type LiveFeedVideoStrict = NonNullable<LiveFeedVideo>;

function healthy(): LiveFeedVideoStrict {
  return {
    paused: false,
    seeking: false,
    readyState: 4,
    videoWidth: 640,
    videoHeight: 480,
    srcObject: STREAM,
  };
}

describe("isLiveFeed (audit-1 P0-2 decisive gate)", () => {
  it("accepts a playing, metadata-ready video bound to the shared stream", () => {
    expect(isLiveFeed(healthy(), STREAM)).toBe(true);
  });

  it("refuses a PAUSED video even with readyState 4 and decodable size", () => {
    const video = healthy();
    video.paused = true;
    expect(isLiveFeed(video, STREAM)).toBe(false);
  });

  it("refuses a SEEKING video (scrub keeps the last decoded frame)", () => {
    const video = healthy();
    video.seeking = true;
    expect(isLiveFeed(video, STREAM)).toBe(false);
  });

  it("refuses readyState < 2 (no decodable frame yet)", () => {
    const video = healthy();
    video.readyState = 1;
    expect(isLiveFeed(video, STREAM)).toBe(false);
  });

  it("refuses zero video dimensions", () => {
    const video = healthy();
    video.videoWidth = 0;
    expect(isLiveFeed(video, STREAM)).toBe(false);
    const video2 = healthy();
    video2.videoHeight = 0;
    expect(isLiveFeed(video2, STREAM)).toBe(false);
  });

  it("refuses a srcObject SWAP (attacker bound a different/mock stream)", () => {
    const video = healthy();
    video.srcObject = { id: "attacker-stream" };
    expect(isLiveFeed(video, STREAM)).toBe(false);
  });

  it("refuses a detached srcObject (camera released)", () => {
    const video = healthy();
    video.srcObject = null;
    expect(isLiveFeed(video, STREAM)).toBe(false);
  });

  it("refuses a missing video element or missing stream reference", () => {
    expect(isLiveFeed(null, STREAM)).toBe(false);
    expect(isLiveFeed(undefined, STREAM)).toBe(false);
    expect(isLiveFeed(healthy(), null)).toBe(false);
    expect(isLiveFeed(healthy(), undefined)).toBe(false);
  });
});
