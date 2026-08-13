/**
 * Standalone fake-hand-tracker init script for Playwright E2E (Phase 6).
 *
 * Installed via `page.addInitScript(fakeHandTrackerInit)` BEFORE the student
 * navigates to `/play` (addInitScript is not retroactive). It installs:
 *  - `window.__INNOVISION_FAKE_HAND_TRACKER__` — an `IHandTracker`-shaped fake
 *    that emits scripted `HandFrame`s on a 50ms clock (first frame immediately
 *    at segment start, then every 50ms) using `performance.now()`.
 *  - `window.__INNOVISION_FAKE_HAND_CONTROL__` — `sequence(segments)` replays
 *    `{ present, fingers, holdMs }` segments (cancelling any in-flight
 *    sequence); `frame(handPresent, fingerCount)` pushes one frame synchronously.
 *
 * TEST-ONLY: never imported by app code. `start`/`stop`/`sequence` are
 * StrictMode-idempotent (Next dev runs StrictMode; double intervals would
 * double the hold clock and break E9's negative assertion).
 *
 * NOTE: Playwright serializes this function to a string for `addInitScript`,
 * so it must be fully self-contained (no outer imports / module references).
 * `FAKE_TICK_MS` (50) is therefore mirrored as a local literal — the canonical
 * value lives in `src/lib/gestures/constants.ts`.
 */
export function fakeHandTrackerInit(): void {
  const FAKE_TICK_MS = 50;

  type FakeSegment = { present: boolean; fingers: number; holdMs: number };
  type FakeFrame = {
    handPresent: boolean;
    fingerCount: number;
    handedness?: "Left" | "Right";
  };

  // Shorthand helper: `{ fingers, holdMs }` means a present hand (fist differs
  // from a lost hand — `present: false` is explicit).
  function normalizeSegments(segments: FakeSegment[]): FakeSegment[] {
    return segments.map((s) => {
      const present = s.present === undefined ? s.fingers > 0 : s.present;
      return { present, fingers: s.fingers ?? 0, holdMs: s.holdMs ?? 0 };
    });
  }

  let intervalId: ReturnType<typeof setInterval> | null = null;
  let activeSegment: FakeSegment | null = null;
  let segmentStart = 0;
  let segmentIndex = 0;
  let segmentQueue: FakeSegment[] = [];
  let onFrame: ((frame: FakeFrame) => void) | null = null;

  function clearTick() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function emitFrame(handPresent: boolean, fingerCount: number) {
    if (onFrame) {
      onFrame({ handPresent, fingerCount, handedness: "Right" });
    }
  }

  function tick() {
    if (!activeSegment) return;
    const elapsed = performance.now() - segmentStart;
    if (elapsed >= activeSegment.holdMs) {
      // Segment complete → next segment or stop.
      segmentIndex++;
      if (segmentIndex < segmentQueue.length) {
        startSegment(segmentQueue[segmentIndex]);
      } else {
        // CONTRACT: when a sequence finishes the fake STOPS emitting frames
        // (activeSegment = null, queue cleared). E9b's "answers blocked while
        // paused" proof relies on this: a hold started while paused only fills
        // ~950ms of the 1500ms PAUSE_CLEAR_MS stabilization window, then the
        // counter STALLS because no further frames arrive — so the overlay
        // cannot clear early. If this behavior ever changes (e.g. keep
        // emitting the last segment's state), E9b would flake.
        activeSegment = null;
        segmentQueue = [];
      }
      return;
    }
    emitFrame(activeSegment.present, activeSegment.fingers);
  }

  function startSegment(seg: FakeSegment) {
    activeSegment = seg;
    segmentStart = performance.now();
    // First frame immediately at segment start (no 50ms delay).
    emitFrame(seg.present, seg.fingers);
  }

  function startSequence(segments: FakeSegment[]) {
    clearTick();
    segmentQueue = normalizeSegments(segments);
    segmentIndex = 0;
    if (segmentQueue.length > 0) {
      startSegment(segmentQueue[0]);
      intervalId = setInterval(tick, FAKE_TICK_MS);
    }
  }

  /**
   * `frame()` pushes one frame synchronously AND starts a continuous emitter
   * that keeps pushing that state every FAKE_TICK_MS until the next
   * `sequence`/`frame` call. E9b's pause-clear proof needs a continuous
   * present stream over `PAUSE_CLEAR_MS` (1500ms) — a single push would not
   * fill the stabilization window, so the state must keep flowing.
   */
  function emitContinuously(handPresent: boolean, fingerCount: number) {
    clearTick();
    activeSegment = null;
    segmentQueue = [];
    emitFrame(handPresent, fingerCount);
    intervalId = setInterval(() => emitFrame(handPresent, fingerCount), FAKE_TICK_MS);
  }

  // The tracker shape the app's `getFakeHandTracker()` validates.
  window.__INNOVISION_FAKE_HAND_TRACKER__ = {
    start(cb: (frame: FakeFrame) => void): void {
      clearTick(); // StrictMode-idempotent: a second start must not double-run.
      onFrame = cb;
    },
    stop(): void {
      clearTick();
      onFrame = null;
      activeSegment = null;
      segmentQueue = [];
    },
  };

  // The control surface the app's `getFakeHandControl()` validates.
  window.__INNOVISION_FAKE_HAND_CONTROL__ = {
    sequence(segments: FakeSegment[]): void {
      startSequence(segments);
    },
    frame(handPresent: boolean, fingerCount: number): void {
      // A synchronous push supersedes any scripted sequence and starts a
      // continuous emitter so stabilization-window waits (E9b) can fill.
      emitContinuously(handPresent, fingerCount);
    },
  };
}
