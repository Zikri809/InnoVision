/**
 * Shared camera stream manager (Phase 7).
 *
 * One camera, three consumers (hand tracker + face tracker + enroll page).
 * This module is the SOLE owner of `track.stop()` — neither
 * `HandLandmarkerTracker.stop()` nor `FaceTracker.stop()` stops shared tracks.
 *
 * Design (PLAN_PHASE7 §2):
 *  - `acquireCameraStream()` returns an opaque token; callers resolve the
 *    actual stream via `resolveStream(token)`.
 *  - Concurrent `getUserMedia` calls COALESCE into ONE in-flight promise
 *    (StrictMode double-mounts and the hand+face pair never open two cameras).
 *  - SUPERSEDE guard: after awaiting the in-flight promise, the module checks
 *    that this promise is STILL the current in-flight one. If a reset (dev
 *    hot-reload / test teardown) replaced it, the stale stream is stopped so
 *    a later generation's live stream is never killed by an old resolve.
 *  - After resolve, the module asserts `stream.active` (a browser can hand
 *    back a dead stream).
 *  - `releaseCameraStream(token)` is idempotent; tracks stop only when the
 *    refcount reaches 0.
 *
 * Browser-only. Node unit tests inject a mocked `navigator.mediaDevices` and
 * `MediaStream` (see `camera.test.ts`).
 */

type CameraState = {
  inFlight: Promise<MediaStream> | null;
  refcount: number;
  /** Map of token → generation for live acquires (tracks a stale release). */
  live: Map<number, number>;
  stream: MediaStream | null;
};

/**
 * SQ-5 / AX-7 shared kernel: typed camera-failure taxonomy. getUserMedia
 * rejection names (NotAllowedError etc.) were previously discarded and every
 * boot failure collapsed to a generic "unavailable" — blocked-camera students
 * retried forever with no actionable copy.
 *
 * `security` (insecure context) is derived from `window.isSecureContext` since
 * browsers surface it inconsistently; "unknown" is the honest fallback for
 * boot timeouts / health-probe failures, which are NOT camera-permission
 * problems and must never claim to be.
 */
export type CameraFailure =
  | "permission" // NotAllowedError — user/site denied; fixable in browser settings
  | "no_device" // NotFoundError / OverconstrainedError — nothing to grant
  | "device_busy" // NotReadableError — OS-level lock (another app)
  | "security" // insecure context (http:// non-localhost)
  | "unsupported" // no navigator.mediaDevices.getUserMedia at all
  | "unknown";

export class CameraFailureError extends Error {
  readonly failure: CameraFailure;
  constructor(failure: CameraFailure, message: string) {
    super(message);
    this.name = "CameraFailureError";
    this.failure = failure;
  }
}

export function classifyCameraFailure(err: unknown): CameraFailure {
  if (err instanceof CameraFailureError) return err.failure;
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String((err as { name: unknown }).name)
      : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "permission";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "no_device";
    case "NotReadableError":
    case "TrackStartError":
      return "device_busy";
    case "SecurityError":
      return "security";
    default:
      return "unknown";
  }
}

let state: CameraState = {
  inFlight: null,
  refcount: 0,
  live: new Map(),
  stream: null,
};

let nextToken = 1;

/** Reset the module (test-only; also used on hot-reload in dev). */
export function _resetCameraState(): void {
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
  }
  state = { inFlight: null, refcount: 0, live: new Map(), stream: null };
  // nextToken is deliberately NOT reset: tokens must stay globally unique so
  // an error path in an old acquire can never delete a newer acquire's live
  // entry (token collision would leak a stream / double-release).
}

/**
 * Acquire a camera stream reference. Returns an opaque token; pass it to
 * `resolveStream(token)` to get the actual `MediaStream`. Callers MUST
 * `releaseCameraStream(token)` when done (idempotent).
 *
 * Coalescing: concurrent acquires share ONE in-flight `getUserMedia` (the
 * promise is captured at call time — a later acquire/reset never redirects an
 * earlier caller). The supersede guard stops a stale in-flight stream that
 * resolves after a reset replaced the in-flight promise.
 */
