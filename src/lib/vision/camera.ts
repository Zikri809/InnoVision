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

/**
 * Device class for capture policy (prod 2026-09-26 mobile perf work).
 * Coarse-pointer ≈ phone/tablet: sensors have headroom, so mobile takes the
 * 480p stream + downscaled answer captures. Desktop webcams are optically
 * limited — every pixel counts — so desktop keeps 720p + full-res captures.
 * SSR/test-safe: no `window` (server, Node unit suite) reads as desktop.
 */
export function isCoarsePointerDevice(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches
    );
  } catch {
    return false;
  }
}

/** Video constraints per device class (pure — unit-tested).
 *
 * Virtual cameras (Camo, DroidCam/Iriun phone-as-webcam, OBS virtual cam)
 * often reject `facingMode` or 720p outright with `OverconstrainedError`
 * instead of degrading — so callers must go through the downgrade ladder in
 * `acquireMediaStream()` rather than using these directly with getUserMedia.
 */
export function resolveVideoConstraints(
  coarse: boolean,
  deviceId?: string,
): MediaTrackConstraints {
  const base: MediaTrackConstraints = {
    facingMode: "user",
    width: { ideal: coarse ? 640 : 1280 },
    height: { ideal: coarse ? 480 : 720 },
  };
  if (deviceId) base.deviceId = { ideal: deviceId };
  return base;
}

/**
 * Preferred camera persistence (virtual-camera UX).
 *
 * Camo / phone-as-webcam apps register as just another videoinput and the
 * browser remembers nothing about which one the user picked last time — every
 * visit re-opens the OS default (usually the built-in laptop cam), so the
 * user has to re-pick Camo in the browser permission dropdown each session.
 * The last WORKING deviceId is persisted here so repeat visits stick to it.
 * A stale id (unplugged phone) only costs one failed attempt: the downgrade
 * ladder falls back to the default device. SSR-safe (no window → null).
 */
const PREFERRED_CAMERA_KEY = "innovision:camera-device-id";

export function getPreferredCameraId(): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage.getItem(PREFERRED_CAMERA_KEY);
  } catch {
    return null;
  }
}

export function setPreferredCameraId(deviceId: string | null): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    if (deviceId) window.localStorage.setItem(PREFERRED_CAMERA_KEY, deviceId);
    else window.localStorage.removeItem(PREFERRED_CAMERA_KEY);
  } catch {
    // Private-mode quota / disabled storage — preference is best-effort only.
  }
}

/** List attached video inputs for a camera picker. Empty when unsupported. */
export async function listVideoDevices(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = navigator.mediaDevices;
    if (!devices?.enumerateDevices) return [];
    const all = await devices.enumerateDevices();
    return all.filter((d) => d.kind === "videoinput");
  } catch {
    return [];
  }
}

/** Options for `acquireCameraStream`. All optional — existing callers unchanged. */
export type AcquireCameraOptions = {
  /** Pin to a specific device (takes precedence over the persisted preference). */
  deviceId?: string;
};

/**
 * Mid-session disconnect notifier (phone-as-webcam unplug / sleep / USB
 * glitch, Camo device switch). Consumers subscribe to degrade visibly
 * (gesture layer → click-first `off`) instead of freezing on a dead stream.
 * Returns an unsubscribe function.
 */
type DisconnectListener = () => void;
const disconnectListeners = new Set<DisconnectListener>();

export function onCameraDisconnected(listener: DisconnectListener): () => void {
  disconnectListeners.add(listener);
  return () => {
    disconnectListeners.delete(listener);
  };
}

/**
 * Video tracks of a stream, tolerating mock streams that only implement
 * `getTracks()` (unit tests) instead of the full `getVideoTracks()`.
 */
function videoTracksOf(stream: MediaStream): MediaStreamTrack[] {
  try {
    if (typeof stream.getVideoTracks === "function") return stream.getVideoTracks();
  } catch {
    // Fall through to the getTracks fallback below.
  }
  try {
    return stream
      .getTracks()
      .filter((t) => (t as MediaStreamTrack).kind !== "audio");
  } catch {
    return [];
  }
}

/** True while the shared stream has at least one live video track.
 *
 * Tracks without a `readyState` (unit-test mocks) fall back to
 * `stream.active` so mock streams count as live.
 */
export function isCameraStreamLive(): boolean {
  const stream = state.stream;
  if (!stream || !stream.active) return false;
  try {
    const videos = videoTracksOf(stream);
    if (videos.length === 0) return stream.active;
    return videos.some((t) =>
      (t as MediaStreamTrack).readyState === undefined
        ? stream.active
        : (t as MediaStreamTrack).readyState === "live",
    );
  } catch {
    return stream.active;
  }
}

function notifyCameraDisconnected(): void {
  for (const listener of [...disconnectListeners]) {
    try {
      listener();
    } catch {
      // A broken listener must not break the notifier for the rest.
    }
  }
}

function watchStreamTracks(stream: MediaStream): void {
  try {
    for (const track of videoTracksOf(stream)) {
      const prev = (track as MediaStreamTrack).onended;
      (track as MediaStreamTrack).onended = (ev) => {
        if (typeof prev === "function") prev.call(track, ev);
        handleStreamEnded();
      };
    }
  } catch {
    // Track enumeration / onended assignment failing is non-fatal (mocks).
  }
}

