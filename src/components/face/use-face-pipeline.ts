"use client";

import { useEffect, useRef, useState } from "react";
import type { IFaceTracker, FaceStatus } from "@/lib/face/types";
import { PeriodicCadence, shouldScheduleFaceCheck } from "@/lib/face/cadence";
import { resolveVerifyOutcome } from "@/lib/face/outcome";
import { recoverFlow, recoveryLanding } from "@/lib/face/recovery";
import { getFakeFaceControl } from "@/lib/face/fake-seam";
import {
  FLAGGED_POLL_MS,
  LIVENESS_TIMEOUT_MS,
  PERIODIC_MAX_MS,
  PERIODIC_MIN_MS,
} from "@/lib/face/constants";

export type FacePipelinePhase =
  | "question"
  | "locked"
  | "feedback"
  | "submitting"
  | "submitted"
  | "timeUp"
  | "dead";

export type FacePipelineProps = {
  sessionId: string;
  quizMode: "practice" | "assessment";
  enrolled: boolean;
  consentGiven: boolean;
  faceExempt: boolean;
  initialNonce: string;
  initialFaceStatus: FaceStatus;
  questionId: string | null;
  questionVisible: boolean;
  /** PlayClient phase — used to cancel cadence/poll/pendingVerify on terminal. */
  phase: FacePipelinePhase;
  onHandLossPause: () => void;
  onPhaseChange: (p: FacePipelinePhase) => void;
  onFaceStatus: (s: FaceStatus) => void;
  /** True when a hand gesture (hold to answer/next) is currently in progress. */
  isHandActive?: boolean;
  /** D13 — a lecturer reset the session mid-flight (verify → 404 no longer owned). */
  onReset?: () => void;
};

/**
 * useFacePipeline — the 8-state face-verification machine (Phase 7).
 *
 * States (FaceStatus): off / unavailable / exempt / gate / ready / paused /
 * recovering / flagged.
 *
 * Responsibilities:
 *  - `'gate'` → run a `'start'` verify (the assessment gate). A match → ready.
 *    The gate Begin is enabled when `status==='ready'` OR after a blink
 *    liveness pass; the `'start'` verify is the authority.
 *  - Continuous verify: `'start'` (gate), Q-transition (`'question'`), and a
 *    jittered 30–45s periodic timer. `verifyLock` + `pendingVerifyRef`
 *    (latest-wins, fires exactly once after release, re-checks current
 *    question + status, cancelled on terminal phases) ensure a Q-transition
 *    verify is NEVER silently dropped.
 *  - A fail → `'paused'` (server-paused; blink-recoverable). The blink
 *    recovery calls `self_recover_session`; a passed gate → ready.
 *  - 3 fails in the FLAT window → `'flagged'` (lecturer decision only). The
 *    flagged poll (8s) checks GET /api/sessions/[id]; on unlock it fires the
 *    re-verify BEFORE clearing the overlay (a failing re-verify re-pauses).
 *  - Hand-loss pause: `onHandLossPause` → POST /api/sessions/[id]/pause
 *    (server-side). A re-shown hand can't answer before blink-recovery.
 *  - Tab-hide: cadence paused hidden; catch-up verify on return.
 *  - Terminal phases (submitted/dead) cancel cadence/poll/pendingVerify.
 *
 * Following the P6 pure-logic split: this hook is the CLIENT LOGIC; the
 * `FaceVerifier` component renders the overlays. Function declarations are
 * hoisted so cross-references (scheduleCadence ↔ postVerify) work without
 * forward-reference lint errors; prop/ref mirrors sync in an effect.
 */