export async function acquireCameraStream(): Promise<number> {
  const token = nextToken++;
  state.live.set(token, nextToken); // generation = token's serial (monotonic)
  console.debug("[camera] acquire token", token, "refcount", state.refcount, "inFlight", !!state.inFlight);

  if (!state.inFlight) {
    state.inFlight = acquireMediaStream();
  }
  // Capture the promise AT CALL TIME.
  const inFlight = state.inFlight;

  // Count the consumer BEFORE awaiting, so a release from an earlier
  // (disposed) consumer can never zero the refcount under this pending
  // acquire (StrictMode: run#1's release must not kill run#2's coalesced
  // stream — the refcount is the real "how many want the camera" counter).
  state.refcount++;

  try {
    const stream = await inFlight;
    // Supersede guard: if this promise is no longer the current in-flight one
    // (a reset replaced it), the stream is stale — stop it and fail this
    // acquire rather than let a dead/late stream satisfy the caller.
    if (state.inFlight !== inFlight) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error("Camera stream was superseded.");
    }
    // Assert the stream is actually live (a browser may resolve a dead one).
    if (!stream.active) {
      throw new Error("Camera stream is not active.");
    }
    state.stream = stream;
  } catch (err) {
    state.live.delete(token);
    state.refcount = Math.max(0, state.refcount - 1);
    // A REJECTED in-flight promise must not permanently poison coalescing —
    // otherwise a single "device in use"/denied getUserMedia bakes camera
    // unavailability into the whole SPA session (every later acquire coalesces
    // onto the same rejected promise). Only clear it if it's STILL this
    // promise (a reset may have replaced it mid-await — supersede guard owns
    // that stream).
    if (state.inFlight === inFlight) state.inFlight = null;
    throw err;
  }

  return token;
}

async function acquireMediaStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    // Insecure contexts (plain http://, non-localhost) EXPOSE no mediaDevices
    // at all — prefer the actionable security diagnosis when it applies.
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      throw new CameraFailureError(
        "security",
        "Camera requires a secure (https) connection.",
      );
    }
    throw new CameraFailureError(
      "unsupported",
      "This browser does not support webcam access.",
    );
  }
  console.debug("[camera] getUserMedia start");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { max: 640, ideal: 640 },
        height: { max: 480, ideal: 480 },
      },
    });
    console.debug("[camera] getUserMedia resolved, active=", stream.active);
    return stream;
  } catch (err) {
    // Re-throw WITH the classification attached so callers upstream (tracker
    // boot, enroll page) can render cause-specific copy instead of a generic
    // unavailable panel.
    throw new CameraFailureError(
      classifyCameraFailure(err),
      err instanceof Error ? err.message : "Camera access failed.",
    );
  }
}

/** Resolve the opaque token to the shared `MediaStream`. */
export function resolveStream(token: number): MediaStream {
  const stream = state.stream;
  if (!stream) throw new Error("No camera stream acquired.");
  if (!state.live.has(token)) throw new Error("Camera token is not live.");
  return stream;
}

/**
 * Release a camera reference. Idempotent. Tracks stop only when the refcount
 * reaches 0 (the LAST consumer to release owns the teardown).
 */
export function releaseCameraStream(token: number): void {
  if (!state.live.has(token)) return;
  state.live.delete(token);
  state.refcount = Math.max(0, state.refcount - 1);
  console.debug("[camera] release token", token, "refcount", state.refcount);
  if (state.refcount === 0 && state.stream) {
    console.debug("[camera] refcount 0 — stopping all tracks");
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
    state.inFlight = null;
  }
}

/** Test-only: how many live references are outstanding. */
export function _cameraRefcount(): number {
  return state.refcount;
}
