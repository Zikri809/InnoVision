"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

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
import type { FaceStatus } from "@/lib/face/types";
import { GestureCalibration } from "@/components/vision/gesture-calibration";


type GestureStatus = "booting" | "calibrating" | "active" | "off";
type HandLost = "warn" | "paused" | null;

/** Throttle for the calibration finger-count readout (~5Hz, no render storm). */
const CALIBRATION_READOUT_INTERVAL_MS = 200;

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
  faceStatus,
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
  /** Face status for live status ring feedback (Phase 7). */
  faceStatus?: FaceStatus;
  /** P7: called when the hand-loss monitor fires `pause` (server-side pause). */
  onPause?: () => void;
  onSelect: (index: number) => void;
  onNext: () => void;
  onHoldProgress: (p: HoldProgress | null) => void;
  onStatusChange: (status: "active" | "off") => void;
  children: ReactNode;
}) {
  const t = useTranslations("vision");
  const [status, setStatus] = useState<GestureStatus>("booting");

  const [handLost, setHandLost] = useState<HandLost>(null);
  const [scanning, setScanning] = useState(false);
  const [trackerReady, setTrackerReady] = useState(false);
  const [simulated, setSimulated] = useState(false);
  const [calibFingerCount, setCalibFingerCount] = useState(0);
  const [calibHandDetected, setCalibHandDetected] = useState(false);
  const [calibLighting, setCalibLighting] = useState<"good" | "too_dark" | "too_bright">("good");

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

      // Calibration readout (throttled).
      if (s.status === "calibrating") {
        if (now - lastCalibEmitRef.current >= CALIBRATION_READOUT_INTERVAL_MS) {
          lastCalibEmitRef.current = now;
          setCalibFingerCount(frame.fingerCount);
          setCalibHandDetected(frame.handPresent);
          if (frame.lighting) setCalibLighting(frame.lighting);
        }
        return;
      }

      // 1. Hand-loss bookkeeping — only while answerable or scanning, so
      //    locked/feedback/submitting don't trip spurious loss warnings.
      if (s.armed || s.scanning) {
        const res = lossRef.current.update(frame.handPresent, now);
        if (res.pause) {
          setHandLostState("paused");
          onPauseRef.current?.();
        } else if (res.warn && handLostRef.current !== "paused") {
          setHandLostState("warn");
        } else if (frame.handPresent && handLostRef.current === "warn") {
          setHandLostState(null);
        }
      } else {
        lossRef.current.reset();
        if (handLostRef.current !== null) {
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
        if (frame.fingerCount === 5) {
          emitHold({ finger: 5, progress: nextRes.progress });
        } else {
          emitHold(null);
        }
        if (nextRes.latched !== undefined) {
          nextHoldRef.current.reset();
          emitHold(null);
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
            // Release the shared camera token — a dead loop must not keep the
            // webcam light on for the rest of the quiz (stop() is idempotent).
            tracker.stop();
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
          // start() rejected (e.g. MediaPipe model failed to load AFTER the
          // camera token was acquired) — release the token, same as the
          // timeout path above.
          trackerRef.current?.stop();
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

  // Notify parent of status changes.
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (status === "active" && prev !== "active") {
      onStatusChangeRef.current("active");
    } else if (status === "off" && prev !== "off") {
      onStatusChangeRef.current("off");
    }
    prevStatusRef.current = status;
  }, [status]);

  // Re-bind DOM elements to tracker on status changes (safeguard for DOM transitions).
  useEffect(() => {
    if (videoRef.current && canvasRef.current && trackerRef.current) {
      trackerRef.current.bindDOMElements?.({
        video: videoRef.current,
        canvas: canvasRef.current,
      });
    }
  }, [status]);

  // Status ring border colors (clay pastel palette)
  const isFlagged = faceStatus === "flagged";
  const isVerifying = faceStatus === "paused" || faceStatus === "recovering" || faceStatus === "gate";
  const isVerified = faceStatus === "ready";

  const statusRingClass = isFlagged
    ? "border-rose-300 ring-[3.5px] ring-rose-400/50"
    : isVerifying
    ? "border-amber-300 ring-[3.5px] ring-amber-400/60 animate-pulse"
    : isVerified
    ? "border-emerald-300 ring-[3.5px] ring-emerald-400/40"
    : "border-[#fed7aa] ring-[3.5px] ring-orange-200/50";

  // ── Persistent video/canvas container (always mounted) ─────────────
  let videoContainerClass = "hidden";
  if (status === "calibrating" || status === "booting") {
    videoContainerClass =
      "relative mx-auto aspect-video w-full max-w-2xl overflow-hidden rounded-[2rem] border-[3.5px] border-border bg-muted shadow-[var(--shadow-clay)]";
  } else if (status === "active") {
    videoContainerClass = `relative w-full h-full flex-1 min-h-[350px] lg:min-h-0 overflow-hidden rounded-[2rem] border-[3.5px] ${statusRingClass} bg-[#fff7ed] p-2.5 shadow-[var(--shadow-clay)] transition-all duration-300 pointer-events-none`;
  }

  return (
    <div className="relative w-full min-h-full">
      {/* ── Calibration & Booting Mode: Centered single-column calibration guide ── */}
      {(status === "calibrating" || status === "booting") && (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          <div className={videoContainerClass} data-testid="gesture-video-container">
            <div className="relative h-full w-full overflow-hidden rounded-[1.5rem] bg-black">
              <video
                ref={videoRef}
                className="absolute inset-0 h-full w-full object-cover -scale-x-100"
                autoPlay
                playsInline
                muted
              />
              <canvas ref={canvasRef} className="absolute inset-0 h-full w-full object-cover" aria-hidden />
              {simulated && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-sm text-white">
                  Simulated hand tracking (test mode)
                </div>
              )}
            </div>
          </div>

          <GestureCalibration
            fingerCount={calibFingerCount}
            handDetected={calibHandDetected}
            lighting={calibLighting}
            notice={t("privacyNotice")}
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
        </div>
      )}

      {/* ── Active Quiz Mode: 40/60 Split Layout (Camera Left Full-Height, Quiz Right) ── */}
      {status === "active" && (
        <div className="grid w-full grid-cols-1 items-stretch gap-8 lg:grid-cols-[2fr_3fr] lg:gap-12 min-h-[calc(100vh-6rem)]">
          {/* LEFT COLUMN — CAMERA (~40% full width and full height) */}
          <div className="flex w-full h-full flex-col items-center lg:sticky lg:top-6 lg:h-[calc(100vh-6rem)]">
            <div className={videoContainerClass} data-testid="gesture-video-container">
              <div className="relative h-full w-full overflow-hidden rounded-[1.5rem] bg-black">
                <video
                  ref={videoRef}
                  className="absolute inset-0 h-full w-full object-cover -scale-x-100"
                  autoPlay
                  playsInline
                  muted
                  aria-hidden={status === "active" ? true : undefined}
                />
                <canvas ref={canvasRef} className="absolute inset-0 h-full w-full object-cover" aria-hidden />

                {/* Flashing amber text indicator over top-left of video feed */}
                {handLost === "warn" && (
                  <div
                    className="absolute top-4 left-4 z-20 flex items-center gap-2 rounded-full bg-black/45 px-3 py-1.5 backdrop-blur-xs animate-pulse"
                    role="status"
                  >
                    <span className="size-2 rounded-full bg-amber-400" aria-hidden />
                    <span className="text-xs font-extrabold tracking-wide text-amber-300 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                      {t("keepHandVisible")}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN — QUIZ (~60%) */}
          <div className="mx-auto flex w-full max-w-2xl min-w-0 flex-col lg:max-w-none">
            {children}
          </div>
        </div>
      )}

      {/* ── Offline Mode fallback: Centered single-column ── */}
      {status === "off" && (
        <div className="mx-auto flex w-full max-w-3xl flex-col">
          {/* Hidden persistent video node */}
          <div className="hidden" data-testid="gesture-video-container">
            <video ref={videoRef} autoPlay playsInline muted aria-hidden />
            <canvas ref={canvasRef} aria-hidden />
          </div>
          {children}
          <div className="mt-4 text-center text-xs text-muted-foreground" role="status">
            {t("gesturesUnavailable")}
          </div>
        </div>
      )}

      {/* Hand loss full pause overlay (dialog when paused in assessment) */}
      {status === "active" && handLost === "paused" && !blockInput && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 p-4"
          role="alert"
        >
          <div className="rounded-2xl border-[3px] border-border bg-card p-6 text-center shadow-[var(--shadow-clay)]">
            <p className="font-heading text-base font-semibold">{t("handPaused")}</p>
            <p className="mt-2 text-sm font-semibold text-muted-foreground">
              {t("handPausedResume")}
            </p>
          </div>
        </div>
      )}

      {/* Scan countdown overlay */}
      {status === "active" && scanning && (
        <div
          className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center"
          data-testid="scan-overlay"
        >
          <div className="rounded-xl bg-black/70 px-6 py-3 text-2xl font-semibold text-white">
            {t("scanCountdown")}
          </div>
        </div>
      )}
    </div>
  );
}

