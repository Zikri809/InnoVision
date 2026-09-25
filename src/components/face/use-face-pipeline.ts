"use client";

import { useEffect, useRef, useState } from "react";
import type { IFaceTracker, FaceStatus } from "@/lib/face/types";
import type { TurnSide } from "@/lib/face/challenge";
import { randomTurnSide } from "@/lib/face/challenge";
import { PeriodicCadence, minClientVerifyGapMs, shouldScheduleFaceCheck } from "@/lib/face/cadence";
import { shouldDeferFaceCheck } from "@/lib/face/face-check-gate";
import { resolveVerifyOutcome } from "@/lib/face/outcome";
import { getFakeFaceControl } from "@/lib/face/fake-seam";
import { isFakeFaceSeamEnabled } from "@/lib/face/seam-gate";
import {
  FACE_TRACK_FRAME_INTERVAL_MS,
  FACE_TRACK_SLOW_INTERVAL_MS,
  FOCUS_BLUR_DEBOUNCE_MS,
  FLAGGED_POLL_MS,
  HEAD_TURN_TIMEOUT_MS,
  LIGHTING_RETRY_DELAY_MS,
  LIVENESS_TIMEOUT_MS,
  PERIODIC_MAX_MS,
  PERIODIC_MIN_MS,
  VERIFY_FRAMES_PER_CHECK,
  VERIFY_FRAME_SPACING_MS,
  VERIFY_SECONDARY_CAPTURE_TIMEOUT_MS,
  VERIFY_TRANSPORT_FAIL_LIMIT,
} from "@/lib/face/constants";
import { FULLSCREEN_PAUSE_DEDUPE_MS } from "@/lib/integrity/use-fullscreen-guard";

/**
 * Client-side floor between verify POSTs (latest-wins deferral): 8 s in
 * production, so Q-transition + periodic + catch-up bursts (30 POSTs/min at
 * the raw 2 s advisory mirror) never spend the route's 10/min budget into a
 * bricking 429. The E2E fake seam relaxes to the 2 s mirror so specs driving
 * fast cadences (`setFacePeriodic({2500,3500})`) keep their POST timing.
 * (Pure computation lives in cadence.ts — see `minClientVerifyGapMs`.)
 */
const MIN_CLIENT_VERIFY_GAP_MS = minClientVerifyGapMs(isFakeFaceSeamEnabled());

/**
 * Bounded deferrals before a precheck-gated check proceeds unconditionally.
 * Exhaustion is intentional: the capture happens anyway and the SERVER judges
 * the real frame — sustained occlusion must surface as an honest FAIL row
 * (pause → blink recovery), never an invisible defer loop. Also the retry
 * count handed to min-gap-deferred runs so they re-enter the precheck fresh.
 */
const FACE_CHECK_DEFER_MAX = 2;

export type FacePipelinePhase =
  | "question"
  | "locked"
  | "feedback"
  | "submitting"
  | "submitted"
  | "timeUp"
  | "dead";

/**
 * Why the session is currently paused — the overlay copy differs (a
 * focus-loss pause means "you left the exam window", a fullscreen-exit
 * pause means "fullscreen was closed"; neither is a face problem), and it
 * clears on any non-paused status.
 */
export type PausedReason = "face" | "focus_lost" | "fullscreen_exit" | "hand_lost";

