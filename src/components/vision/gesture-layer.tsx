"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Moon, Sun } from "lucide-react";

import { HoldConfirm } from "@/lib/gestures/hold-confirm";
import { HandLossMonitor } from "@/lib/gestures/hand-loss";
import { mapFingersToOption } from "@/lib/gestures/finger-count";
import {
  BOOT_TIMEOUT_MS,
  HAND_TRACK_FEEDBACK_INTERVAL_MS,
  HAND_TRACK_FULL_INTERVAL_MS,
  HAND_TRACK_IDLE_INTERVAL_MS,
  HOLD_MS,
  MAX_ANSWER_FINGERS,
  PAUSE_AFTER_MS,
  PAUSE_CLEAR_MS,
  SCAN_COUNTDOWN_MS,
  WARN_AFTER_MS,
} from "@/lib/gestures/constants";
import { getFakeHandTracker } from "@/lib/gestures/fake-seam";
import { isFakeFaceSeamEnabled } from "@/lib/face/seam-gate";
import { isPalmNextAllowed } from "@/lib/sessions/gesture-arming";
import { HandLandmarkerTracker } from "@/lib/gestures/hand-tracker";
import type { HandFrame, HoldProgress, IHandTracker } from "@/lib/gestures/types";
import type { FaceStatus } from "@/lib/face/types";
import { GestureCalibration, CalibrationHud } from "@/components/vision/gesture-calibration";
import { useMediaQuery } from "@/hooks/use-media-query";


type GestureStatus = "booting" | "calibrating" | "active" | "off";
type HandLost = "warn" | "paused" | null;

/** Throttle for the calibration finger-count readout (~5Hz, no render storm). */
const CALIBRATION_READOUT_INTERVAL_MS = 200;

/**
 * Tolerance for spurious single-frame sensor drops / confidence dips.
 * Upon a 1-frame dropout, the stabilizer takes FINGER_STABILIZER_RUN (2) frames
 * to re-verify the count. Allowing 2 dropout frames (~66ms at 30fps) prevents
 * hold accumulator resets on single-frame sensor flickers while resetting within
 * ~99ms upon genuine hand withdrawal.
 */
const HOLD_DROPOUT_FRAME_TOLERANCE = 2;

/**
 * GestureLayer â€” the Phase 6 wrapper that owns ALL gesture state/UI:
 * tracker lifecycle, calibration gate, hold-to-confirm (answer + palm-next),
 * hand-loss (warn/pause), scan countdown, and overlays.
 *
 * Degradation contract (hard requirement):
 *  - Unavailable/skipped â†’ pure passthrough (children as-is + an "off" chip).
 *  - `booting` renders children as-is â€” the quiz is clickable from first paint.
 *  - The real boot (camera â†’ bundle â†’ WASM â†’ model) is raced against
 *    `BOOT_TIMEOUT_MS`; any failure/timeout â†’ `off`.
 *
 * Latest-ref dispatch (stale-closure fix): the frame handler reads ONLY
 * `stateRef.current.*` and calls callback refs, all reassigned every render.
 * Finger input is gated at the TOP of the handler on `status === "active"`
 * (single enforcement point â€” during `calibrating` the tracker runs but no
 * answer/next can fire before Continue).
 *
 * Persistent video/canvas: ONE `<video>`/`<canvas>` pair is always mounted
 * (positioned by CSS as the calibration panel or the bottom-right PIP), so
 * React never remounts the video node and kills the stream on the
 * calibrationâ†’PIP transition.
 */
