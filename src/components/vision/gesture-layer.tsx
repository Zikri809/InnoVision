"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { HoldConfirm } from "@/lib/gestures/hold-confirm";
import { HandLossMonitor } from "@/lib/gestures/hand-loss";
import { mapFingersToOption } from "@/lib/gestures/finger-count";
import {
  BOOT_TIMEOUT_MS,
  HOLD_MS,
  MAX_ANSWER_FINGERS,
  PAUSE_AFTER_MS,
  PAUSE_CLEAR_MS,
  SCAN_COUNTDOWN_MS,
  WARN_AFTER_MS,
} from "@/lib/gestures/constants";
import { getFakeHandTracker } from "@/lib/gestures/fake-seam";
import { HandLandmarkerTracker } from "@/lib/gestures/hand-tracker";
import type { HandFrame, HoldProgress, IHandTracker } from "@/lib/gestures/types";
import { GestureCalibration } from "@/components/vision/gesture-calibration";

type GestureStatus = "booting" | "calibrating" | "active" | "off";
type HandLost = "warn" | "paused" | null;

/** Throttle for the calibration finger-count readout (~5Hz, no render storm). */
const CALIBRATION_READOUT_INTERVAL_MS = 200;

const PRIVACY_NOTICE =
  "Your camera is used only to count fingers. Video is processed on your device and never uploaded. Only the selected answer is sent, exactly as a click would.";

/**
 * GestureLayer — the Phase 6 wrapper that owns ALL gesture state/UI:
 * tracker lifecycle, calibration gate, hold-to-confirm (answer + palm-next),
 * hand-loss (warn/pause), scan countdown, and overlays.
 *
 * Degradation contract (hard requirement):
 *  - Unavailable/skipped → pure passthrough (children as-is + an "off" chip).
 *  - `booting` renders children as-is — the quiz is clickable from first paint.
 *  - The real boot (camera → bundle → WASM → model) is raced against
 *    `BOOT_TIMEOUT_MS`; any failure/timeout → `off`.
 *
 * Latest-ref dispatch (stale-closure fix): the frame handler reads ONLY
 * `stateRef.current.*` and calls callback refs, all reassigned every render.
 * Finger input is gated at the TOP of the handler on `status === "active"`
 * (single enforcement point — during `calibrating` the tracker runs but no
 * answer/next can fire before Continue).
 *
 * Persistent video/canvas: ONE `<video>`/`<canvas>` pair is always mounted
 * (positioned by CSS as the calibration panel or the bottom-right PIP), so
 * React never remounts the video node and kills the stream on the
 * calibration→PIP transition.
 */