export type FacePipelineProps = {
  sessionId: string;
  quizMode: "practice" | "assessment";
  enrolled: boolean;
  consentGiven: boolean;
  faceExempt: boolean;
  /** Lecturer-controlled quiz toggle, authoritative metadata frozen at live. */
  faceEnforcementEnabled?: boolean;
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
  /**
   * Integrity hardening (fullscreen guard): a shared "a pause POST was sent
   * at this ms" stamp. The fullscreen-exit pause and the debounced blur pause
   * fire from the SAME app switch — without the shared window both POST and
   * focus_lost would double-count focus_pause_count (3-strike flag after 2
   * app switches instead of 3) and flush incident footage twice. The blur
   * path checks-and-stamps it; play-client's fullscreen handler stamps it.
   */
  sharedPauseStampRef?: React.RefObject<number>;
  /** D13 — a lecturer reset the session mid-flight (verify → 404 no longer owned). */
  onReset?: () => void;
  /**
   * 0045 §5 (audit-1 §2.13) + 0048 D-F2: the server's own remaining exam time
   * after the session moved — a self-recovery (credited-seconds arithmetic) or
   * a lecturer unlock / cross-tab recovery observed by the flagged poll and
   * the stale-nonce GET. PlayClient adopts it so the countdown reflects the
   * capped credit instead of freezing through the whole pause — the drift
   * that surfaced as a mid-answer `time_expired` 403. Fired only on a
   * server-confirmed active session, only for timed quizzes (number, not
   * null).
   */
  onRecoveredRemaining?: (remainingMs: number) => void;
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
 *  - Focus-loss pause: a DEBOUNCED window blur while visible POSTs pause
 *    with `reason:'focus_lost'`; the RPC escalates to flagged at the 3rd
 *    confirmed loss (focus_pause_count). Recovery reuses the blink flow —
 *    clicking Recover refocuses the exam window.
 *  - Tab-hide: cadence paused hidden; catch-up verify on return.
  *  - Multi-frame verify: each check captures up to 3 frames ~500ms apart;
   *    the server records ONE row decided by strict majority (a transient
   *    blur/glance fails one frame, not the check). A bounded precheck
   *    (lighting / mid-commit hand / unaligned-or-absent face) defers checks
   *    that would photograph a known-bad moment; on exhaustion it captures
   *    anyway — the server judges the real frame.
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
    faceEnforcementEnabled = true,
    initialNonce,
    initialFaceStatus,
    questionId,
    questionVisible,
    phase,
    onHandLossPause,
    onPhaseChange,
    onFaceStatus,
    isHandActive = false,
    sharedPauseStampRef,
    onReset,
    onRecoveredRemaining,
  } = props;

  const [status, setStatus] = useState<FaceStatus>(() => {
    if (quizMode !== "assessment") return "off";
    if (!faceEnforcementEnabled) return "off";
    if (faceExempt) return "exempt";
    if (initialFaceStatus === "flagged" || initialFaceStatus === "paused") {
      return initialFaceStatus;
    }
    if (!enrolled || !consentGiven) return "gate";
    return initialFaceStatus === "ready" ? "ready" : "gate";
  });
  const [pausedReason, setPausedReason] = useState<PausedReason>("face");
  /**
   * The anti-replay head-turn challenge's required direction while a blink
   * liveness wait is active (gate/recovering) — the overlays render "turn
   * your head LEFT/RIGHT" from it. Null = no challenge running (or the
   * tracker lacks `waitForHeadTurn` — feature-detected, auto-pass).
   */
  const [challengeSide, setChallengeSide] = useState<TurnSide | null>(null);
  /**
   * True after a turn-challenge FAILURE at the gate — flips the gate's
   * liveness card from the idle copy to the failed/retry copy so a student
   * who cannot produce the turn isn't soft-locked behind silent silence
   * (Begin re-offers the full liveness; the lecturer exemption remains the
   * escape hatch for a camera that genuinely can't see a turn).
   */
  const [challengeFailed, setChallengeFailed] = useState(false);
  /**
   * What failed on the LAST gate attempt — drives the gate's liveness-card
   * copy. Without it a blink timeout (or a transport-failed `'start'` verify)
   * lands back on the idle card with no error text: an 8s scan that appears
   * to do nothing, retried blind. Reset at the top of every beginGate.
   */
  const [gateAttempt, setGateAttempt] = useState<"idle" | "blink_failed" | "verify_failed">(
    "idle",
  );

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
  const onRecoveredRemainingRef = useRef(onRecoveredRemaining);

  const nonceRef = useRef(initialNonce);
  const verifyLock = useRef(false);
  const answerPriorityRef = useRef(false);
  // Client-side POST pacing: rapid triggers (fast Q-transitions + periodic +
  // catch-up) must not spend the route's 10/min budget into 429s.
  const lastVerifyPostAtRef = useRef(0);
  const minGapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deferredTriggerRef = useRef<"start" | "question" | "periodic" | null>(null);
  // One bounded precheck deferral per check (lighting/occlusion/hand — never
  // an infinite loop); tracked so lifecycle cleanup can cancel it.
  const lightingRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Focus-loss machinery: debounce timer + the listener teardown.
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `pendingVerifyRef` stores the deferred TRIGGER (latest-wins).
  const pendingVerifyRef = useRef<"start" | "question" | "periodic" | null>(null);
  const nonceRetriedRef = useRef(false);
  // Consecutive verify TRANSPORT failures (fetch throw) — reset on any
  // successful POST; at VERIFY_TRANSPORT_FAIL_LIMIT the pipeline degrades to
  // `unavailable` (verify-silence backstop, see the catch in postVerifyInternal).
  const transportFailStreakRef = useRef(0);
  // Consecutive 429s (limiter rejections) — the same silence-backstop shape:
  // N in a row means the client is producing no face_checks rows while the
  // limiter stays saturated, so the honest degradation (outage claim) must
  // fire before the verify-silence cron flags on silence. Reset on any
  // non-429 response (see postVerifyInternal's transport-recovered line).
  const transport429StreakRef = useRef(0);
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
    onRecoveredRemainingRef.current = onRecoveredRemaining;
    isTerminalRef.current = isTerminal;
  });

  function setStatusBoth(s: FaceStatus) {
    statusRef.current = s;
    setStatus(s);
    onFaceStatusRef.current(s);
    // Adaptive duty cycle: sustained play only needs pose health/advisories
    // (multi-second scale) — slow the tracker to free CPU for the gesture
    // landmarker. Every liveness-critical state (gate, recovering — both run
    // waitForBlink AFTER this call in beginGate/runRecovery) restores FULL
    // first, so blink sampling is never throttled. Feature-detected: the E2E
    // fake and legacy trackers simply keep the full rate.
    trackerRef.current?.setFrameInterval?.(
      s === "ready" ? FACE_TRACK_SLOW_INTERVAL_MS : FACE_TRACK_FRAME_INTERVAL_MS,
    );
    // The paused overlay copy tracks WHY the student is paused; any
    // non-paused status resets the default (face) reason.
    if (s !== "paused" && s !== "recovering") setPausedReason("face");
  }

  // ── Flagged poll (8s; survives timeUp while flagged) ───────────
  function startFlaggedPoll() {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    const tick = async () => {
      if (disposedRef.current || isTerminalRef.current) return;
      try {
        const res = await fetch(`/api/sessions/${sessionId}`, { method: "GET", cache: "no-store" });
        if (res.status === 404) {
          // D13 — the flagged session was RESET by a lecturer (the row is
          // gone). Terminal dead screen, never an infinite poll against a
          // nonexistent session.
          onResetRef.current?.();
          return;
        }
        const body = await res.json().catch(() => ({}));
        // StrictMode/effect-rerun guard: a superseded poll chain must not
        // resume its POST work after a newer chain took over the timer.
        if (disposedRef.current || isTerminalRef.current) return;
        if (body.status === "active") {
          nonceRef.current = body.verify_nonce ?? nonceRef.current;
          // D-F2: the lecturer unlocked the session (or another tab already
          // recovered it). The GET envelope carries the server's own
          // remainingMs for an active timed session; adopt it so the
          // countdown re-syncs instead of resuming from the frozen pre-pause
          // reading (mirrors the self-recover adoption in runRecovery).
          if (typeof body.remainingMs === "number" && body.remainingMs >= 0) {
            onRecoveredRemainingRef.current?.(body.remainingMs);
          }
          if (body.face_exempt === true) {
            setStatusBoth("exempt");
            return;
          }
          // Fire the re-verify BEFORE clearing the overlay (a failing
          // re-verify re-pauses/re-flags — E7 pins this). A hidden tab must
          // not capture: the frame would be null and the sentinel would land
          // a FAIL row for a lecturer unlock that happened while the student
          // was backgrounded — stay `flagged` and let the poll re-check
          // when the tab is visible again.
          if (hiddenRef.current) {
            setStatusBoth("flagged");
            pollTimerRef.current = setTimeout(() => void tick(), FLAGGED_POLL_MS);
            return;
          }
          // A runVerify capture may be in flight (a Q-transition or catch-up
          // verify that started before the unlock). Two concurrent POSTs with
          // the same nonce guarantee a nonce_mismatch for one and can re-pause
          // the student with a stale pre-unlock frame set — skip this tick
          // and let the poll re-check; the in-flight run's own outcome
          // machinery handles the session's new state (409 mirror).
          if (verifyLock.current) {
            setStatusBoth("flagged");
            pollTimerRef.current = setTimeout(() => void tick(), FLAGGED_POLL_MS);
            return;
          }
          setStatusBoth("recovering");
          const pollFrame = await captureOrNull();
          const outcome = await postVerifyInternal(
            [pollFrame ?? ""],
            "periodic",
            nonceRef.current,
            false,
            true, // fromFlaggedPoll — a stale nonce must re-poll, not clear the overlay
          );
          if (disposedRef.current || isTerminalRef.current) return;
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
        if (body.status === "paused") {
          // The lecturer (or the flagged-poll 409 path) PAUSED the flagged
          // session — this state has its own interactive flow (blink
          // recovery), so keep the student on the paused overlay instead of
          // the "waiting for lecturer decision" copy that has no action.
          nonceRef.current = body.verify_nonce ?? nonceRef.current;
          if (typeof body.remainingMs === "number" && body.remainingMs >= 0) {
            onRecoveredRemainingRef.current?.(body.remainingMs);
          }
          setStatusBoth("paused");
          return;
        }
        // Non-404, no status: this is NOT proof the session is gone. The GET
        // route deliberately returns 503 for a TRANSIENT DB fault and 429 from
        // its limiter, both with no `status` field — treating those as terminal
        // threw a student on a live flagged session to the dead screen on a
        // single 8-second poll tick (and, now that `dead` is terminal for the
        // countdown and handleTimeUp, with no way back or to submit). Only the
        // explicit 404 above is definitive; anything else re-arms the poll
        // (adversarial review).
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

  /**
   * Secondary vote frame: a plain capture polled briefly. Returns null when
   * no frame is available in the window — the caller OMITS the vote rather
   * than counting a fail (capture flakiness ≠ cheating).
   */
  async function captureSecondary(tracker: IFaceTracker): Promise<string | null> {
    const start = Date.now();
    let frame = await tracker.captureFrame();
    // A hidden tab cannot produce a real frame (the detect loop pauses), so
    // stop polling once hidden — the caller omits the vote rather than
    // burning the whole secondary timeout on guaranteed-null captures.
    while (!frame && Date.now() - start < VERIFY_SECONDARY_CAPTURE_TIMEOUT_MS && !disposedRef.current && !hiddenRef.current) {
      await new Promise((r) => setTimeout(r, 100));
      frame = await tracker.captureFrame();
    }
    return frame;
  }

  // Record a mid-session camera/face outage to the server. 0045 P0-3: the
  // stamp is RE-ARMABLE — report_face_unavailable refreshes it at most once
  // per 5-minute window and the silence cron stops trusting it after 10, so
  // the FIRST degradation reports immediately and every further degradation
  // re-arms (time-guarded below; the RPC collapses the retry storm and
  // re-keys the lecturer notice hourly). Without the re-arms a sustained
  // honest outage would expire from its own exemption and get
  // silence-flagged — the client keeps the claim fresh while it lives.
  const lastUnavailableReportAtRef = useRef(0);
  const UNAVAILABLE_REARM_MS = 6 * 60 * 1000;
  // audit-3 E-F5: bounded self-heal retry out of `unavailable`.
  const unavailableRetryAttemptsRef = useRef(0);
  const UNAVAILABLE_RETRY_MAX_ATTEMPTS = 5;
  const UNAVAILABLE_RETRY_BASE_MS = 30 * 1000;
  // audit-5 M5: after the bounded self-heal budget exhausts, a SUSTAINED
  // outage must still corroborate the outage claim or the silence cron
  // false-flags the honest student. The cron's exemption requires a fresh
  // `face_unavailable_at` AND corroboration (a recent face_checks row OR a
  // recent `face_verify_attempted_at` stamp — 0047:539-553). The client keeps
  // re-arming the claim every 6 min, but once probes stop NOTHING stamps the
  // attempt column, so ~10 min later corroboration expires and the next
  // answering student is flagged. The heartbeat keeps ONE probe per interval
  // while the outage lasts: during a genuine outage the route 503s and stamps
  // the column (the honest evidence); if the sidecar recovered, the probe
  // returns a real verdict and the status leaves `unavailable` (which clears
  // this timer). Interval < the SQL 10-min corroboration bound with room for
  // one dropped beat.
  const UNAVAILABLE_HEARTBEAT_MS = 5 * 60 * 1000;
  function clearUnavailableRetry() {
    if (unavailableRetryTimerRef.current) {
      clearTimeout(unavailableRetryTimerRef.current);
      unavailableRetryTimerRef.current = null;
    }
    if (unavailableHeartbeatTimerRef.current) {
      clearTimeout(unavailableHeartbeatTimerRef.current);
      unavailableHeartbeatTimerRef.current = null;
    }
  }
   /**
    * Probe the verify path once while `unavailable`, with linear backoff.
    * `force` bypasses runVerify's shouldScheduleFaceCheck gate (which requires
    * `ready`) but keeps every other guard, and the outcome machinery moves the
    * status off `unavailable` on success — which clears this timer via the
    * effect above. A genuine outage exhausts the budget and hands over to the
    * slow corroboration heartbeat (audit-5 M5) — the degraded banner + the
    * 6-min claim re-arm keep doing their job in the meantime.
    *
    * A probe that was DEFERRED by the bounded precheck (bad lighting /
    * occlusion) must not consume an attempt: the deferral re-enters
    * runVerify from lightingRetryTimerRef with the probe's `force` intent
    * dropped, sees `statusRef !== 'ready'`, and silently drops — five of
    * those would exhaust the budget for an honest student who is merely
    * off-center. The precheck deferral arms `lightingRetryTimerRef`, so a
    * pending deferral marks the attempt as NOT spent (the retry budget is
    * for real failures, not for desk framing).
    */
  function scheduleUnavailableRetry() {
    if (unavailableRetryAttemptsRef.current >= UNAVAILABLE_RETRY_MAX_ATTEMPTS) {
      // Budget exhausted — a sustained outage. Keep corroborating slowly.
      scheduleUnavailableHeartbeat();
      return;
    }
    if (unavailableRetryTimerRef.current) return;
    const attempt = unavailableRetryAttemptsRef.current;
    unavailableRetryTimerRef.current = setTimeout(() => {
      unavailableRetryTimerRef.current = null;
      if (
        disposedRef.current ||
        isTerminalRef.current ||
        statusRef.current !== "unavailable"
      ) {
        return;
      }
      // audit-3 adversarial review: a hidden tab must not run a capture. The
      // normal cadence path checks hiddenRef, and without the same check the
      // probe would capture nothing, post the no-face sentinel as a FAIL vote,
      // and could flag an honest student whose tab was merely backgrounded when
      // the sidecar recovered. Defer WITHOUT consuming an attempt — the retry
      // budget is for real failures, not for a backgrounded tab.
      if (hiddenRef.current) {
        scheduleUnavailableRetry();
        return;
      }
      unavailableRetryAttemptsRef.current = attempt + 1;
      void runVerify("periodic", 0, true).finally(() => {
        if (statusRef.current === "unavailable") {
          // A precheck DEFERRAL re-armed lightingRetryTimerRef and will drop
          // the retry (it re-checks `ready`) — refund the attempt so ~20s of
          // bad desk framing cannot exhaust the self-heal budget.
          if (lightingRetryTimerRef.current !== null) {
            unavailableRetryAttemptsRef.current = attempt;
          }
          scheduleUnavailableRetry();
        }
      });
    }, UNAVAILABLE_RETRY_BASE_MS * (attempt + 1));
  }

  /**
   * audit-5 M5: the sustained-outage corroboration heartbeat. One forced probe
   * per UNAVAILABLE_HEARTBEAT_MS while the status stays `unavailable`, so the
   * route keeps stamping `face_verify_attempted_at` (503 path) and the silence
   * cron's fresh+corroborated exemption holds for the whole honest outage.
   * Unlike the bounded self-heal budget, this does not consume attempts — it
   * is a liveness signal, not a recovery loop — and it defers (never fires) on
   * a hidden tab or a terminal state. Any status change clears it via the
   * effect below; a successful probe leaves `unavailable`, which is exactly
   * that status change.
   */
  function scheduleUnavailableHeartbeat() {
    if (unavailableHeartbeatTimerRef.current) return;
    unavailableHeartbeatTimerRef.current = setTimeout(() => {
      unavailableHeartbeatTimerRef.current = null;
      if (
        disposedRef.current ||
        isTerminalRef.current ||
        statusRef.current !== "unavailable"
      ) {
        return;
      }
      if (hiddenRef.current) {
        // A hidden tab cannot produce a frame; re-arm without probing (same
        // fabrication guard as the bounded retry).
        scheduleUnavailableHeartbeat();
        return;
      }
      void runVerify("periodic", 0, true).finally(() => {
        if (statusRef.current === "unavailable") scheduleUnavailableHeartbeat();
      });
    }, UNAVAILABLE_HEARTBEAT_MS);
  }
  function reportUnavailable() {
    const now = Date.now();
    if (now - lastUnavailableReportAtRef.current < UNAVAILABLE_REARM_MS) return;
    lastUnavailableReportAtRef.current = now;
    void fetch(`/api/sessions/${sessionId}/face-unavailable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => {
      // network — a later report still records it
    });
  }

  // 0045 P0-3 client arm: while the pipeline sits in `unavailable`, the
  // verify cadence is SUSPENDED (shouldScheduleFaceCheck requires 'ready'),
  // so degradations alone cannot keep the claim fresh. A dedicated re-arm
  // timer posts the report every 6 min (interval > the RPC's 5-min refresh
  // window, < the cron's 10-min staleness bound) for as long as the outage
  // lasts; any status change clears it. The 6-min guard inside
  // reportUnavailable keeps an immediate report + the first tick idempotent.
  //
  // audit-3 E-F5: `unavailable` used to be ONE-WAY for the whole page-load —
  // nothing left it automatically (every re-entry path requires
  // statusRef==='ready'), so a single sidecar 5xx/restart ended proctoring
  // for the rest of the attempt and the silence cron then flagged an honest
  // student. The same timer now also RETRIES the verify with a bounded,
  // backed-off schedule: a transient outage self-heals back to `ready`, and a
  // genuine one stops after UNAVAILABLE_RETRY_MAX_ATTEMPTS so the client
  // cannot hot-loop the sidecar. A reload already re-seeds `ready`
  // (play/[sessionId]/page.tsx), so this only closes the in-page gap.
  const unavailableRearmTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unavailableRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unavailableHeartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (status === "unavailable" && !disposedRef.current && !isTerminalRef.current) {
      if (unavailableRearmTimerRef.current) return;
      unavailableRearmTimerRef.current = setInterval(() => {
        if (!disposedRef.current && !isTerminalRef.current && statusRef.current === "unavailable") {
          reportUnavailable();
        }
      }, UNAVAILABLE_REARM_MS);
      scheduleUnavailableRetry();
    } else {
      if (unavailableRearmTimerRef.current) {
        clearInterval(unavailableRearmTimerRef.current);
        unavailableRearmTimerRef.current = null;
      }
      clearUnavailableRetry();
      // Any status change resets the retry budget: a fresh outage later in
      // the same attempt gets its own bounded retries.
      unavailableRetryAttemptsRef.current = 0;
    }
    return () => {
      if (unavailableRearmTimerRef.current) {
        clearInterval(unavailableRearmTimerRef.current);
        unavailableRearmTimerRef.current = null;
      }
      clearUnavailableRetry();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // ── Cadence (30–45s jittered, clear-then-set) ──────────────────
  function scheduleCadence() {
    if (cadenceTimerRef.current) {
      clearTimeout(cadenceTimerRef.current);
      cadenceTimerRef.current = null;
    }
    if (disposedRef.current || hiddenRef.current || isTerminalRef.current) return;
    // E2E seam: `setFacePeriodic({minMs,maxMs})` overrides the bounds at
    // construction (keeps `cadence.ts` pure/env-free; makes E12 deterministic).
    const periodic = isFakeFaceSeamEnabled() ? getFakePeriodicOverride() : undefined;
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
    frames: string[],
    trigger: "start" | "question" | "periodic",
    nonce: string,
    allowNonceRetry: boolean,
    fromFlaggedPoll = false,
  ): Promise<FaceStatus | null> {
    if (disposedRef.current || isTerminalRef.current) return null;
    // CompreFace migration: empty sentinel frames → the route counts them as
    // FAIL votes; the RPC computes matched from the strict majority.
    const payloadFrames = frames.length > 0 ? frames.slice(0, VERIFY_FRAMES_PER_CHECK) : [""];
    let res: Response;
    // Async POST path — never called during render.
    // eslint-disable-next-line react-hooks/purity
    lastVerifyPostAtRef.current = Date.now();
    try {
      res = await fetch(`/api/face/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ frames: payloadFrames, trigger, nonce, sessionId }),
      });
    } catch {
      // Network error — re-schedule cadence (bounded retry, no hot-loop).
      // Only while ready: a flagged-poll caller ('recovering') must not arm
      // cadence outside the ready invariant.
      //
      // Silence-backstop (VERIFY_TRANSPORT_FAIL_LIMIT): sustained transport
      // failures record NO face_checks rows while answers (tiny bodies) keep
      // flowing — the verify-silence cron (0042) would flag that student
      // ~300s in. After N consecutive transport failures, degrade honestly
      // to `unavailable` + reportUnavailable() — the same self-exempting,
      // lecturer-visible path as an HTTP ≥500 outage (L14 parity).
      transportFailStreakRef.current += 1;
      if (
        trigger !== "start" &&
        transportFailStreakRef.current >= VERIFY_TRANSPORT_FAIL_LIMIT &&
        statusRef.current === "ready"
      ) {
        transportFailStreakRef.current = 0;
        setStatusBoth("unavailable");
        reportUnavailable();
        return "unavailable";
      }
      if (trigger === "start") setStatusBoth("gate");
      else if (statusRef.current === "ready") scheduleCadence();
      return null;
    }
    // The request REACHED the server (any HTTP status) — transport recovered;
    // a 429, for instance, still means connectivity is intact.
    transportFailStreakRef.current = 0;
    if (res.status !== 429) transport429StreakRef.current = 0;
    let body: Record<string, unknown> = {};
    if (res.ok || res.status === 409 || res.status === 403 || res.status === 400 || res.status === 503 || res.status === 413) {
      body = await res.json().catch(() => ({}));
    }

    // A 4xx/5xx verify is NEVER a clean pass — without this, an unparsed body
    // would fall through `resolveVerifyOutcome({})` to the `default` branch
    // and silently map to `ready` (a pass with no recorded row):
    //  400/413 → a rejected/invalid/oversized frame (the camera produced a
    //         frame the route refuses) → fail signal (`paused`),
    //         integrity-conservative. 413 joining 400: an honest tracker
    //         hovering at the cap must not masquerade as a sidecar outage
    //         (unavailable) — a frame problem is a capture problem.
    //  5xx  (503 sidecar down / 504 platform timeout / 500) → fail-open
    //        `unavailable` (lecturer-visible via face_unavailable_at) — the
    //        documented L14 contract, NOT a pass.
    if (res.status === 400 || res.status === 413) {
      setStatusBoth("paused");
      return "paused";
    }
    // 429 — the verify route's limiter (fast quizzes: Q-transitions +
    // periodic + catch-up can exceed 10/min). Staying 'ready' and re-arming
    // the cadence is correct: a busy server is not an outage, and mapping to
    // `unavailable` would brick proctoring for the rest of the attempt with
    // NO recovery path (nothing leaves 'unavailable' automatically).
    //
    // Sustained-429 honesty backstop: a 429 records NO face_checks row, so a
    // fast quiz-taker can sit in committed-check silence long enough for the
    // verify-silence cron to flag them with no outage claim to exempt it. The
    // verify route stamps `face_verify_attempted_at` BEFORE its limiter's
    // window matters (the attempt is consumed), so after a bounded streak of
    // 429s we surface the honest "proctoring degraded" path (reportUnavailable
    // writes face_unavailable_at) instead of silent silence — the corroboration
    // predicate then holds and the cron honors the outage claim.
    if (res.status === 429) {
      transport429StreakRef.current += 1;
      if (
        trigger !== "start" &&
        transport429StreakRef.current >= VERIFY_TRANSPORT_FAIL_LIMIT &&
        statusRef.current === "ready"
      ) {
        transport429StreakRef.current = 0;
        setStatusBoth("unavailable");
        reportUnavailable();
        return "unavailable";
      }
      scheduleCadence();
      return null;
    }
    if (res.status >= 500) {
      setStatusBoth("unavailable");
      reportUnavailable();
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
        const getRes = await fetch(`/api/sessions/${sessionId}`, { method: "GET", cache: "no-store" });
        const getBody = await getRes.json().catch(() => ({}));
        if (typeof getBody.verify_nonce === "string") {
          nonceRef.current = getBody.verify_nonce;
        }
        // D-F2: the nonce rotated because the session moved (a recovery or a
        // lecturer unlock). The same GET carries the server's remainingMs —
        // adopt it so the countdown re-syncs on this self-heal path too.
        if (typeof getBody.remainingMs === "number" && getBody.remainingMs >= 0) {
          onRecoveredRemainingRef.current?.(getBody.remainingMs);
        }
      } catch {
        // fall through to surface state
      }
      const retried = await postVerifyInternal(payloadFrames, trigger, nonceRef.current, false, fromFlaggedPoll);
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
          const statusRes = await fetch(`/api/sessions/${sessionId}`, { method: "GET", cache: "no-store" });
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
  async function runVerify(
    trigger: "start" | "question" | "periodic",
    lightingRetries = 0,
    // audit-3 E-F5: the bounded `unavailable` self-heal probe must be able to
    // re-enter the verify path while the status is NOT `ready` (the cadence
    // gate below exists to stop the NORMAL cadence, not a recovery probe).
    force = false,
  ) {
    if (isTerminalRef.current || !faceEnforcementEnabled) return;
    if (answerPriorityRef.current && trigger !== "start") return;
    if (verifyLock.current) {
      // A verify is in flight — defer the new one (latest-wins), fired exactly
      // once after the lock releases (never silently dropped).
      pendingVerifyRef.current = trigger;
      return;
    }
    const tracker = trackerRef.current;
    if (!tracker) return;
    // Hidden-tab guard: a hidden tab cannot produce a real frame (the detect
    // loop pauses and captureFrame returns null), so a verify that proceeds
    // would POST the `[""]` no-face sentinel and land an honest tab-switcher
    // with a fabricated FAIL row (→ pause; three inside the streak window →
    // flagged). The visibility handler owns the tab-switch contract: it
    // cancels the cadence on hide and fires the catch-up verify on return.
    // The forced `unavailable` self-heal probe skips this too — scheduleUnavailableRetry
    // already defers its own probes while hidden without consuming an attempt.
    if (!force && hiddenRef.current) return;

    const s = statusRef.current;
    const phaseNow = questionVisibleRef.current ? "question" : "feedback";
    if (!force && !shouldScheduleFaceCheck(s, phaseNow) && trigger !== "start") return;
    if (faceExemptRef.current) {
      setStatusBoth("exempt");
      return;
    }
    if (!enrolledRef.current || !consentGivenRef.current) {
      setStatusBoth("gate");
      return;
    }

    // Client-side pacing: if the last POST was moments ago, fold this trigger
    // into a single deferred re-run after the remaining gap (one timer,
    // latest-wins) instead of burning rate budget on back-to-back POSTs.
    //
    // `force` (the bounded `unavailable` self-heal probe) SKIPS this deferral:
    // the deferred re-run only fires while statusRef is 'ready', which is
    // false in the exact state that calls a forced probe — so deferring would
    // silently drop the probe while the caller had already consumed an attempt
    // from its budget (adversarial review).
    if (trigger !== "start" && !force) {
      // Async verify path — never called during render.
      // eslint-disable-next-line react-hooks/purity
      const sincePost = Date.now() - lastVerifyPostAtRef.current;
      if (sincePost < MIN_CLIENT_VERIFY_GAP_MS) {
        deferredTriggerRef.current = trigger;
        if (minGapTimerRef.current) clearTimeout(minGapTimerRef.current);
        minGapTimerRef.current = setTimeout(() => {
          minGapTimerRef.current = null;
          const deferred = deferredTriggerRef.current;
          deferredTriggerRef.current = null;
          if (
            deferred &&
            !disposedRef.current &&
            !isTerminalRef.current &&
            statusRef.current === "ready"
          ) {
            // Fresh retry budget: the deferral is timer-chained (never
            // immediate), so the re-run gets its own full precheck instead
            // of bypassing it.
            void runVerify(deferred, 0);
          }
        }, MIN_CLIENT_VERIFY_GAP_MS - sincePost);
        return;
      }
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
      if (disposedRef.current || trackerRef.current !== tracker) return;

      // Precheck: defer checks that would photograph a known-bad moment —
      // doomed lighting (a dark/bright frame lands as a FALSE fail row), a
      // raised/mid-commit hand, or no aligned face (palm over the face, head
      // turned away, hand entering frame). Deferrals are BOUNDED
      // (FACE_CHECK_DEFER_MAX): on exhaustion the capture proceeds anyway and
      // the server judges the real frame, so sustained occlusion still lands
      // as an honest FAIL row (pause → blink recovery) — deferral absorbs
      // transient motion, it never suppresses verification. `start` always
      // proceeds: the gate already ran blink liveness, and the student must
      // never be soft-locked by desk conditions. The retry count travels with
      // the invocation so a DIFFERENT trigger firing inside the wait window
      // still gets its own full precheck.
      const health =
        typeof tracker.getFaceHealth === "function" ? tracker.getFaceHealth() : null;
      if (
        !force &&
        shouldDeferFaceCheck(
          health,
          isHandActiveRef.current,
          trigger,
          lightingRetries,
          FACE_CHECK_DEFER_MAX,
        )
      ) {
        if (lightingRetryTimerRef.current) clearTimeout(lightingRetryTimerRef.current);
        lightingRetryTimerRef.current = setTimeout(() => {
          lightingRetryTimerRef.current = null;
          if (disposedRef.current || isTerminalRef.current || statusRef.current !== "ready") return;
          // The moment may have passed (student reached feedback): fall back
          // to the cadence instead of photographing the wrong moment.
          if (
            !shouldScheduleFaceCheck(
              statusRef.current,
              questionVisibleRef.current ? "question" : "feedback",
            )
          ) {
            scheduleCadence();
            return;
          }
          void runVerify(trigger, lightingRetries + 1);
        }, LIGHTING_RETRY_DELAY_MS);
        return;
      }

      // ── Multi-frame capture (2-of-3 majority voting) ─────────────
      // Primary: best-frame selection (centered, open eyes, good lighting)
      // within 1.5s; fallback: plain capture polled for 800ms; final: one
      // 400ms-delayed attempt.
      let primary: string | null = null;
      if (typeof tracker.captureBestFrame === "function") {
        primary = await tracker.captureBestFrame({ maxWaitMs: 1500, requireCentered: true, requireOpenEyes: true });
      } else {
        primary = await tracker.captureFrame();
        const startPoll = Date.now();
        while (!primary && Date.now() - startPoll < 800 && !disposedRef.current) {
          await new Promise((r) => setTimeout(r, 100));
          primary = await tracker.captureFrame();
        }
      }
      if (disposedRef.current || trackerRef.current !== tracker) return;
      if (!primary) {
        // The tab may have been hidden mid-capture (captureBestFrame's poll
        // window can straddle the hide). A sentinel FAIL row for a hidden
        // tab is a fabrication — bail and let the visibility handler's
        // catch-up verify run when the student returns.
        if (hiddenRef.current) return;
        await new Promise((r) => setTimeout(r, 400));
        if (disposedRef.current || trackerRef.current !== tracker) return;
        primary = await tracker.captureFrame();
      }

      // Persistent camera-null mid-quiz: indistinguishable from a wrong face
      // by design — POST the sentinel ([""]) → the RPC records a FAIL row
      // (integrity-conservative; exempt recovery). A DEAD tracker never
      // posts: trackerRef identity was re-checked above, so a mid-capture
      // loop death bails here instead of letting a stale 'ready' overwrite
      // the 'unavailable' degradation. And a tab hidden during the 400ms
      // re-try above bails the same way as the mid-capture check: a sentinel
      // FAIL row for a hidden tab is a fabrication — the visibility
      // handler's catch-up verify runs when the student returns.
      if (!primary) {
        if (hiddenRef.current) return;
        if (force) {
          // A local camera/quality failure during a recovery or outage probe
          // is not a biometric mismatch. Keep input blocked and wait for a
          // usable frame before asking the server to judge identity.
          if (statusRef.current === "recovering") setStatusBoth("paused");
          return;
        }
        await postVerifyInternal([""], trigger, nonceRef.current, true);
        return;
      }

      // Secondary frames: quick plain captures spaced ~500ms apart so the
      // vote spans real time (a transient blur/glance fails ONE frame, not
      // the check). A failed secondary capture is OMITTED — majority runs
      // over the frames actually submitted (capture flakiness is not a fail
      // vote).
      const frames: string[] = [primary];
      for (let i = 1; i < VERIFY_FRAMES_PER_CHECK && !disposedRef.current; i++) {
        await new Promise((r) => setTimeout(r, VERIFY_FRAME_SPACING_MS));
        if (disposedRef.current || trackerRef.current !== tracker) return;
        // Hidden mid-check: the primary above is a genuine pre-hide capture,
        // so submit it promptly instead of spacing out further secondaries
        // the paused detect loop cannot produce.
        if (hiddenRef.current) break;
        const secondary = await captureSecondary(tracker);
        if (trackerRef.current !== tracker) return;
        if (hiddenRef.current) break;
        if (secondary) frames.push(secondary);
      }
      if (disposedRef.current) return;

      await postVerifyInternal(frames, trigger, nonceRef.current, true);
    } finally {
      verifyLock.current = false;
      if (pendingVerifyRef.current && !disposedRef.current && !isTerminalRef.current) {
        const deferred = pendingVerifyRef.current;
        pendingVerifyRef.current = null;
        // Re-check the CURRENT displayed question + status at fire time.
        const qid = lastQuestionIdRef.current;
        if (
          !answerPriorityRef.current &&
          qid === questionIdAtStart ||
          (!answerPriorityRef.current && shouldScheduleFaceCheck(statusRef.current, questionVisibleRef.current ? "question" : "feedback"))
        ) {
          void runVerify(deferred);
        }
      }
    }
  }

  /** Capture three fresh answer frames after any background verify completes. */
  async function captureAnswerFrames(): Promise<{
    frames: string[];
    nonce: string;
    release: () => void;
  } | null> {
    if (faceExemptRef.current || quizMode !== "assessment" || statusRef.current !== "ready") return null;
    answerPriorityRef.current = true;
    if (cadenceTimerRef.current) clearTimeout(cadenceTimerRef.current);
    cadenceTimerRef.current = null;
    pendingVerifyRef.current = null;
    const waitStart = Date.now();
    while (verifyLock.current && Date.now() - waitStart < 20_000 && !disposedRef.current) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const tracker = trackerRef.current;
    const finish = () => {
      answerPriorityRef.current = false;
      if (statusRef.current === "ready") scheduleCadence();
    };
    if (!tracker || verifyLock.current || hiddenRef.current || disposedRef.current || isTerminalRef.current || statusRef.current !== "ready") {
      finish();
      return null;
    }
    const frames: string[] = [];
    let handedOff = false;
    try {
      for (let i = 0; i < VERIFY_FRAMES_PER_CHECK; i++) {
        if (i) await new Promise((resolve) => setTimeout(resolve, 200));
        if (hiddenRef.current || trackerRef.current !== tracker || disposedRef.current || isTerminalRef.current || statusRef.current !== "ready") return null;
        let frame: string | null = null;
        const captureStartedAt = Date.now();
        let unhealthySince: number | null = null;
        while (!frame && Date.now() - captureStartedAt < 1800 && !hiddenRef.current && trackerRef.current === tracker && statusRef.current === "ready") {
          const health = tracker.getFaceHealth?.();
          const sustainedIssue = health && (!health.faceDetected || (health.facesSeen ?? 1) > 1);
          if (sustainedIssue) {
            unhealthySince ??= Date.now();
            if (Date.now() - unhealthySince >= 1000) return null;
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
          unhealthySince = null;
          frame = await tracker.captureFrame();
          if (!frame) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        // A locally unusable capture holds the answer without creating a
        // server mismatch vote; only valid image frames reach identity logic.
        if (!frame) return null;
        frames.push(frame);
      }
      handedOff = true;
      return { frames, nonce: nonceRef.current, release: finish };
    } catch {
      return null;
    } finally {
      if (!handedOff) finish();
    }
  }

  function applyAnswerFaceCheck(faceCheck: unknown) {
    if (!faceCheck || typeof faceCheck !== "object") return;
    const result = faceCheck as { nextNonce?: unknown; sessionStatus?: unknown };
    if (typeof result.nextNonce === "string") nonceRef.current = result.nextNonce;
    if (result.sessionStatus === "paused") setStatusBoth("paused");
    else if (result.sessionStatus === "flagged") {
      setStatusBoth("flagged");
      startFlaggedPoll();
    } else if (result.sessionStatus === "active" && (statusRef.current === "ready" || statusRef.current === "recovering")) {
      setStatusBoth("ready");
    }
  }

  async function refreshNonce() {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, { method: "GET", cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (typeof body.verify_nonce === "string") nonceRef.current = body.verify_nonce;
      if (body.status === "paused") setStatusBoth("paused");
      else if (body.status === "flagged") {
        setStatusBoth("flagged");
        startFlaggedPoll();
      }
    } catch {
      // The next click will retry capture with the last known nonce.
    }
  }

  // ── Blink recovery ─────────────────────────────────────────────
  /**
   * Anti-replay head-turn challenge, run AFTER a blink pass (gate + recovery).
   * The side is chosen at random so a pre-recorded blink+turn video can't
   * match it; trackers without `waitForHeadTurn` (legacy fakes, E2E fake
   * before wiring) feature-detect to an auto-pass. Returns the challenge side
   * (for overlay copy) and whether it passed; failure uses the SAME landing
   * as a failed blink.
   */
  async function runTurnChallenge(
    tracker: IFaceTracker,
  ): Promise<{ side: TurnSide; passed: boolean }> {
    const side = randomTurnSide();
    if (typeof tracker.waitForHeadTurn !== "function") {
      return { side, passed: true };
    }
    // Calibrate the pose baselines FIRST (yaw AND pitch share the "look
    // straight" neutral): the play-time tracker is freshly booted with
    // baseline null, and the uncalibrated geometric midpoint sits INSIDE the
    // documented per-anatomy/webcam offset band (~15-20 yaw units at honest
    // neutral). Without this, one challenge direction can auto-pass with no
    // turn (halving the anti-replay guarantee) and the pitch advisory
    // straddles its threshold for honest students. The student is necessarily
    // facing the screen here — blink just passed. A failed calibration
    // (too few samples — tracking loss, camera settling) retries once with a
    // longer window; still failing, the challenge runs anyway — the verify
    // remains the authority and skipping the whole recovery would strand the
    // student on a retry loop for a soft cosmetic gate.
    let calibrated = await tracker.calibrateNeutral?.(900);
    if (calibrated === false) {
      calibrated = await tracker.calibrateNeutral?.(1800);
    }
    setChallengeSide(side);
    const passed = (await tracker.waitForHeadTurn(HEAD_TURN_TIMEOUT_MS, side)) === "passed";
    setChallengeSide(null);
    setChallengeFailed(!passed);
    return { side, passed };
  }

  async function runRecovery() {
    const tracker = trackerRef.current;
    // A dead/null tracker can no longer run blink or turn challenges — a
    // silent return here strands the student behind the paused overlay with a
    // dead Recover button (their only escape is a reload the overlay never
    // suggests). Degrade honestly to `unavailable` (the degraded-proctoring
    // banner + the face-unavailable claim) instead of swallowing the click.
    if (!tracker || disposedRef.current || isTerminalRef.current) {
      if (!disposedRef.current && !isTerminalRef.current) {
        setStatusBoth("unavailable");
        reportUnavailable();
      }
      return;
    }
    // Re-entrancy guard: a fast double-click on Recover must not run two
    // blink/turn challenges concurrently — the second wait would overwrite
    // the first's tracker challenge and the interleaved landings can bounce
    // a recovered student back to `paused`. setStatusBoth updates statusRef
    // synchronously, so this check closes the same-frame race.
    if (statusRef.current === "recovering") return;
    setStatusBoth("recovering");
    const blink = await tracker.waitForBlink(LIVENESS_TIMEOUT_MS);
    if (disposedRef.current || isTerminalRef.current) return;
    if (blink === "failed") {
      setStatusBoth("paused");
      return;
    }
    const challenge = await runTurnChallenge(tracker);
    if (disposedRef.current || isTerminalRef.current) return;
    if (!challenge.passed) {
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
        // 0045 §5: adopt the server's post-credit remaining time (number only
        // — null means the quiz is untimed and the countdown doesn't exist).
        // This is what converts the pause from a full client freeze into the
        // server's capped credit, killing the mid-answer time_expired drift.
        if (typeof body.remainingMs === "number" && body.remainingMs >= 0) {
          onRecoveredRemainingRef.current?.(body.remainingMs);
        }
        if (hadStartVerifyRef.current) {
          // Keep input blocked until a fresh server identity verdict lands.
          // Blink and turn liveness only prove motion; they do not authorize
          // answers after a mismatch or recovery.
          await runVerify("periodic", 0, true);
          if ((statusRef.current as FaceStatus) === "recovering") {
            setStatusBoth("unavailable");
            reportUnavailable();
          }
        } else {
          setStatusBoth("gate");
        }
      } else if (body.error === "flagged") {
        setStatusBoth("flagged");
        startFlaggedPoll();
      } else if (res.ok || res.status === 409) {
        // The recover REFUSED (session flagged above, or it moved state
        // server-side while the student sat on the paused overlay — quiz
        // auto-close sealed it, a lecturer completed it, another tab's
        // timer hit zero). A blanket re-pause here strands the student on
        // the paused overlay forever (paused has no poll): mirror the REAL
        // state — completed → terminal dead; paused → stay paused; flagged
        // (409 shape) → flagged poll.
        try {
          const statusRes = await fetch(`/api/sessions/${sessionId}`, {
            method: "GET",
            cache: "no-store",
          });
          const realBody = await statusRes.json().catch(() => ({}));
          if (realBody.status === "completed") {
            setStatusBoth("unavailable");
            onPhaseChangeRef.current("dead");
            return;
          }
          if (realBody.status === "flagged") {
            setStatusBoth("flagged");
            startFlaggedPoll();
            return;
          }
        } catch {
          // network — fall through to the conservative re-pause
        }
        setStatusBoth("paused");
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
      const res = await fetch(`/api/sessions/${sessionId}/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      // The RPC is authoritative: it may have FLAGGED at the 3rd hand strike
      // (mirrors focusLossPause below). Without this the student sits on the
      // paused overlay with a Recover button whose self-recover 403s them
      // into the flagged state one wasted click later.
      const body = res.ok ? await res.json().catch(() => ({} as Record<string, unknown>)) : ({} as Record<string, unknown>);
      if ((body as { sessionStatus?: string }).sessionStatus === "flagged") {
        setStatusBoth("flagged");
        startFlaggedPoll();
        return;
      }
    } catch {
      // network — the client overlay still shows; cadence re-checks.
    }
    if (statusRef.current === "ready") {
      setPausedReason("hand_lost");
      setStatusBoth("paused");
    }
  }

  // ── Focus-loss pause (server-side, debounced window blur) ──────
  // The exam window stayed VISIBLE but lost OS focus (clicked another app /
  // second-monitor app). Per policy: pause + overlay; the 3rd confirmed loss
  // flags server-side (pause_session escalates via focus_pause_count).
  async function focusLossPause() {
    if (disposedRef.current || isTerminalRef.current) return;
    if (statusRef.current !== "ready") return;
    // Fullscreen-guard dedupe: a fullscreen-exit pause POSTed moments ago for
    // the SAME app switch — the session is already paused server-side and the
    // client mirrors it locally instead of double-counting the strike.
    const stamp = sharedPauseStampRef?.current ?? 0;
    if (Date.now() - stamp < FULLSCREEN_PAUSE_DEDUPE_MS) {
      if (statusRef.current === "ready") {
        setPausedReason("focus_lost");
        setStatusBoth("paused");
      }
      return;
    }
    if (sharedPauseStampRef) sharedPauseStampRef.current = Date.now();
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "focus_lost" }),
      });
      const body = await res.ok ? await res.json().catch(() => ({})) : ({} as Record<string, unknown>);
      // The RPC is authoritative: it may have FLAGGED at the 3rd strike.
      const serverStatus = (body as { sessionStatus?: string }).sessionStatus;
      if (serverStatus === "flagged") {
        setStatusBoth("flagged");
        startFlaggedPoll();
        return;
      }
    } catch {
      // network — still pause locally so input is blocked until re-verify
    }
    if (statusRef.current === "ready") {
      setPausedReason("focus_lost");
      setStatusBoth("paused");
    }
  }

  function clearBlurTimer() {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  }

  // ── Tracker setter (called by the parent after boot) ───────────
  function setTracker(tracker: IFaceTracker | null) {
    trackerRef.current = tracker;
    // Boot-order safety: a tracker attached while status is already `ready`
    // (StrictMode remount) must not run at the slow tier until its first
    // blink/gate cycle — restore FULL here; the next setStatusBoth re-applies
    // the tier for the current status.
    tracker?.setFrameInterval?.(FACE_TRACK_FRAME_INTERVAL_MS);
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
      if (minGapTimerRef.current) clearTimeout(minGapTimerRef.current);
      if (lightingRetryTimerRef.current) clearTimeout(lightingRetryTimerRef.current);
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
      if (minGapTimerRef.current) clearTimeout(minGapTimerRef.current);
      if (lightingRetryTimerRef.current) clearTimeout(lightingRetryTimerRef.current);
      pendingVerifyRef.current = null;
      deferredTriggerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, quizMode]);

  // Terminal-phase teardown (submitted/dead). The `isTerminalRef` mirror runs
  // in the sync effect above; this effect clears the machinery when it flips.
  useEffect(() => {
    if (isTerminal) {
      if (cadenceTimerRef.current) clearTimeout(cadenceTimerRef.current);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (minGapTimerRef.current) clearTimeout(minGapTimerRef.current);
      if (lightingRetryTimerRef.current) clearTimeout(lightingRetryTimerRef.current);
      clearUnavailableRetry();
      // The `[status]` effect below only re-runs on a status CHANGE — a
      // session that ends while `unavailable` would otherwise keep the 6-min
      // re-arm interval alive until unmount. Clear it here too.
      if (unavailableRearmTimerRef.current) {
        clearInterval(unavailableRearmTimerRef.current);
        unavailableRearmTimerRef.current = null;
      }
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
        // A tab switch also blurs the window — the visibility path owns it
        // (catch-up verify on return); never double-pause via focus-loss.
        clearBlurTimer();
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

  // Focus handling: visible-but-blurred window → debounced pause. The exam
  // window is still on screen (visibilitychange does NOT fire), so this is
  // the ONLY signal that the student clicked into another app — including an
  // app on a second monitor. Transient blurs (OS screenshot tool, IME,
  // notification toasts) refocus inside FOCUS_BLUR_DEBOUNCE_MS and never
  // pause. Armed only while `ready` — gate/paused/flagged have their own
  // flows, and terminal phases must not fire requests.
  useEffect(() => {
    const onBlur = () => {
      if (document.hidden || isTerminalRef.current) return;
      if (statusRef.current !== "ready") return;
      clearBlurTimer();
      blurTimerRef.current = setTimeout(() => {
        blurTimerRef.current = null;
        void focusLossPause();
      }, FOCUS_BLUR_DEBOUNCE_MS);
    };
    const onFocus = () => {
      clearBlurTimer();
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      clearBlurTimer();
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track the current question for stale-flight guards. The identity check is
  // now taken atomically with the answer commit, so a separate question-change
  // POST would be redundant and could race the answer nonce.
  useEffect(() => {
    if (!questionVisible || questionId === null) return;
    lastQuestionIdRef.current = questionId;
  }, [questionId, questionVisible]);

  // Gate Begin: run blink liveness, then the anti-replay head-turn
  // challenge, then the `'start'` verify (the authority).
  async function beginGate() {
    // Re-entrancy guard (mirrors runRecovery): a fast double-click on Begin
    // must not run two concurrent liveness pipelines — the second wait would
    // overwrite the first's tracker challenge (a NEW random side mid-turn)
    // and the student fails a challenge whose direction changed under them.
    // setStatusBoth updates statusRef synchronously, so this closes the
    // same-frame race.
    if (statusRef.current === "recovering") return;
    setChallengeFailed(false);
    setGateAttempt("idle");
    const tracker = trackerRef.current;
    if (!tracker || disposedRef.current || isTerminalRef.current) return;
    setStatusBoth("recovering");
    const blink = await tracker.waitForBlink(LIVENESS_TIMEOUT_MS);
    if (disposedRef.current || isTerminalRef.current) return;
    if (blink !== "passed") {
      setGateAttempt("blink_failed");
      setStatusBoth("gate");
      return;
    }
    const challenge = await runTurnChallenge(tracker);
    if (disposedRef.current || isTerminalRef.current) return;
    if (!challenge.passed) {
      setStatusBoth("gate");
      return;
    }
    // NOTE: `hadStartVerifyRef` is set ONLY by the `ready` branch in
    // `postVerifyInternal` (trigger === 'start'). Setting it here would let a
    // FAILED gate verify recover to `ready` via `recoveryLanding(true)` —
    // bypassing the gate's authority (the blink alone is not a verify).
    const startOutcome = await runVerify("start");
    if (disposedRef.current || isTerminalRef.current) return;
    // The gate's authority is the 'start' verify: a transport failure (or any
    // non-ready landing) must be VISIBLE, or the student retries blind against
    // an unexplained failure. The success path lands `ready`/`paused`/`flagged`
    // — none of which render the gate — so only a back-to-gate landing needs
    // the copy.
    if (statusRef.current === "gate") setGateAttempt("verify_failed");
    void startOutcome;
  }

  function checkAgain() {
    startFlaggedPoll();
  }

  /**
   * Client-side pause surface for sibling guards (integrity hardening's
   * fullscreen exit): the caller owns the POST (a different reason); this
   * mirrors the server-paused state locally so the overlay + input block
   * engage. No-op unless the pipeline is `ready` — a pause arriving while
   * paused/flagged/gate must not stomp those flows.
   */
  function pauseLocally(reason: PausedReason) {
    if (statusRef.current !== "ready") return;
    setPausedReason(reason);
    setStatusBoth("paused");
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
    pausedReason,
    challengeSide,
    challengeFailed,
    gateAttempt,
    beginGate,
    checkAgain,
    runRecovery,
    handLossPause,
    pauseLocally,
    setTracker,
    setStatusBoth,
    markConsentGiven,
    captureAnswerFrames,
    applyAnswerFaceCheck,
    refreshNonce,
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