export function useFacePipeline(props: FacePipelineProps) {
  const {
    sessionId,
    quizMode,
    enrolled,
    consentGiven,
    faceExempt,
    initialNonce,
    initialFaceStatus,
    questionId,
    questionVisible,
    phase,
    onHandLossPause,
    onPhaseChange,
    onFaceStatus,
    isHandActive = false,
    onReset,
  } = props;

  const [status, setStatus] = useState<FaceStatus>(() => {
    if (quizMode !== "assessment") return "off";
    if (faceExempt) return "exempt";
    if (initialFaceStatus === "flagged" || initialFaceStatus === "paused") {
      return initialFaceStatus;
    }
    if (!enrolled || !consentGiven) return "gate";
    return initialFaceStatus === "ready" ? "ready" : "gate";
  });

  // Latest-ref mirrors (synced in an effect — React Compiler-safe).
  const statusRef = useRef(status);
  const questionVisibleRef = useRef(questionVisible);
  const questionIdRef = useRef(questionId);
  const enrolledRef = useRef(enrolled);
  const consentGivenRef = useRef(consentGiven);
  const faceExemptRef = useRef(faceExempt);
  const phaseRef = useRef(phase);
  const onPhaseChangeRef = useRef(onPhaseChange);
  const onHandLossPauseRef = useRef(onHandLossPause);
  const onFaceStatusRef = useRef(onFaceStatus);
  const isHandActiveRef = useRef(isHandActive);
  const onResetRef = useRef(onReset);

  const nonceRef = useRef(initialNonce);
  const verifyLock = useRef(false);
  // `pendingVerifyRef` stores the deferred TRIGGER (latest-wins).
  const pendingVerifyRef = useRef<"start" | "question" | "periodic" | null>(null);
  const nonceRetriedRef = useRef(false);
  const cadenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hadStartVerifyRef = useRef(false);
  const disposedRef = useRef(false);
  const hiddenRef = useRef(false);
  const trackerRef = useRef<IFaceTracker | null>(null);
  const lastQuestionIdRef = useRef<string | null>(null);

  // Terminal phases (submitted/dead) cancel all machinery. The ref is synced
  // in the mirror effect below (NEVER at render scope — a render-scope ref
  // write is a React Compiler violation and this file's convention is to sync
  // refs in effects).
  const isTerminal = phase === "submitted" || phase === "dead";
  const isTerminalRef = useRef(isTerminal);

  useEffect(() => {
    statusRef.current = status;
    questionVisibleRef.current = questionVisible;
    questionIdRef.current = questionId;
    enrolledRef.current = enrolled;
    consentGivenRef.current = consentGiven;
    faceExemptRef.current = faceExempt;
    phaseRef.current = phase;
    onPhaseChangeRef.current = onPhaseChange;
    onHandLossPauseRef.current = onHandLossPause;
    onFaceStatusRef.current = onFaceStatus;
    isHandActiveRef.current = isHandActive;
    onResetRef.current = onReset;
    isTerminalRef.current = isTerminal;
  });

  function setStatusBoth(s: FaceStatus) {
    statusRef.current = s;
    setStatus(s);
    onFaceStatusRef.current(s);
  }

  // ── Flagged poll (8s; survives timeUp while flagged) ───────────
  function startFlaggedPoll() {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    const tick = async () => {
      if (disposedRef.current || isTerminalRef.current) return;
      try {
        const res = await fetch(`/api/sessions/${sessionId}`, { method: "GET" });
        if (res.status === 404) {
          // D13 — the flagged session was RESET by a lecturer (the row is
          // gone). Terminal dead screen, never an infinite poll against a
          // nonexistent session.
          onResetRef.current?.();
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (body.status === "active") {
          nonceRef.current = body.verify_nonce ?? nonceRef.current;
          if (body.face_exempt === true) {
            setStatusBoth("exempt");
            return;
          }
          // Fire the re-verify BEFORE clearing the overlay (a failing
          // re-verify re-pauses/re-flags — E7 pins this).
          setStatusBoth("recovering");
          const outcome = await postVerifyInternal(
            await captureOrNull(),
            "periodic",
            nonceRef.current,
            false,
            true, // fromFlaggedPoll — a stale nonce must re-poll, not clear the overlay
          );
          if (outcome === "ready") {
            setStatusBoth("ready");
            scheduleCadence();
            return;
          }
          if (outcome === "paused") {
            // The unlock re-verify failed (mismatch) → paused: the blink
            // recovery path owns it from here.
            setStatusBoth("paused");
            return;
          }
          // Network error (null) / re-flagged / unavailable: cadence cannot
          // pick this up (`shouldScheduleFaceCheck` excludes `recovering`),
          // so restore the flagged overlay and KEEP the poll alive — the
          // student must never be stranded behind a non-interactive overlay.
          setStatusBoth("flagged");
          if (!disposedRef.current && !isTerminalRef.current) {
            pollTimerRef.current = setTimeout(() => void tick(), FLAGGED_POLL_MS);
          }
          return;
        }
        if (body.status === "completed") {
          onPhaseChangeRef.current("submitted");
          return;
        }
        // Unknown/gone (non-404, no status): fail-closed terminal rather than
        // re-arming a poll for a session that no longer exists.
        if (body.status === undefined && !res.ok) {
          onResetRef.current?.();
          return;
        }
      } catch {
        // network — keep polling
      }
      if (!disposedRef.current && !isTerminalRef.current) {
        pollTimerRef.current = setTimeout(() => void tick(), FLAGGED_POLL_MS);
      }
    };
    void tick();
  }

  async function captureOrNull(): Promise<string | null> {
    const tracker = trackerRef.current;
    if (!tracker) return null;
    return tracker.captureFrame();
  }

  // Record a mid-session camera/face outage to the server ONCE per session
  // (`report_face_unavailable` is set-if-null — the route stays idempotent;
  // the boot path in play-client also reports). Without this, a verify-5xx
  // degradation to `unavailable` would be invisible to the lecturer.
  const unavailableReportedRef = useRef(false);
  function reportUnavailableOnce() {
    if (unavailableReportedRef.current) return;
    unavailableReportedRef.current = true;
    void fetch(`/api/sessions/${sessionId}/face-unavailable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => {
      // network — a later report still records it
    });
  }

  // ── Cadence (30–45s jittered, clear-then-set) ──────────────────
  function scheduleCadence() {
    if (cadenceTimerRef.current) {
      clearTimeout(cadenceTimerRef.current);
      cadenceTimerRef.current = null;
    }
    if (disposedRef.current || hiddenRef.current || isTerminalRef.current) return;
    // E2E seam: `setFacePeriodic({minMs,maxMs})` overrides the bounds at
    // construction (keeps `cadence.ts` pure/env-free; makes E12 deterministic).
    const periodic = process.env.NODE_ENV === "production" ? undefined : getFakePeriodicOverride();
    const cadence = new PeriodicCadence({
      minMs: periodic?.minMs ?? PERIODIC_MIN_MS,
      maxMs: periodic?.maxMs ?? PERIODIC_MAX_MS,
    });
    const delay = cadence.nextDelayMs();
    cadenceTimerRef.current = setTimeout(() => {
      cadenceTimerRef.current = null;
      if (!disposedRef.current && !hiddenRef.current && !isTerminalRef.current) {
        void runVerify("periodic");
      }
    }, delay);
  }

  // ── Verify POST core ────────────────────────────────────────────
  /**
   * POST a verify. `allowNonceRetry` controls whether a `nonce_mismatch`
   * triggers a GET-refresh + one retry (default true). Returns the resolved
   * FaceStatus or null when the pipeline shouldn't change state.
   */
  async function postVerifyInternal(
    frame: string | null,
    trigger: "start" | "question" | "periodic",
    nonce: string,
    allowNonceRetry: boolean,
    fromFlaggedPoll = false,
  ): Promise<FaceStatus | null> {
    if (disposedRef.current || isTerminalRef.current) return null;
    // CompreFace migration: an empty sentinel frame → the route calls CompreFace
    // which returns no subject → the RPC computes matched=false → fail row.
    const payloadFrame = frame ?? "";
    let res: Response;
    try {
      res = await fetch(`/api/face/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ frame: payloadFrame, trigger, nonce, sessionId }),
      });
    } catch {
      // Network error — re-schedule cadence (bounded retry, no hot-loop).
      if (trigger === "start") setStatusBoth("gate");
      else scheduleCadence();
      return null;
    }
    let body: Record<string, unknown> = {};
    if (res.ok || res.status === 409 || res.status === 403 || res.status === 400 || res.status === 503) {
      body = await res.json().catch(() => ({}));
    }

    // A 4xx/5xx verify is NEVER a clean pass — without this, an unparsed body
    // would fall through `resolveVerifyOutcome({})` to the `default` branch
    // and silently map to `ready` (a pass with no recorded row):
    //  400  → a rejected/invalid frame (camera could not produce a usable
    //         frame) → fail signal (`paused`), integrity-conservative.
    //  5xx  (503 CompreFace down / 504 platform timeout / 500) → fail-open
    //        `unavailable` (lecturer-visible via face_unavailable_at) — the
    //        documented L14 contract, NOT a pass.
    if (res.status === 400) {
      setStatusBoth("paused");
      return "paused";
    }
    if (res.status >= 500) {
      setStatusBoth("unavailable");
      reportUnavailableOnce();
      return "unavailable";
    }

    // 404 — D13: a lecturer reset the session mid-flight (or it is otherwise
    // gone). The student's screen must surface a TERMINAL dead screen (via
    // onReset → PlayClient's dead branch), never a verify/retry loop against
    // a session that no longer exists. `onReset` runs FIRST so the dead
    // screen replaces the current overlay without flashing the unavailable
    // overlay for a frame.
    if (res.status === 404) {
      onResetRef.current?.();
      setStatusBoth("unavailable");
      return "unavailable";
    }

    // nonce_mismatch → refetch via GET, write nonceRef, retry ONCE. The retry
    // recurses with allowNonceRetry=false, so the flagged-poll guard below runs
    // on THAT call (retry exhausted → never surfaced as a clean pass).
    if (body.error === "nonce_mismatch" && allowNonceRetry && !nonceRetriedRef.current) {
      nonceRetriedRef.current = true;
      try {
        const getRes = await fetch(`/api/sessions/${sessionId}`, { method: "GET" });
        const getBody = await getRes.json().catch(() => ({}));
        if (typeof getBody.verify_nonce === "string") {
          nonceRef.current = getBody.verify_nonce;
        }
      } catch {
        // fall through to surface state
      }
      const retried = await postVerifyInternal(payloadFrame, trigger, nonceRef.current, false, fromFlaggedPoll);
      nonceRetriedRef.current = false;
      return retried;
    }
    nonceRetriedRef.current = false;

    // Flagged-poll context — a stale nonce is NOT surfaced as a clean pass
    // (`resolveVerifyOutcome` maps nonce_mismatch → ready, which would let a
    // GET/POST race clear the flagged overlay without a server-verified match).
    // Return `flagged` to re-arm the poll. (This must run OUTSIDE the retry
    // block: the recursive retry call has allowNonceRetry=false, so this guard
    // is only reachable when the retry is exhausted or was never attempted.)
    if (body.error === "nonce_mismatch" && !allowNonceRetry && fromFlaggedPoll) {
      return "flagged";
    }

    // 409 `session_not_active` → the session moved server-side (hand-loss
    // pause, lecturer flag, or submit). Mirror the REAL status like the answer
    // path (PLAN_PHASE7 §2) instead of dead-ending a live quiz:
    //  - paused    → 'paused' (blink-recoverable)
    //  - flagged   → 'flagged' + poll (lecturer decision)
    //  - completed → dead (terminal)
    if (res.status === 409 && body.error === "session_not_active") {
      let realStatus: string | undefined;
      try {
        const statusRes = await fetch(`/api/sessions/${sessionId}`, { method: "GET" });
        realStatus = (await statusRes.json().catch(() => ({}))).status;
      } catch {
        // network — fall through to the conservative branch below
      }
      if (realStatus === "paused") {
        setStatusBoth("paused");
        return "paused";
      }
      if (realStatus === "flagged") {
        setStatusBoth("flagged");
        startFlaggedPoll();
        return "flagged";
      }
      if (realStatus === "completed") {
        setStatusBoth("unavailable");
        onPhaseChangeRef.current("dead");
        return "unavailable";
      }
      // Unknown/gone → fail-closed (never a pass).
      setStatusBoth("unavailable");
      return "unavailable";
    }

    const outcome = resolveVerifyOutcome(body as never);

    if (outcome.next === "gate") {
      setStatusBoth("gate");
      return "gate";
    }
    if (outcome.next === "flagged") {
      setStatusBoth("flagged");
      startFlaggedPoll();
      return "flagged";
    }
    if (outcome.next === "unavailable") {
      setStatusBoth("unavailable");
      if ("surfaceEnd" in outcome && outcome.surfaceEnd) {
        onPhaseChangeRef.current("dead");
      }
      return "unavailable";
    }
    if (outcome.next === "paused") {
      setStatusBoth("paused");
      return "paused";
    }
    if ("retryNonce" in outcome && outcome.retryNonce) {
      nonceRef.current = outcome.retryNonce;
    }
    if (outcome.next === "ready") {
      if (trigger === "start") hadStartVerifyRef.current = true;
      setStatusBoth("ready");
      scheduleCadence();
      return "ready";
    }
    // nonce_mismatch surfaced (retry exhausted) — stay ready, cadence re-checks.
    if ("surfaceError" in outcome && outcome.surfaceError === "nonce_mismatch") {
      scheduleCadence();
    }
    return null;
  }

  // ── Verify core ────────────────────────────────────────────────
  async function runVerify(trigger: "start" | "question" | "periodic") {
    if (isTerminalRef.current) return;
    if (verifyLock.current) {
      // A verify is in flight — defer the new one (latest-wins), fired exactly
      // once after the lock releases (never silently dropped).
      pendingVerifyRef.current = trigger;
      return;
    }
    const tracker = trackerRef.current;
    if (!tracker) return;

    const s = statusRef.current;
    const phaseNow = questionVisibleRef.current ? "question" : "feedback";
    if (!shouldScheduleFaceCheck(s, phaseNow) && trigger !== "start") return;
    if (faceExemptRef.current) {
      setStatusBoth("exempt");
      return;
    }
    if (!enrolledRef.current || !consentGivenRef.current) {
      setStatusBoth("gate");
      return;
    }

    verifyLock.current = true;
    // Capture the current question id for the fire-time re-check.
    const questionIdAtStart = lastQuestionIdRef.current;
    try {
      // If the student is actively holding a hand gesture (answering/next),
      // wait briefly for the gesture to complete and hand to lower.
      if (isHandActiveRef.current) {
        const handWaitStart = Date.now();
        while (isHandActiveRef.current && Date.now() - handWaitStart < 1200 && !disposedRef.current) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (disposedRef.current) return;

      let frame: string | null = null;
      if (typeof tracker.captureBestFrame === "function") {
        frame = await tracker.captureBestFrame({ maxWaitMs: 1500, requireCentered: true, requireOpenEyes: true });
      } else {
        frame = await tracker.captureFrame();
        const startPoll = Date.now();
        while (!frame && Date.now() - startPoll < 800 && !disposedRef.current) {
          await new Promise((r) => setTimeout(r, 100));
          frame = await tracker.captureFrame();
        }
      }
      if (disposedRef.current) return;

      // If frame is still null, give one final brief fallback poll before sending empty sentinel
      if (!frame) {
        await new Promise((r) => setTimeout(r, 400));
        if (disposedRef.current) return;
        frame = await tracker.captureFrame();
      }

      // Persistent camera-null mid-quiz: indistinguishable from a wrong face by
      // design — POST a sentinel empty frame → CompreFace returns no subject →
      // RPC computes matched=false → the null lands as a fail row in the FLAT
      // window (integrity-conservative; exempt recovery).
      await postVerifyInternal(frame, trigger, nonceRef.current, true);
    } finally {
      verifyLock.current = false;
      if (pendingVerifyRef.current && !disposedRef.current && !isTerminalRef.current) {
        const deferred = pendingVerifyRef.current;
        pendingVerifyRef.current = null;
        // Re-check the CURRENT displayed question + status at fire time.
        const qid = lastQuestionIdRef.current;
        if (
          qid === questionIdAtStart ||
          shouldScheduleFaceCheck(statusRef.current, questionVisibleRef.current ? "question" : "feedback")
        ) {
          void runVerify(deferred);
        }
      }
    }
  }

  // ── Blink recovery ─────────────────────────────────────────────
  async function runRecovery() {
    const tracker = trackerRef.current;
    if (!tracker || disposedRef.current || isTerminalRef.current) return;
    setStatusBoth("recovering");
    const blink = await tracker.waitForBlink(LIVENESS_TIMEOUT_MS);
    if (disposedRef.current || isTerminalRef.current) return;
    const step = recoverFlow(blink);
    if (step === "failed") {
      setStatusBoth("paused");
      return;
    }
    // Blink observed → POST self-recover.
    try {
      const res = await fetch(`/api/face/self-recover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.sessionStatus === "active") {
        nonceRef.current = body.nextNonce ?? nonceRef.current;
        setStatusBoth(recoveryLanding(hadStartVerifyRef.current));
        if (hadStartVerifyRef.current) scheduleCadence();
      } else if (body.error === "flagged") {
        setStatusBoth("flagged");
        startFlaggedPoll();
      } else {
        setStatusBoth("paused");
      }
    } catch {
      setStatusBoth("paused");
    }
  }

  // ── Hand-loss pause (server-side) ──────────────────────────────
  async function handLossPause() {
    onHandLossPauseRef.current();
    try {
      await fetch(`/api/sessions/${sessionId}/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch {
      // network — the client overlay still shows; cadence re-checks.
    }
    if (statusRef.current === "ready") {
      setStatusBoth("paused");
    }
  }

  // ── Tracker setter (called by the parent after boot) ───────────
  function setTracker(tracker: IFaceTracker | null) {
    trackerRef.current = tracker;
    // The assessment gate is EXPLICIT-Begin only (design: "the gate can only
    // be exited by Begin" — blink liveness + `'start'` verify run in
    // `beginGate`). An auto-run here would silently pass the gate when the
    // tracker boots before the student blinks (E13 pins: withholding liveness
    // must keep the student IN the gate). Reload-before-Begin re-renders the
    // gate via `hasFaceChecks` seeding — no auto-run needed.
  }

  // ── Lifecycle ──────────────────────────────────────────────────
  // The initial status is computed in the useState initializer. This effect
  // starts side-effect machinery (flagged poll / cadence / gate verify) and
  // tears it down on unmount AND on terminal phases.
  useEffect(() => {
    disposedRef.current = false;
    if (isTerminalRef.current) {
      if (cadenceTimerRef.current) clearTimeout(cadenceTimerRef.current);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pendingVerifyRef.current = null;
      return;
    }
    const s = statusRef.current;
    if (s === "flagged") {
      startFlaggedPoll();
    } else if (s === "ready") {
      scheduleCadence();
    }
    // NOTE: `gate` needs NO auto-run — the gate is explicit-Begin only
    // (blink liveness + `'start'` verify run in `beginGate`). An auto-run
    // here would silently pass the gate on tracker boot (E13 pins this).
    return () => {
      disposedRef.current = true;
      if (cadenceTimerRef.current) clearTimeout(cadenceTimerRef.current);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pendingVerifyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, quizMode]);

  // Terminal-phase teardown (submitted/dead). The `isTerminalRef` mirror runs
  // in the sync effect above; this effect clears the machinery when it flips.
  useEffect(() => {
    if (isTerminal) {
      if (cadenceTimerRef.current) clearTimeout(cadenceTimerRef.current);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pendingVerifyRef.current = null;
    }
  }, [isTerminal]);

  // Visibility handling: cadence paused hidden; catch-up verify on return.
  useEffect(() => {
    const onVis = () => {
      const hidden = document.hidden;
      hiddenRef.current = hidden;
      if (hidden) {
        if (cadenceTimerRef.current) {
          clearTimeout(cadenceTimerRef.current);
          cadenceTimerRef.current = null;
        }
      } else {
        // Catch-up: if ready, verify immediately (a long-hidden student
        // shouldn't wait a full cadence). Other statuses need no catch-up —
        // `gate` is explicit-Begin and paused/flagged have their own flows.
        if (statusRef.current === "ready" && !isTerminalRef.current) {
          void runVerify("periodic");
        }
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Q-transition trigger: the parent reports the CURRENT question id. When it
  // CHANGES (and is visible), fire a Q-transition verify after a settling delay
  // (1500ms) so the student has completed their gesture/click and is facing the camera.
  useEffect(() => {
    if (!questionVisible || questionId === null) return;
    const prev = lastQuestionIdRef.current;
    lastQuestionIdRef.current = questionId;
    if (prev === null) return; // first question — gate covered it
    if (prev === questionId) return; // same question re-render

    const timer = setTimeout(() => {
      if (statusRef.current === "ready" && !isTerminalRef.current && !disposedRef.current) {
        void runVerify("question");
      }
    }, 2000);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId, questionVisible]);

  // Gate Begin: run blink liveness, then the `'start'` verify (the authority).
  async function beginGate() {
    const tracker = trackerRef.current;
    if (!tracker || disposedRef.current || isTerminalRef.current) return;
    setStatusBoth("recovering");
    const blink = await tracker.waitForBlink(LIVENESS_TIMEOUT_MS);
    if (disposedRef.current || isTerminalRef.current) return;
    if (blink !== "passed") {
      setStatusBoth("gate");
      return;
    }
    // NOTE: `hadStartVerifyRef` is set ONLY by the `ready` branch in
    // `postVerifyInternal` (trigger === 'start'). Setting it here would let a
    // FAILED gate verify recover to `ready` via `recoveryLanding(true)` —
    // bypassing the gate's authority (the blink alone is not a verify).
    await runVerify("start");
  }

  function checkAgain() {
    startFlaggedPoll();
  }

  // Called by the consumer AFTER a successful consent POST from the gate: the
  // server's consent_given_at is now set, so the client-side `consentGivenRef`
  // gate must agree or a re-clicked Begin would never run the `'start'` verify
  // (the RPC's own consent gate would pass, but the local guard would block).
  function markConsentGiven() {
    consentGivenRef.current = true;
  }

  return {
    status,
    beginGate,
    checkAgain,
    runRecovery,
    handLossPause,
    setTracker,
    setStatusBoth,
    markConsentGiven,
  };
}

// ── E2E periodic override helper (pure read, non-prod only) ───────
// `FakeFaceControl.setFacePeriodic({minMs,maxMs})` stores the override the
// pipeline reads at cadence construction. Keeps `cadence.ts` pure/env-free.
function getFakePeriodicOverride(): { minMs: number; maxMs: number } | undefined {
  try {
    const periodic = getFakeFaceControl()?._periodic;
    if (
      periodic &&
      Number.isFinite(periodic.minMs) &&
      Number.isFinite(periodic.maxMs) &&
      periodic.maxMs >= periodic.minMs &&
      periodic.minMs >= 0
    ) {
      return periodic;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
