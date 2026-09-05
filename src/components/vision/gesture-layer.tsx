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
import { isFakeFaceSeamEnabled } from "@/lib/face/seam-gate";
import { HandLandmarkerTracker } from "@/lib/gestures/hand-tracker";
import type { HandFrame, HoldProgress, IHandTracker } from "@/lib/gestures/types";
import type { FaceStatus } from "@/lib/face/types";
import { GestureCalibration } from "@/components/vision/gesture-calibration";
import { useMediaQuery } from "@/hooks/use-media-query";


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
  answerMode = "single",
  hasMultiQuestions = false,
  blockInput,
  sessionPaused,
  faceStatus,
  onPause,
  onSelect,
  onToggleSelect,
  onCommit,
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
  /** QT-1: "multi" on multi-select questions — holding N fingers (1..4)
   * LATCHES a toggle of presented option N (onToggleSelect) and an open palm
   * COMMITS the pending set (onCommit). Multi questions are capped at 4
   * options (0037 questions_multi_option_cap) so five fingers is never an
   * option pose. "single" (default) is the unchanged scalar latch. */
  answerMode?: "single" | "multi";
  /** QT-1: the quiz contains at least one multi-select question — the
   * calibration panel renders an interactive toggle/commit practice module
   * so students meet the new vocabulary BEFORE the first multi question. */
  hasMultiQuestions?: boolean;
  blockInput: boolean;
  /** Server-side pause gate (P7): while true, the frame handler emits NO input. */
  sessionPaused?: boolean;
  /** Face status for live status ring feedback (Phase 7). */
  faceStatus?: FaceStatus;
  /** P7: called when the hand-loss monitor fires `pause` (server-side pause). */
  onPause?: () => void;
  onSelect: (index: number) => void;
  /** QT-1 multi mode: a latch TOGGLES presented option `index` in the
   * pending set (never submits). */
  onToggleSelect?: (index: number) => void;
  /** QT-1 multi mode: an open-palm latch COMMITS the pending set. */
  onCommit?: () => void;
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
  const commitHoldRef = useRef(new HoldConfirm(HOLD_MS));
  const nextHoldRef = useRef(new HoldConfirm(HOLD_MS));
  // QT-1 re-arm gate: the finger count of the last latch (null = armed).
  // A latch re-arms only after the pose CHANGES (hand lost or different
  // count) — a sustained hold must never re-fire (a 2.4s hold would toggle
  // an option straight back off).
  const rearmCountRef = useRef<number | null>(null);
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
    answerMode,
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
  const onToggleSelectRef = useRef(onToggleSelect);
  const onCommitRef = useRef(onCommit);
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
    onToggleSelectRef.current = onToggleSelect;
    onCommitRef.current = onCommit;
    onNextRef.current = onNext;
    onHoldRef.current = onHoldProgress;
    onStatusChangeRef.current = onStatusChange;
    sessionPausedRef.current = Boolean(sessionPaused);
    onPauseRef.current = onPause;
    stateRef.current = { optionCount, questionId, armed, nextArmed, answerMode, scanning, status };

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
      //    (QT-1 multi questions cap at 4 options, so this gate never blocks
      //    them; in multi mode palm means COMMIT while armed anyway — 2b/3.)
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
          rearmCountRef.current = MAX_ANSWER_FINGERS;
          onNextRef.current();
          return;
        }
      } else {
        nextHoldRef.current.reset();
      }

      // 2b. QT-1 re-arm gate: after ANY latch, holds stay dead until the pose
      //     changes (hand lost or a different finger count) — a sustained
      //     hold must never re-fire (a 2.4s hold would toggle an option
      //     straight back off). Applies to every path below; in single mode
      //     it is normally a no-op because a latch leaves `armed` anyway.
      if (rearmCountRef.current !== null) {
        if (!frame.handPresent || frame.fingerCount !== rearmCountRef.current) {
          rearmCountRef.current = null;
        } else {
          answerHoldRef.current.reset();
          commitHoldRef.current.reset();
          nextHoldRef.current.reset();
          emitHold(null);
          return;
        }
      }

      // 3. Answer path. "multi" mode (QT-1): holds 1..4 TOGGLE the presented
      //    option and an open palm COMMITS the pending set; "single" mode is
      //    the unchanged scalar latch (hold = submit one answer).
      if (s.scanning || !s.armed) {
        answerHoldRef.current.reset();
        commitHoldRef.current.reset();
        emitHold(null);
        return;
      }
      if (s.answerMode === "multi") {
        if (frame.fingerCount === MAX_ANSWER_FINGERS) {
          const commitRes = commitHoldRef.current.update(MAX_ANSWER_FINGERS, now);
          emitHold({ finger: MAX_ANSWER_FINGERS, progress: commitRes.progress });
          if (commitRes.latched !== undefined) {
            commitHoldRef.current.reset();
            answerHoldRef.current.reset();
            emitHold(null);
            rearmCountRef.current = MAX_ANSWER_FINGERS;
            onCommitRef.current?.();
          }
          return;
        }
        commitHoldRef.current.reset();
        if (mapFingersToOption(frame.fingerCount, s.optionCount) === null) {
          answerHoldRef.current.reset();
          emitHold(null);
          return;
        }
        const ansRes = answerHoldRef.current.update(frame.fingerCount, now);
        emitHold({ finger: frame.fingerCount, progress: ansRes.progress });
        if (ansRes.latched !== undefined) {
          answerHoldRef.current.reset();
          commitHoldRef.current.reset();
          emitHold(null);
          rearmCountRef.current = frame.fingerCount;
          // `latched` is 1-based; map through the single authority. Non-null by
          // construction (latched <= optionCount), guarded defensively anyway.
          const index = mapFingersToOption(ansRes.latched, s.optionCount);
          if (index !== null) onToggleSelectRef.current?.(index);
        }
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
        rearmCountRef.current = frame.fingerCount;
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

    const fake = isFakeFaceSeamEnabled() ? getFakeHandTracker() : undefined;

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

  // Wide gate (plan W2 §2): one media query, comma-OR. Below it the camera
  // becomes a picture-in-picture overlay instead of a full-width block that
  // pushes the question below the fold. Lives INSIDE GestureLayer (the state
  // owner) per the component-swap boundary rule.
  const isWide = useMediaQuery("(min-width: 1024px), (orientation: landscape) and (min-width: 640px)");
  // PIP expansion: manual toggle ONLY when not armed — while a pose is held,
  // a tap would need a second hand in frame, which finger-count reads as
  // input. While armed the PIP is glance-only (mirror + status ring).
  const [pipExpanded, setPipExpanded] = useState(false);
  const armedRef = useRef(armed);
  useEffect(() => {
    armedRef.current = armed;
  }, [armed]);

  // Re-bind DOM elements to tracker on status changes (safeguard for DOM transitions).
  // isWide dep: the mobile/wide active branches are separate JSX subtrees, so
  // a mid-session breakpoint cross remounts video/canvas - re-bind here
  // (plan A9: "extend the re-bind effect dependency to the PIP state").
  useEffect(() => {
    if (videoRef.current && canvasRef.current && trackerRef.current) {
      trackerRef.current.bindDOMElements?.({
        video: videoRef.current,
        canvas: canvasRef.current,
      });
    }
  }, [status, isWide]);

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
    videoContainerClass = isWide
      ? "relative mx-auto aspect-video w-full max-w-2xl overflow-hidden rounded-[2rem] border-[3.5px] border-border bg-muted shadow-[var(--shadow-clay)]"
      // Calibration stepper (plan W3): portrait camera ~45dvh, finger chips
      // directly beneath (adjacency), instructions one at a time.
      : "relative mx-auto aspect-[3/4] h-[45dvh] w-auto max-w-full overflow-hidden rounded-[2rem] border-[3.5px] border-border bg-muted shadow-[var(--shadow-clay)]";
  } else if (status === "active") {
    videoContainerClass = isWide
      ? `relative w-full h-full flex-1 min-h-[350px] lg:min-h-0 overflow-hidden rounded-[2rem] border-[3.5px] ${statusRingClass} bg-[#fff7ed] p-2.5 shadow-[var(--shadow-clay)] transition-all duration-300 pointer-events-none`
      : pipExpanded
        // Expanded self-check card: centered, tap scrim or PIP to collapse.
        ? `fixed inset-x-4 top-1/2 z-50 mx-auto aspect-[3/4] max-h-[70dvh] w-auto max-w-[240px] -translate-y-1/2 overflow-hidden rounded-[18px] border-[3px] ${statusRingClass} bg-background p-2 shadow-[var(--shadow-clay)] transition-all duration-200 cursor-pointer`
        // Glance PIP: top-right under the play header (safe-top + 44px row
        // + 8px gap), 84×112 (72px below 360px viewports). 3:4 crop of the
        // 4:3 source keeps the hand visible mid-frame; 1:1 fallback is the
        // documented fallback if device QA shows cropping (plan ✦A9).
        : `fixed right-3 top-[calc(var(--safe-top)+4.5rem)] z-40 aspect-[3/4] w-[84px] max-[359px]:w-[72px] overflow-hidden rounded-[18px] border-[3px] ${statusRingClass} bg-background p-1.5 shadow-[var(--shadow-clay)] transition-all duration-200 ${
            armed ? "pointer-events-none" : "cursor-pointer pointer-events-auto"
          }`;
  }

  const togglePip = () => {
    if (armedRef.current) return;
    setPipExpanded((v) => !v);
  };

  // Escape collapses the expanded self-check card (R3-A S2).
  useEffect(() => {
    if (!pipExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPipExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pipExpanded]);

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

          {/* Mobile stepper (plan W3): controls pinned to the thumb zone;
              the practice mock card is omitted <sm - the live finger chips
              plus status line teach toggle/commit with the real hand. */}
          <div className="max-sm:sticky max-sm:bottom-[calc(1rem+var(--safe-bottom))] max-sm:rounded-[22px] max-sm:bg-background/95 max-sm:p-3 max-sm:shadow-[var(--shadow-clay)]">
          <GestureCalibration
            fingerCount={calibFingerCount}
            handDetected={calibHandDetected}
            lighting={calibLighting}
            notice={t("privacyNotice")}
            multiPractice={hasMultiQuestions && isWide}
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
        </div>
      )}

      {/* ── Active Quiz Mode ──
          Wide (>=lg or landscape phones): 40/60 split - sticky camera column,
          quiz right. Phones: camera PIP (fixed, classes on the container
          above), quiz full-width. Two sub-branches = separate JSX; the
          re-bind effect depends on isWide so a mid-session breakpoint cross
          re-binds the new video/canvas pair (plan A9 fallback). */}
      {status === "active" && !isWide && (
        <div className="mx-auto flex w-full max-w-2xl min-w-0 flex-col">
          {/* Not-armed PIP is a real button (R3-A S2): keyboard users get
              the same self-check affordance; Escape collapses the expanded
              card. The aria-hidden video/canvas stay decorative children. */}
          <button
            type="button"
            onClick={togglePip}
            aria-label={t("pipExpand")}
            aria-expanded={pipExpanded}
            className={videoContainerClass}
            data-testid="gesture-video-container"
          >
            <div className="relative h-full w-full overflow-hidden rounded-[1.5rem] bg-black">
              <video
                ref={videoRef}
                className="absolute inset-0 h-full w-full object-cover -scale-x-100"
                autoPlay
                playsInline
                muted
                aria-hidden
              />
              <canvas ref={canvasRef} className="absolute inset-0 h-full w-full object-cover" aria-hidden />

              {handLost === "warn" && (
                <div
                  className="absolute top-2 left-2 z-20 flex items-center gap-1.5 rounded-full bg-[#7c2d12]/75 px-2.5 py-1 animate-pulse"
                  role="status"
                >
                  <span className="size-1.5 rounded-full bg-amber-400" aria-hidden />
                  <span className="text-2xs font-extrabold tracking-wide text-amber-100">
                    {t("keepHandVisible")}
                  </span>
                </div>
              )}
            </div>
          </button>

          {/* Expanded-PIP scrim: warm, tap to collapse. */}
          {pipExpanded && (
            <div
              className="fixed inset-0 z-40 bg-[#7c2d12]/40"
              onClick={() => setPipExpanded(false)}
              aria-hidden="true"
            />
          )}

          {children}
        </div>
      )}

      {status === "active" && isWide && (
        <div className="grid w-full grid-cols-[2fr_3fr] items-stretch gap-12 min-h-[calc(100dvh-6rem)]">
          {/* LEFT COLUMN - CAMERA (~40% full width and full height) */}
          <div className="flex w-full h-full flex-col items-center lg:sticky lg:top-6 lg:h-[calc(100dvh-6rem)]">
            <div className={videoContainerClass} data-testid="gesture-video-container">
              <div className="relative h-full w-full overflow-hidden rounded-[1.5rem] bg-black">
                <video
                  ref={videoRef}
                  className="absolute inset-0 h-full w-full object-cover -scale-x-100"
                  autoPlay
                  playsInline
                  muted
                  aria-hidden
                />
                <canvas ref={canvasRef} className="absolute inset-0 h-full w-full object-cover" aria-hidden />

                {handLost === "warn" && (
                  <div
                    className="absolute top-4 left-4 z-20 flex items-center gap-2 rounded-full bg-[#7c2d12]/75 px-3 py-1.5 animate-pulse"
                    role="status"
                  >
                    <span className="size-2 rounded-full bg-amber-400" aria-hidden />
                    <span className="text-xs font-extrabold tracking-wide text-amber-100">
                      {t("keepHandVisible")}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN - QUIZ (~60%) */}
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
          <div className="rounded-xl bg-[#7c2d12]/75 px-6 py-3 text-2xl font-semibold text-white">
            {t("scanCountdown")}
          </div>
        </div>
      )}
    </div>
  );
}

