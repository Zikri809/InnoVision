/**
 * Live-feed gate (audit-1 P0-2 client arm) — PURE, unit-testable, env-free.
 *
 * A paused/seeking <video> — or one whose srcObject no longer points at the
 * shared camera stream — still reports readyState ≥ 2 while showing its LAST
 * GOOD frame. That is the exact frozen-frame primitive behind
 * `video.pause()` / srcObject-swap presence fraud: every periodic verify
 * would re-upload the same good-looking frame and pass identity forever
 * while the student is absent. (A `track.enabled = false` freeze instead
 * yields BLACK frames, which fail the server-side similarity vote, so it
 * needs no guard here — see the face-tracker track-death comment.)
 *
 * Capture and pose detection must both refuse anything but the live shared
 * feed: a null capture / skipped pose tick degrades through the pipeline's
 * existing unavailable / fail paths, never a frozen pass.
 */

/** Structural subset of HTMLVideoElement the gate needs (Node-testable). */
export type LiveFeedVideo = {
  paused: boolean;
  seeking: boolean;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  srcObject: unknown;
} | null | undefined;

/**
 * True only when the video element is actively playing the shared camera
 * stream with decodable dimensions — i.e. a `drawImage` would sample the
 * LIVE feed, not a frozen last frame.
 */
export function isLiveFeed(video: LiveFeedVideo, sharedStream: unknown): boolean {
  if (!video) return false;
  if (video.paused || video.seeking) return false;
  if (video.readyState < 2) return false;
  if (!video.videoWidth || !video.videoHeight) return false;
  if (!sharedStream || video.srcObject !== sharedStream) return false;
  return true;
}