export function GestureLayer({
  mode,
  optionCount,
  questionId,
  armed,
  nextArmed,
  blockInput,
  sessionPaused,
  onPause,
  onSelect,
  onNext,
  onHoldProgress,
  onStatusChange,
  children,
}: {
  mode: "practice" | "assessment";
  optionCount: number;
  questionId: string;
  armed: boolean;
  nextArmed: boolean;
  blockInput: boolean;
  /** Server-side pause gate (P7): while true, the frame handler emits NO input. */
  sessionPaused?: boolean;
  /** P7: called when the hand-loss monitor fires `pause` (server-side pause). */
  onPause?: () => void;
  onSelect: (index: number) => void;
  onNext: () => void;
  onHoldProgress: (p: HoldProgress | null) => void;
  onStatusChange: (status: "active" | "off") => void;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<GestureStatus>("booting");
  const [handLost, setHandLost] = useState<HandLost>(null);
  const [scanning, setScanning] = useState(false);
  const [trackerReady, setTrackerReady] = useState(false);
  const [simulated, setSimulated] = useState(false);
  const [calibFingerCount, setCalibFingerCount] = useState(0);
  const [calibHandDetected, setCalibHandDetected] = useState(false);
  const [pipCollapsed, setPipCollapsed] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trackerRef = useRef<IHandTracker | null>(null);
  const answerHoldRef = useRef(new HoldConfirm(HOLD_MS));
  const nextHoldRef = useRef(new HoldConfirm(HOLD_MS));
  const lossRef = useRef(
    new HandLossMonitor({
      warnAfterMs: WARN_AFTER_MS,
      pauseAfterMs: mode === "assessment" ? PAUSE_AFTER_MS : null,
    }),
  );
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);
  const timedOutRef = useRef(false);
  const bootIdRef = useRef(0);
  const firstQuestionRef = useRef(true);
  const lastEmittedHoldRef = useRef<HoldProgress | null>(null);
  const handPresentSinceRef = useRef(0);
  const lastCalibEmitRef = useRef(0);
  const prevStatusRef = useRef<GestureStatus>("booting");

  // Latest-ref mirror of props/state for the frame handler (stale-closure fix).
  const stateRef = useRef({
    optionCount,
    questionId,
    armed,
    nextArmed,
    scanning,
    status,
  });
  // `handLost` is mirrored separately and written synchronously so the frame
  // handler's "block input while paused" gate is airtight (no render lag).
  const handLostRef = useRef<HandLost>(null);
  // P7: server-pause mirror (reassigned in the latest-ref effect below).
  const sessionPausedRef = useRef(Boolean(sessionPaused));
  const onPauseRef = useRef(onPause);
  const frameHandlerRef = useRef<(frame: HandFrame) => void>(() => {});
  const onSelectRef = useRef(onSelect);
  const onNextRef = useRef(onNext);
  const onHoldRef = useRef(onHoldProgress);
  const onStatusChangeRef = useRef(onStatusChange);

  /** Set `handLost` state AND the ref synchronously (single source of truth). */
  function setHandLostState(v: HandLost) {
    handLostRef.current = v;
    setHandLost(v);
  }

  /** Quantized hold-progress emission (5% steps — no per-frame render storm). */
  function emitHold(p: HoldProgress | null) {
    if (p === null) {
      if (lastEmittedHoldRef.current !== null) {
        lastEmittedHoldRef.current = null;
        onHoldRef.current(null);
      }
      return;
    }
    const q = Math.round(p.progress * 20) / 20;
    const prev = lastEmittedHoldRef.current;
    if (prev === null || prev.finger !== p.finger || prev.progress !== q) {
      const next = { finger: p.finger, progress: q };
      lastEmittedHoldRef.current = next;
      onHoldRef.current(next);
    }
  }

  // Latest-ref effect (every render): reassign the mirrors + the frame handler.
  useEffect(() => {
    onSelectRef.current = onSelect;
    onNextRef.current = onNext;
    onHoldRef.current = onHoldProgress;
    onStatusChangeRef.current = onStatusChange;
    sessionPausedRef.current = Boolean(sessionPaused);
    onPauseRef.current = onPause;
    stateRef.current = { optionCount, questionId, armed, nextArmed, scanning, status };

    frameHandlerRef.current = (frame) => {
      const s = stateRef.current;
      const now = performance.now();

      // Calibration readout (throttled). The tracker runs but the status gate
      // below means no answer/next can fire before Continue.
      if (s.status === "calibrating") {
        if (now - lastCalibEmitRef.current >= CALIBRATION_READOUT_INTERVAL_MS) {
          lastCalibEmitRef.current = now;
          setCalibFingerCount(frame.fingerCount);
          setCalibHandDetected(frame.handPresent);
        }
        return;
      }

      // 0. Status gate — single enforcement point. `sessionPaused` (P7) blocks
      //    ALL finger input even if the hand is visible: a re-shown hand can't
      //    answer a server-paused session before blink-recovery.
      if (s.status !== "active" || sessionPausedRef.current) {
        answerHoldRef.current.reset();
        nextHoldRef.current.reset();
        emitHold(null);
        return;
      }

      // 1. Hand-loss bookkeeping — only while answerable or scanning, so
      //    "hands down while reading feedback" never warns/pauses.
      if (s.armed || s.scanning) {
        const res = lossRef.current.update(frame.handPresent, now);
        if (res.pause) {
          setHandLostState("paused");
          // P7: the hand-loss pause is server-side — notify the pipeline,
          // which POSTs /api/sessions/[id]/pause and flips status to paused.
          onPauseRef.current?.();
        } else if (res.warn && handLostRef.current !== "paused") {
          setHandLostState("warn");
        } else if (frame.handPresent && handLostRef.current === "warn") {
          // The hand is back — clear the warn chip (a present frame resets the
          // monitor's episode but does not clear the UI state on its own).
          setHandLostState(null);
        }
      }

      // Pause clear uses a stabilization window (`PAUSE_CLEAR_MS`): a single
      // present frame must NOT unlock, and a hold started while paused cannot
      // fire the instant input unblocks (E9b pins this).
      if (handLostRef.current === "paused") {
        if (frame.handPresent) {
          if (handPresentSinceRef.current === 0) handPresentSinceRef.current = now;
          if (now - handPresentSinceRef.current >= PAUSE_CLEAR_MS) {
            handPresentSinceRef.current = 0;
            setHandLostState(null);
          }
        } else {
          handPresentSinceRef.current = 0;
        }
        // Block ALL finger input while paused.
        answerHoldRef.current.reset();
        nextHoldRef.current.reset();
        emitHold(null);
        return;
      }
      handPresentSinceRef.current = 0;

      // 2. Palm-next (before the answer path). Finger 5 on an optionCount < 5
      //    question can never be a valid answer, so it is a safe "next" affordance.
      if (s.nextArmed && s.optionCount < MAX_ANSWER_FINGERS && !s.scanning) {
        const nextRes = nextHoldRef.current.update(frame.fingerCount === 5 ? 5 : 0, now);
        if (nextRes.latched !== undefined) {
          nextHoldRef.current.reset();
          onNextRef.current();
          return;
        }
      } else {
        nextHoldRef.current.reset();
      }

      // 3. Answer path.
      if (s.scanning || !s.armed) {
        answerHoldRef.current.reset();
        emitHold(null);
        return;
      }
      if (mapFingersToOption(frame.fingerCount, s.optionCount) === null) {
        answerHoldRef.current.reset();
        emitHold(null);
        return;
      }
      const ansRes = answerHoldRef.current.update(frame.fingerCount, now);
      emitHold({ finger: frame.fingerCount, progress: ansRes.progress });
      if (ansRes.latched !== undefined) {
        answerHoldRef.current.reset();
        emitHold(null);
        // `latched` is 1-based; map through the single authority. Non-null by
        // construction (latched <= optionCount), guarded defensively anyway.
        const index = mapFingersToOption(ansRes.latched, s.optionCount);
        if (index !== null) onSelectRef.current(index);
      }
    };
  });

  // Boot effect (mount only): fake-tracker seam first (non-prod), else the real
  // MediaPipe boot raced against BOOT_TIMEOUT_MS. Every post-await continuation
  // checks the boot id + disposed/timed-out so a late success can never
  // re-activate gestures after `off`/unmount (StrictMode-safe).
  useEffect(() => {
    disposedRef.current = false;
    timedOutRef.current = false;
    const bootId = ++bootIdRef.current;

    const fake = process.env.NODE_ENV === "production" ? undefined : getFakeHandTracker();

    if (fake) {
      trackerRef.current = fake;
      try {
        fake.start((frame) => frameHandlerRef.current(frame));
      } catch {
        // A broken fake must degrade to click-first, not crash the quiz.
        if (bootId === bootIdRef.current && !disposedRef.current) setStatus("off");
        return;
      }
      // Defer the state flip out of the synchronous effect body (React Compiler
      // lint: no setState synchronously in an effect). The tracker runs in
      // `booting` status meanwhile — the frame handler gates on `active`, so
      // no answer/next can fire before the calibration Continue.
      queueMicrotask(() => {
        if (bootId !== bootIdRef.current || disposedRef.current) return;
        setSimulated(true);
        setTrackerReady(true);
        setStatus("calibrating");
      });
    } else {
      async function realBoot(): Promise<boolean> {
        if (!videoRef.current || !canvasRef.current) return false;
        const tracker = new HandLandmarkerTracker({
          video: videoRef.current,
          canvas: canvasRef.current,
        });
        trackerRef.current = tracker;
        // Runtime detection errors (after boot resolves) are surfaced here so
        // a MediaPipe failure mid-quiz degrades to click-first instead of
        // silently freezing the camera (hand-tracker no longer rethrows — a
        // throw would become an unhandled window.onerror the boot race can't
        // catch).
        await tracker.start(
          (frame) => frameHandlerRef.current(frame),
          (err) => {
            console.error("Hand tracking loop failed:", err);
            if (bootId === bootIdRef.current && !disposedRef.current) {
              setStatus("off");
            }
          },
        );
        if (bootId !== bootIdRef.current || disposedRef.current || timedOutRef.current) {
          tracker.stop();
          return false;
        }
        return true;
      }

      const timeoutPromise = new Promise<never>((_, reject) => {
        bootTimerRef.current = setTimeout(() => {
          timedOutRef.current = true;
          // Stop any in-flight tracker (also stops a late-resolving getUserMedia
          // stream via the tracker's disposed check — camera light never stays on).
          trackerRef.current?.stop();
          reject(new Error("MediaPipe boot timed out"));
        }, BOOT_TIMEOUT_MS);
      });

      Promise.race([realBoot(), timeoutPromise])
        .then((ok) => {
          if (bootId !== bootIdRef.current) return;
          if (!ok || timedOutRef.current || disposedRef.current) return;
          setTrackerReady(true);
          setStatus("calibrating");
        })
        .catch(() => {
          if (bootId === bootIdRef.current && !disposedRef.current) {
            setStatus("off");
          }
        })
        .finally(() => {
          if (bootTimerRef.current) {
            clearTimeout(bootTimerRef.current);
            bootTimerRef.current = null;
          }
        });
    }

    return () => {
      disposedRef.current = true;
      if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
      if (bootTimerRef.current) clearTimeout(bootTimerRef.current);
      trackerRef.current?.stop();
      trackerRef.current = null;
    };
  }, []);

  // "3-2-1-SCAN" countdown on question transitions (after the first question),
  // only while gestures are active. Keyed on `questionId` (not optionCount) so
  // consecutive same-length questions still disarm. The timer is ref-tracked
  // and cleared on unmount/re-arm (StrictMode-safe).
  useEffect(() => {
    if (firstQuestionRef.current) {
      firstQuestionRef.current = false;
      return;
    }
    if (stateRef.current.status === "active") {
      setScanning(true);
      answerHoldRef.current.reset();
      nextHoldRef.current.reset();
      emitHold(null);
      if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
      scanTimerRef.current = setTimeout(() => {
        setScanning(false);
      }, SCAN_COUNTDOWN_MS);
    }
    return () => {
      if (scanTimerRef.current) {
        clearTimeout(scanTimerRef.current);
        scanTimerRef.current = null;
      }
    };
  }, [questionId]);

  // Transitions into/out of feedback or a scan reset the loss monitor so
  // "hands down while reading" doesn't warn/pause; leaving the answerable
  // state also resets the accumulators + hold progress and clears any
  // stale warn chip (the frame handler only clears it while armed/scanning).
  useEffect(() => {
    lossRef.current.reset();
    handPresentSinceRef.current = 0;
    if (!armed) {
      answerHoldRef.current.reset();
      emitHold(null);
    }
    if (!nextArmed) {
      nextHoldRef.current.reset();
    }
    if (!armed && !scanning && handLostRef.current === "warn") {
      setHandLostState(null);
    }
  }, [armed, nextArmed, scanning]);

  // `onStatusChange` fires ONLY on transitions to active/off (never per-render;
  // booting/calibrating are silent so PlayClient's `gestureActive` starts false).
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (status === "active" && prev !== "active") {
      onStatusChangeRef.current("active");
    } else if (status === "off" && prev !== "off") {
      onStatusChangeRef.current("off");
    }
    prevStatusRef.current = status;
  }, [status]);

  // ── Persistent video/canvas container (always mounted) ─────────────
  let videoContainerClass = "hidden";
  if (status === "calibrating") {
    videoContainerClass =
      "relative mx-auto mt-8 aspect-video w-full max-w-2xl overflow-hidden rounded-xl border bg-muted";
  } else if (status === "active") {
    videoContainerClass = pipCollapsed
      ? "hidden"
      : "pointer-events-none fixed bottom-4 right-4 z-50 size-40 overflow-hidden rounded-xl border bg-black";
  }

  return (
    <div className="relative">
      {/* Persistent video/canvas pair — never conditionally mounted, so the
          calibration→PIP transition cannot detach `srcObject`/orphan the tracker. */}
      <div className={videoContainerClass} data-testid="gesture-video-container">
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-cover"
          autoPlay
          playsInline
          muted
          aria-hidden={status === "active" ? true : undefined}
        />
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden />
        {simulated && status === "calibrating" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-sm text-white">
            Simulated hand tracking (test mode)
          </div>
        )}
        {status === "active" && !pipCollapsed && (
          <button
            type="button"
            onClick={() => setPipCollapsed(true)}
            aria-label="Hide camera preview"
            className="pointer-events-auto absolute right-1 top-1 rounded bg-black/60 px-1.5 text-xs text-white hover:bg-black/80"
          >
            ×
          </button>
        )}
      </div>
      {status === "active" && pipCollapsed && (
        <button
          type="button"
          onClick={() => setPipCollapsed(false)}
          aria-label="Show camera preview"
          className="fixed bottom-4 right-4 z-50 rounded-full border bg-card px-2 py-1 text-xs text-muted-foreground shadow-sm hover:bg-muted"
        >
          Show camera
        </button>
      )}

      {status === "calibrating" ? (
        <GestureCalibration
          fingerCount={calibFingerCount}
          handDetected={calibHandDetected}
          notice={PRIVACY_NOTICE}
          onContinue={() => {
            setHandLostState(null);
            lossRef.current.reset();
            emitHold(null);
            setStatus("active");
          }}
          onSkip={() => {
            trackerRef.current?.stop();
            trackerRef.current = null;
            setHandLostState(null);
            emitHold(null);
            setStatus("off");
          }}
          continueDisabled={!trackerReady}
        />
      ) : (
        <div>{children}</div>
      )}

      {status === "active" && (
        <>
          {handLost === "warn" && (
            <div
              className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800"
              role="status"
            >
              Keep your hand visible to answer
            </div>
          )}
          {handLost === "paused" && !blockInput && (
            <div
              className="fixed inset-0 z-40 flex items-center justify-center bg-background/80 p-4"
              role="alert"
            >
              <div className="rounded-xl border bg-card p-6 text-center shadow-lg">
                <p className="text-sm font-medium">Hand tracking paused</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Show your hand to the camera to resume.
                </p>
              </div>
            </div>
          )}
          {scanning && (
            <div
              className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center"
              data-testid="scan-overlay"
            >
              <div className="rounded-xl bg-black/70 px-6 py-3 text-2xl font-semibold text-white">
                3-2-1-SCAN
              </div>
            </div>
          )}
        </>
      )}

      {status === "off" && (
        <div className="mt-4 text-center text-xs text-muted-foreground" role="status">
          Gestures unavailable — click to answer
        </div>
      )}
    </div>
  );
}