export function GestureLayer({
  enabled = true,
  hasFingerInput = true,
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
  onWarnChange,
  onStatusChange,
  children,
}: {
  /** Quiz-level kill switch (quizzes.gestures_enabled, v4.9). When false the
   * layer renders its children UNWRAPPED: no boot effect, no tracker, no
   * camera permission prompt, no bundle fetch. The flag is a QUIZ property
   * (draft-frozen, so it cannot change mid-live) and wins over any user
   * setting â€” the lecturer chose the modality for this assessment. */
  enabled?: boolean;
  /** Whether the CURRENT question can be answered by fingers. False for
   * short_text (0 options, typed answer) â€” the AnswerPad never arms for it,
   * so the `< MAX_ANSWER_FINGERS` guard on palm-next is meaningless there
   * and would wrongly deny "next" on a question with few options. */
  hasFingerInput?: boolean;
  mode: "practice" | "assessment";
  optionCount: number;
  questionId: string;
  armed: boolean;
  nextArmed: boolean;
  /** QT-1: "multi" on multi-select questions â€” holding N fingers (1..4)
   * LATCHES a toggle of presented option N (onToggleSelect) and an open palm
   * COMMITS the pending set (onCommit). Multi questions are capped at 4
   * options (0037 questions_multi_option_cap) so five fingers is never an
   * option pose. "single" (default) is the unchanged scalar latch. */
  answerMode?: "single" | "multi";
  /** QT-1: the quiz contains at least one multi-select question â€” the
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
  /** Polish round (W2 C4): mirrors the warn state upward so the play screen
   * can render the "keep your hand visible" chip INSIDE the fixed action bar
   * instead of a fourth sticky floating layer. Fires on warnâ†”cleared only. */
  onWarnChange?: (warning: boolean) => void;
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
  // R1: the init MUST key on `enabled` â€” an unconditional "booting" leaves
  // the layer stuck in a status whose branch renders the camera shell even
  // though the boot effect below deliberately never runs.
  const [status, setStatus] = useState<GestureStatus>(enabled ? "booting" : "off");

  const [handLost, setHandLost] = useState<HandLost>(null);
  const [scanning, setScanning] = useState(false);
  const [trackerReady, setTrackerReady] = useState(false);
  const [simulated, setSimulated] = useState(false);
  const [calibFingerCount, setCalibFingerCount] = useState(0);
  const [calibHandDetected, setCalibHandDetected] = useState(false);
  const [calibLighting, setCalibLighting] = useState<"good" | "too_dark" | "too_bright">("good");
  const [activeLighting, setActiveLighting] = useState<"good" | "too_dark" | "too_bright">("good");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trackerRef = useRef<IHandTracker | null>(null);
  const answerHoldRef = useRef(new HoldConfirm(HOLD_MS));
  const commitHoldRef = useRef(new HoldConfirm(HOLD_MS));
  const nextHoldRef = useRef(new HoldConfirm(HOLD_MS));
  const answerDropCountRef = useRef(0);
  const commitDropCountRef = useRef(0);
  const nextDropCountRef = useRef(0);
  // QT-1 re-arm gate: the finger count of the last latch (null = armed).
  // A latch re-arms only after the pose CHANGES (hand lost or different
  // count) â€” a sustained hold must never re-fire (a 2.4s hold would toggle
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
    hasFingerInput,
    answerMode,
    scanning,
    status,
  });
  // `handLost` is mirrored separately and written synchronously so the frame
  // handler's "block input while paused" gate is airtight (no render lag).
  const handLostRef = useRef<HandLost>(null);
  // P7: server-pause mirror (reassigned in the latest-ref effect below).
  const sessionPausedRef = useRef(Boolean(sessionPaused));
  // audit-2 M-23: `blockInput` (submit/timeUp takeover suppression) was also
  // dead in the frame handler â€” mirrored now so holds reset behind it too.
  const blockInputRef = useRef(Boolean(blockInput));
  const onPauseRef = useRef(onPause);
  const frameHandlerRef = useRef<(frame: HandFrame) => void>(() => {});
  const onSelectRef = useRef(onSelect);
  const onToggleSelectRef = useRef(onToggleSelect);
  const onCommitRef = useRef(onCommit);
  const onNextRef = useRef(onNext);
  const onHoldRef = useRef(onHoldProgress);
  const onStatusChangeRef = useRef(onStatusChange);
  // Polish round (W2 C4): warnâ†”cleared mirrors to the parent (play screen
  // renders the warn chip inside its action bar). Fires on transitions only.
  // Declared BEFORE setHandLostState so the closure can never race a
  // render-scope call (TDZ safety â€” every current caller is post-render, but
  // the ordering makes that invariant structural rather than lucky).
  const onWarnChangeRef = useRef(onWarnChange);
  const warnMirroredRef = useRef(false);

  /** Set `handLost` state AND the ref synchronously (single source of truth). */
  function setHandLostState(v: HandLost) {
    handLostRef.current = v;
    setHandLost(v);
    const warn = v === "warn";
    if (warn !== warnMirroredRef.current) {
      warnMirroredRef.current = warn;
      onWarnChangeRef.current?.(warn);
    }
  }

  /** Quantized hold-progress emission (5% steps â€” no per-frame render storm). */
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
    onWarnChangeRef.current = onWarnChange;
    sessionPausedRef.current = Boolean(sessionPaused);
    blockInputRef.current = Boolean(blockInput);
    onPauseRef.current = onPause;
    stateRef.current = { optionCount, questionId, armed, nextArmed, hasFingerInput, answerMode, scanning, status };

    // Detection duty cycle (CPU-bound hosts: two MediaPipe landmarkers run
    // concurrently and the GPU delegate usually falls back to WASM). Phase-
    // gated on what can CONSUME input frames: FULL while a question is
    // answerable or the scan countdown runs, FEEDBACK during feedback dwell
    // (palm-next hold stays live â€” 66ms keeps the 1.2s hold smooth), IDLE
    // when nothing can fire (reading/locked states). Calibration stays FULL:
    // it is the teaching moment â€” the finger tray must feel live â€” and it is
    // brief. Frame-count downstream semantics (stabilizer run lengths,
    // dropout tolerance) are preserved â€” only fps changes, and only when no
    // hold is possible.
    const tier = armed || scanning || status === "calibrating"
      ? HAND_TRACK_FULL_INTERVAL_MS
      : nextArmed
        ? HAND_TRACK_FEEDBACK_INTERVAL_MS
        : HAND_TRACK_IDLE_INTERVAL_MS;
    trackerRef.current?.setFrameInterval?.(tier);

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

      // The doc contract gates finger input at the TOP of the handler on
      // `status === "active"`. Only `calibrating` is read out above; every other
      // non-active status (`booting`, `off`) must not run the answer/palm-next
      // paths — a frame delivered before the status flip would otherwise
      // exercise the full input machinery behind the calibration card.
      if (s.status !== "active") return;

      if (frame.lighting) {
        setActiveLighting(frame.lighting);
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
        // Clear only the WARN state here — a client `paused` must not be
        // wiped by a phase flip (armed→false) without the PAUSE_CLEAR_MS
        // stabilization window; only a sustained hand-present frame (or the
        // explicit onContinue/onSkip reset) may clear it.
        if (handLostRef.current === "warn") {
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
        // Block ALL finger input while paused. ALL hold accumulators reset —
        // omitting commitHoldRef let a pre-pause open-palm accumulator latch
        // the instant input unblocked (E9b violation: a hold started before
        // the pause fires on the first post-resume frame with zero fresh hold).
        answerDropCountRef.current = 0;
        commitDropCountRef.current = 0;
        nextDropCountRef.current = 0;
        answerHoldRef.current.reset();
        commitHoldRef.current.reset();
        nextHoldRef.current.reset();
        emitHold(null);
        return;
      }
      handPresentSinceRef.current = 0;

      // audit-2 M-23: server-paused/flagged (sessionPaused) and input-takeover
      // (blockInput) phases used to be DEAD gates here — the props were
      // assigned but never read by the frame handler, so gestures kept
      // firing behind the pause (answers failed safe at the server 409, but
      // palm-next browsed questions behind the BlockingOverlay). Block all
      // hold input and reset every hold so nothing fires on resume.
      if (sessionPausedRef.current || blockInputRef.current) {
        answerDropCountRef.current = 0;
        commitDropCountRef.current = 0;
        nextDropCountRef.current = 0;
        answerHoldRef.current.reset();
        commitHoldRef.current.reset();
        nextHoldRef.current.reset();
        emitHold(null);
        return;
      }

      // 2b (moved ABOVE the palm-next path — audit-2 M-23 palm double-fire):
      // QT-1 re-arm gate: after ANY latch, holds stay dead until the pose
      // changes (hand lost or a different finger count) — a sustained hold
      // must never re-fire. It has to precede palm-next: the multi COMMIT
      // latches with a sustained 5-palm and re-arms on 5, so palm-next
      // running first re-used the still-hot nextHold and auto-advanced past
      // the feedback review 1.2s later. In single mode the gate is normally
      // a no-op because a latch leaves `armed` anyway.
      if (rearmCountRef.current !== null) {
        if (!frame.handPresent || frame.fingerCount !== rearmCountRef.current) {
          rearmCountRef.current = null;
        } else {
          answerDropCountRef.current = 0;
          commitDropCountRef.current = 0;
          nextDropCountRef.current = 0;
          answerHoldRef.current.reset();
          commitHoldRef.current.reset();
          nextHoldRef.current.reset();
          emitHold(null);
          return;
        }
      }

      // 2. Palm-next (before the answer path). Finger 5 on an optionCount < 5
      //    question can never be a valid answer, so it is a safe "next" affordance.
      //    (QT-1 multi questions cap at 4 options, so this gate never blocks
      //    them; in multi mode palm means COMMIT while armed anyway — 2b/3.)
      // B6-7/B7-5: the `< MAX_ANSWER_FINGERS` term exists because finger 5
      // on a 5-option question could be a valid ANSWER pose. For a type with
      // no finger input at all (short_text: 0 options) that concern does not
      // exist, and the term would wrongly deny palm-next — so it applies
      // only when the answer pad is actually in play. The predicate lives in
      // src/lib/sessions/gesture-arming.ts (U-65 pins it).
      if (s.nextArmed
          && isPalmNextAllowed({
               hasFingerInput: s.hasFingerInput,
               optionCount: s.optionCount,
               maxAnswerFingers: MAX_ANSWER_FINGERS,
             })
          && !s.scanning) {
        if (frame.fingerCount === 5) {
          nextDropCountRef.current = 0;
          const nextRes = nextHoldRef.current.update(5, now);
          emitHold({ finger: 5, progress: nextRes.progress });
          if (nextRes.latched !== undefined) {
            nextHoldRef.current.reset();
            emitHold(null);
            rearmCountRef.current = MAX_ANSWER_FINGERS;
            onNextRef.current();
            return;
          }
        } else if (lastEmittedHoldRef.current?.finger === 5 && nextDropCountRef.current < HOLD_DROPOUT_FRAME_TOLERANCE) {
          // Sensor dropout tolerance against spurious sensor loss
          nextDropCountRef.current++;
          return;
        } else {
          nextDropCountRef.current = 0;
          nextHoldRef.current.reset();
          if (lastEmittedHoldRef.current?.finger === 5) {
            emitHold(null);
          }
        }
      } else {
        nextDropCountRef.current = 0;
        nextHoldRef.current.reset();
      }

      // 3. Answer path. "multi" mode (QT-1): holds 1..4 TOGGLE the presented
      //    option and an open palm COMMITS the pending set; "single" mode is
      //    the unchanged scalar latch (hold = submit one answer).
      if (s.scanning || !s.armed) {
        answerDropCountRef.current = 0;
        commitDropCountRef.current = 0;
        nextDropCountRef.current = 0;
        answerHoldRef.current.reset();
        commitHoldRef.current.reset();
        emitHold(null);
        return;
      }
      if (s.answerMode === "multi") {
        if (frame.fingerCount === MAX_ANSWER_FINGERS) {
          commitDropCountRef.current = 0;
          const commitRes = commitHoldRef.current.update(MAX_ANSWER_FINGERS, now);
          emitHold({ finger: MAX_ANSWER_FINGERS, progress: commitRes.progress });
          if (commitRes.latched !== undefined) {
            commitHoldRef.current.reset();
            answerHoldRef.current.reset();
            nextHoldRef.current.reset();
            emitHold(null);
            rearmCountRef.current = MAX_ANSWER_FINGERS;
            onCommitRef.current?.();
          }
          return;
        }
        if (lastEmittedHoldRef.current?.finger === MAX_ANSWER_FINGERS && commitDropCountRef.current < HOLD_DROPOUT_FRAME_TOLERANCE) {
          commitDropCountRef.current++;
          return;
        } else {
          commitDropCountRef.current = 0;
          commitHoldRef.current.reset();
          if (lastEmittedHoldRef.current?.finger === MAX_ANSWER_FINGERS) {
            emitHold(null);
          }
        }

        if (mapFingersToOption(frame.fingerCount, s.optionCount) === null) {
          if (
            lastEmittedHoldRef.current !== null &&
            lastEmittedHoldRef.current.finger !== MAX_ANSWER_FINGERS &&
            answerDropCountRef.current < HOLD_DROPOUT_FRAME_TOLERANCE
          ) {
            // Dropout tolerance for active answer hold
            answerDropCountRef.current++;
            return;
          }
          answerDropCountRef.current = 0;
          answerHoldRef.current.reset();
          emitHold(null);
          return;
        }
        answerDropCountRef.current = 0;
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
        // Dropout tolerance for an ACTIVE hold. On a 5-option question the
        // open palm IS a valid answer pose and palm-next is gate-disabled
        // (isPalmNextAllowed false), so palm gets the same tolerance as the
        // 1–4 fingers — the `finger !== MAX` exclusion exists to keep the two
        // palm semantics (answer vs palm-next) unambiguous on <5-option
        // questions only.
        const palmIsAnswer = s.optionCount >= MAX_ANSWER_FINGERS;
        if (
          lastEmittedHoldRef.current !== null &&
          (lastEmittedHoldRef.current.finger !== MAX_ANSWER_FINGERS || palmIsAnswer) &&
          answerDropCountRef.current < HOLD_DROPOUT_FRAME_TOLERANCE
        ) {
          answerDropCountRef.current++;
          return;
        }
        answerDropCountRef.current = 0;
        answerHoldRef.current.reset();
        emitHold(null);
        return;
      }
      answerDropCountRef.current = 0;
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
    // R2/R18: the ONE body-gated effect. Every other effect self-gates on
    // `status`/`trackerRef`, so gating them too would be redundant. The
    // fake-seam branch is INSIDE this gate deliberately: a harness seam must
    // not resurrect gestures on a quiz whose flag is off, which is what E-53
    // asserts (zero bundle fetch, fake seam included).
    if (!enabled) {
      disposedRef.current = true;
      trackerRef.current?.stop();
      trackerRef.current = null;
      return;
    }

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
      // `booting` status meanwhile â€” the frame handler gates on `active`, so
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
        // silently freezing the camera (hand-tracker no longer rethrows â€” a
        // throw would become an unhandled window.onerror the boot race can't
        // catch).
        await tracker.start(
          (frame) => frameHandlerRef.current(frame),
          (err) => {
            console.error("Hand tracking loop failed:", err);
            // Release the shared camera token â€” a dead loop must not keep the
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
          // stream via the tracker's disposed check â€” camera light never stays on).
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
          // camera token was acquired) â€” release the token, same as the
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
    // `enabled` flips (quiz flag off→on, or a re-arm) must re-boot: a mount-only
    // [] left the layer stuck in `off` when the flag arrived late. The cleanup
    // above stops the previous tracker, and bootId guards late resolutions, so
    // re-running on flip is StrictMode-safe.
  }, [enabled]);

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
      commitHoldRef.current.reset();
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

  // Wide gate (plan W2 Â§2): one media query, comma-OR. Below it the camera
  // becomes a picture-in-picture overlay instead of a full-width block that
  // pushes the question below the fold. Lives INSIDE GestureLayer (the state
  // owner) per the component-swap boundary rule.
  const isWide = useMediaQuery("(min-width: 1024px), (orientation: landscape) and (min-width: 640px)");
  // PIP expansion: manual toggle ONLY when not armed â€” while a pose is held,
  // a tap would need a second hand in frame, which finger-count reads as
  // input. While armed the PIP is glance-only (mirror + status ring).
  // Polish round (C1): the DEFAULT is the collapsed ~24px status dot â€” the
  // always-open 84px self-view was a floating layer that never earned its
  // pixels; the ring color carries live face status at a glance and a tap
  // expands the full self-check card (44px hit target via the -8px inset).
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

  const isLightingDegraded = activeLighting !== "good";

  const statusRingClass = isFlagged
    ? "border-rose-300 ring-[3.5px] ring-rose-400/50"
    : isVerifying
    ? "border-amber-300 ring-[3.5px] ring-amber-400/60 animate-pulse"
    : isLightingDegraded
    ? "border-amber-300 ring-[3.5px] ring-amber-400/60 animate-pulse"
    : isVerified
    ? "border-emerald-300 ring-[3.5px] ring-emerald-400/40"
    : "border-[#fed7aa] ring-[3.5px] ring-orange-200/50";

  // Collapsed-PIP dot ring (polish C1): live status + lighting semantics, scaled to
  // a 24px element â€” solid border color + soft halo instead of the fat ring.
  const pipDotRingClass = isFlagged
    ? "border-rose-400 shadow-[0_0_0_3px_rgba(251,113,133,0.35)]"
    : isVerifying
    ? "border-amber-400 shadow-[0_0_0_3px_rgba(251,191,36,0.4)] animate-pulse"
    : isLightingDegraded
    ? "border-amber-400 shadow-[0_0_0_3px_rgba(251,191,36,0.4)] animate-pulse"
    : isVerified
    ? "border-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.3)]"
    : "border-orange-300 shadow-[0_0_0_3px_rgba(253,186,116,0.35)]";

  // â”€â”€ Persistent video/canvas container (always mounted) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let videoContainerClass = "hidden";
  if (status === "calibrating" || status === "booting") {
    videoContainerClass = isWide
      ? "relative mx-auto aspect-video w-full max-w-2xl overflow-hidden rounded-[2rem] border-[3.5px] border-border bg-muted shadow-[var(--shadow-clay)]"
      // Calibration stepper (plan W3): portrait camera ~45dvh, finger chips
      // directly beneath (adjacency), instructions one at a time.
      : "relative aspect-[3/4] w-full overflow-hidden rounded-[2rem] border-[3.5px] border-border bg-muted shadow-[var(--shadow-clay)]";
  } else if (status === "active") {
    videoContainerClass = isWide
      ? `relative w-full h-full flex-1 min-h-[350px] lg:min-h-0 overflow-hidden rounded-[2rem] border-[3.5px] ${statusRingClass} bg-[#fff7ed] p-2.5 shadow-[var(--shadow-clay)] transition-[border-color,box-shadow] duration-300 pointer-events-none`
      : pipExpanded
        // Expanded self-check card: centered, tap scrim or PIP to collapse.
        ? `fixed inset-x-4 top-1/2 z-50 mx-auto aspect-[3/4] max-h-[70dvh] w-auto max-w-[240px] -translate-y-1/2 overflow-hidden rounded-[18px] border-[3px] ${statusRingClass} bg-background p-2 shadow-[var(--shadow-clay)] transition-[border-color,box-shadow] duration-200 cursor-pointer`
        // Collapsed PIP (polish round C1): a ~24px status dot whose RING
        // carries the live face status; tap expands the full self-check card
        // (44px+ hit target via the hit-slop ::after inset). The 84px
        // always-open self-view never earned its pixels.
        : `hit-slop fixed right-4 top-[calc(var(--safe-top)+5.5rem)] z-40 grid size-6 place-items-center rounded-full border-2 ${pipDotRingClass} bg-background shadow-[0_2px_0_var(--border)] transition-[border-color,box-shadow] duration-200 ${
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
      {/* â”€â”€ Quiz flag OFF (FC-4) â”€â”€
          Rendered BEFORE the status branches and as a bare pass-through: no
          camera shell, no calibration, no status chip, no hidden video node.
          The boot effect above never ran, so there is no tracker to stop and
          nothing to leak.

          ORDER MATTERS: `status === "off"` is ALSO the user-skip state (the
          calibration panel's Skip button sets it), and that branch below
          still renders the hidden video node + the "gestures unavailable"
          chip that e9c-calibration-skip and m2-mobile-play-chrome assert.
          Replacing that branch outright would break both specs and lose the
          skip affordance â€” so the flag gets its own branch instead. */}
      {!enabled ? (
        <div className="mx-auto flex w-full max-w-3xl flex-col">{children}</div>
      ) : (
        <>
      {/* â”€â”€ Calibration & Booting Mode: Centered single-column calibration guide â”€â”€ */}
      {(status === "calibrating" || status === "booting") && (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
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
              {/* Mobile-only game HUD: status + lighting chips and the 1â€“5
                  finger tray live ON the viewfinder (design 2026-09). Wide
                  keeps the card-based readout in GestureCalibration. */}
              {!isWide && (
                <CalibrationHud
                  fingerCount={calibFingerCount}
                  handDetected={calibHandDetected}
                  lighting={calibLighting}
                  booting={!trackerReady}
                />
              )}
              {isWide && (
                <div className="pointer-events-none absolute bottom-4 inset-x-4 z-20 flex justify-center">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-black/60 px-3.5 py-1 text-center text-xs font-extrabold text-white shadow-sm backdrop-blur-sm">
                    {t("handPositionCoach")}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Mobile-first redesign (2026-09): no outer sticky wrapper â€” the
              action dock inside GestureCalibration is sticky itself, and the
              status/lighting readout lives ON the camera (CalibrationHud).
              The practice mock card is omitted <sm - the live finger tray
              plus coach copy teach toggle/commit with the real hand. */}
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
              // Invalidate any in-flight real boot BEFORE stopping: the boot's
              // post-await continuations check `bootId === bootIdRef.current`,
              // and without this bump a `start()` resolving after Skip passes
              // that check and re-enters `calibrating` with a disposed tracker
              // (Continue then yields a gesture-dead "active" with no camera).
              bootIdRef.current++;
              timedOutRef.current = true;
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

      {/* â”€â”€ Active Quiz Mode â”€â”€
          Wide (>=lg or landscape phones): 40/60 split - sticky camera column,
          quiz right. Phones: camera PIP (fixed, classes on the container
          above), quiz full-width. Two sub-branches = separate JSX; the
          re-bind effect depends on isWide so a mid-session breakpoint cross
          re-binds the new video/canvas pair (plan A9 fallback). */}
      {status === "active" && !isWide && (
        <div className="mx-auto flex w-full max-w-2xl min-w-0 flex-col">
          {/* Not-armed PIP is a real button (R3-A S2): keyboard users get
              the same self-check affordance; Escape collapses the expanded
              card. Collapsed (polish C1) it is a ~24px status dot — the
              video/canvas stay mounted inside and are merely clipped. The
              aria-hidden video/canvas remain decorative children. While armed
              the PIP is glance-only: `disabled` (not just pointer-events-none,
              which blocks mouse only) so Tab+Enter cannot activate an
              affordance togglePip would no-op anyway. */}
          <button
            type="button"
            onClick={togglePip}
            disabled={armed}
            aria-label={pipExpanded ? t("pipCollapse") : t("pipExpand")}
            aria-expanded={pipExpanded}
            className={videoContainerClass}
            data-testid="gesture-video-container"
          >
            <div className={`relative ${pipExpanded ? "h-full w-full" : "size-full"} overflow-hidden rounded-[1.5rem] bg-black`}>
              <video
                ref={videoRef}
                className="absolute inset-0 h-full w-full object-cover -scale-x-100"
                autoPlay
                playsInline
                muted
                aria-hidden
              />
              <canvas ref={canvasRef} className="absolute inset-0 h-full w-full object-cover" aria-hidden />
              {pipExpanded && activeLighting !== "good" && (
                <div
                  className="absolute top-3 left-3 z-20 flex items-center gap-1.5 rounded-full border border-amber-500/60 bg-amber-950/80 px-2.5 py-1 backdrop-blur-sm"
                  role="status"
                >
                  {activeLighting === "too_dark" ? (
                    <Moon className="size-3 text-amber-300" aria-hidden />
                  ) : (
                    <Sun className="size-3 text-amber-300" aria-hidden />
                  )}
                  <span className="text-[11px] font-bold text-amber-200">
                    {activeLighting === "too_dark" ? t("lightingTooDark") : t("lightingTooBright")}
                  </span>
                </div>
              )}
              {pipExpanded && (
                <div className="pointer-events-none absolute bottom-3 inset-x-2 z-20 flex justify-center">
                  <span className="inline-flex items-center rounded-full bg-black/70 px-2.5 py-0.5 text-center text-[10px] font-extrabold text-white backdrop-blur-sm">
                    {t("handPositionCoach")}
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

          {/* Phone hand-loss warning banner contract:
              On phone viewports, the hand-loss warning is not displayed as a floating banner overlay;
              the warning state mirrors up via onWarnChange and the play screen renders the
              chip inline inside its fixed action bar. The wide layout renders its in-camera
              viewfinder badge directly. */}

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

                {handLost !== "warn" && activeLighting !== "good" && (
                  <div
                    className="absolute top-4 left-4 z-20 flex items-center gap-2 rounded-full border border-amber-500/60 bg-amber-950/80 px-3 py-1.5 backdrop-blur-sm animate-pulse"
                    role="status"
                  >
                    {activeLighting === "too_dark" ? (
                      <Moon className="size-3.5 text-amber-300" aria-hidden />
                    ) : (
                      <Sun className="size-3.5 text-amber-300" aria-hidden />
                    )}
                    <span className="text-xs font-extrabold tracking-wide text-amber-200">
                      {activeLighting === "too_dark" ? t("lightingTooDark") : t("lightingTooBright")}
                    </span>
                  </div>
                )}

                {/* Viewfinder coach guidance for optimal contrast */}
                <div className="pointer-events-none absolute bottom-4 inset-x-4 z-20 flex justify-center">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-black/60 px-3.5 py-1 text-center text-xs font-extrabold text-white shadow-sm backdrop-blur-sm">
                    {t("handPositionCoach")}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN - QUIZ (~60%) */}
          <div className="mx-auto flex w-full max-w-2xl min-w-0 flex-col lg:max-w-none">
            {children}
          </div>
        </div>
      )}

      {/* â”€â”€ Offline Mode fallback: Centered single-column â”€â”€ */}
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
        </>
      )}
    </div>
  );
}