function handleStreamEnded(): void {
  // Invalidate the shared stream so the NEXT acquire opens a fresh
  // getUserMedia instead of coalescing onto / resolving a dead stream.
  // Outstanding holders keep their token but `isCameraStreamLive()` goes
  // false; the notifier tells mounted consumers to degrade + reboot.
  if (state.stream) {
    state.stream = null;
    state.inFlight = null;
    notifyCameraDisconnected();
  }
}

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
export async function acquireCameraStream(opts?: AcquireCameraOptions): Promise<number> {
  const token = nextToken++;
  state.live.set(token, nextToken); // generation = token's serial (monotonic)
  console.debug("[camera] acquire token", token, "refcount", state.refcount, "inFlight", !!state.inFlight);

  // A mid-session disconnect invalidates state.stream/inFlight; a NEW acquire
  // after that must open a fresh stream even if a previous in-flight promise
  // object lingers. (handleStreamEnded already nulled it; this is belt-and-
  // braces for races where the ended event fires mid-acquire.)
  if (state.stream && !isCameraStreamLive()) {
    state.stream = null;
    state.inFlight = null;
  }

  if (!state.inFlight) {
    state.inFlight = acquireMediaStream(opts);
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
    watchStreamTracks(stream);
    // Persist the working device so the next visit re-opens Camo / the phone
    // instead of the OS default. Best-effort: getSettings may be absent on
    // mock streams.
    try {
      const activeDeviceId = videoTracksOf(stream)[0]?.getSettings?.().deviceId;
      if (activeDeviceId) setPreferredCameraId(activeDeviceId);
    } catch {
      // Ignore — preference is cosmetic.
    }
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

/**
 * Constraint ladder for `getUserMedia` (virtual-camera hardening).
 *
 * Built-in webcams satisfy the full ask; Camo / phone-as-webcam drivers
 * commonly reject `facingMode` or 720p with `OverconstrainedError` instead of
 * degrading gracefully. Each rung drops one requirement; the last rung is a
 * bare `video: true` (browser default device, driver-chosen resolution).
 * Permission / security / busy failures abort immediately — retrying those is
 * pointless (and a busy-device retry loop would spin while the user reads the
 * "close the other app" copy).
 */
function buildConstraintLadder(
  coarse: boolean,
  deviceId?: string,
): (MediaTrackConstraints | true)[] {
  const full = resolveVideoConstraints(coarse, deviceId);
  const noFacing: MediaTrackConstraints = { ...full };
  delete noFacing.facingMode;
  const low: MediaTrackConstraints = {
    width: { ideal: 640 },
    height: { ideal: 480 },
  };
  if (deviceId) low.deviceId = { ideal: deviceId };
  const bare: MediaTrackConstraints | true = deviceId ? { deviceId: { ideal: deviceId } } : true;
  // Dedupe identical rungs (e.g. coarse full already equals low without facing).
  const ladder = [full, noFacing, low, bare];
  return ladder.filter(
    (rung, i) => ladder.findIndex((other) => JSON.stringify(other) === JSON.stringify(rung)) === i,
  );
}

/**
 * Rungs worth retrying on: the device exists but rejected this constraint
 * shape (`OverconstrainedError` / `NotFoundError` — the classic virtual-cam
 * response to `facingMode` or 720p). Everything else aborts immediately:
 * permission / security / busy failures would fail identically on every rung,
 * and `unknown` errors must surface (not spin through 4 getUserMedia prompts).
 */
function isLadderRetryable(err: unknown): boolean {
  return classifyCameraFailure(err) === "no_device";
}

async function acquireMediaStream(opts?: AcquireCameraOptions): Promise<MediaStream> {
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
  const deviceId = opts?.deviceId ?? getPreferredCameraId() ?? undefined;
  const ladder = buildConstraintLadder(isCoarsePointerDevice(), deviceId);
  console.debug("[camera] getUserMedia start", { rungs: ladder.length, pinnedDevice: Boolean(deviceId) });
  let lastErr: unknown = null;
  for (let i = 0; i < ladder.length; i++) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: ladder[i],
      });
      console.debug("[camera] getUserMedia resolved, active=", stream.active, "rung=", i);
      return stream;
    } catch (err) {
      lastErr = err;
      // Permission denied, insecure context, or device busy (Camo Studio
      // preview / Zoom holding the virtual cam): further rungs will fail the
      // same way — abort with the classification attached.
      if (!isLadderRetryable(err)) break;
      console.debug("[camera] getUserMedia rung failed, trying next", {
        rung: i,
        cause: classifyCameraFailure(err),
      });
    }
  }
  // Re-throw WITH the classification attached so callers upstream (tracker
  // boot, enroll page) can render cause-specific copy instead of a generic
  // unavailable panel.
  throw new CameraFailureError(
    classifyCameraFailure(lastErr),
    lastErr instanceof Error ? lastErr.message : "Camera access failed.",
  );
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
