"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { QuestionCard } from "@/components/quiz/question-card";
import { ProgressHud } from "@/components/quiz/progress-hud";
import { GestureLayer } from "@/components/vision/gesture-layer";
import {
  bumpPracticeAttempts,
  readPracticeAttempts,
  clearPracticeAttempts,
} from "@/lib/sessions/practice-oracle";
import {
  TYPE_HAS_FINGER_INPUT as TYPE_HAS_FINGER_INPUT_SET,
  isAnswerPadArmed,
} from "@/lib/sessions/gesture-arming";
import { Button } from "@/components/ui/button";
import { MAX_ANSWER_FINGERS } from "@/lib/gestures/constants";
import { optionScope, shufflePlan, toCanonical, toPresented } from "@/lib/sessions/shuffle";
import { milestoneFor, type TimerMilestone } from "@/lib/a11y/timer-milestones";
import type { HoldProgress } from "@/lib/gestures/types";
import { FaceVerifier } from "@/components/face/face-verifier";
import { useFacePipeline, type FacePipelinePhase } from "@/components/face/use-face-pipeline";
import { useFaceTracker } from "@/components/face/use-face-tracker";
import { useIntegrityAdvisories } from "@/components/face/use-integrity-advisories";
import { useIncidentRecorder } from "@/components/face/use-incident-recorder";
import { getFakeFaceTracker } from "@/lib/face/fake-seam";
import { isFakeFaceSeamEnabled } from "@/lib/face/seam-gate";
import { useFullscreenGuard } from "@/lib/integrity/use-fullscreen-guard";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useWakeLock } from "@/hooks/use-wake-lock";
import { HAPTIC, haptic } from "@/lib/haptics";
import { Info } from "lucide-react";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalDescription,
} from "@/components/ui/responsive-modal";
import type { FaceStatus } from "@/lib/face/types";


type Question = {
  id: string;
  order_index: number;
  type: "mcq" | "true_false" | "multi_select" | "short_text";
  prompt: string;
  options: string[];
  has_image?: boolean;
  created_at: string;
};

type Quiz = {
  id: string;
  title: string;
  mode: "practice" | "assessment";
  timeLimitSec: number | null;
  /** v4.9 quiz-level gesture kill switch (quizzes.gestures_enabled). */
  gesturesEnabled: boolean;
};

/**
 * R6: the types the AnswerPad can actually answer. Everything else must
 * leave the pad DISARMED — an armed pad on a question with no option to
 * point at would latch nothing while still consuming the palm-next gesture,
 * and (B6-8) it would misreport `isHandActive` to the integrity layer.
 *
 * This is an ALLOW-list, not a deny-list: a future type is disarmed by
 * default, which is the safe direction (a missed affordance is visible; a
 * phantom latch is not).
 *
 * audit-4 M4: extracted to `src/lib/sessions/gesture-arming.ts` so the
 * matrix is unit-tested (U-65) without mounting this island.
 */
const TYPE_HAS_FINGER_INPUT: ReadonlySet<string> = TYPE_HAS_FINGER_INPUT_SET;

type SeedAnswer = {
  question_id: string;
  selected_index: number | null;
  /** QT-1: multi-select rows carry the canonical selection set instead. */
  selected_indices: number[] | null;
  is_correct: boolean | null;
  /** v4.9: a short_text row resumes its typed answer (the view exposes it
   * UNGATED — it is the student's own answer, not an oracle). */
  answer_text?: string | null;
  /** v4.9: a skipped row must resume as SKIPPED, not as "Incorrect" — the
   * seed would otherwise carry is_correct:false and render a red X for a
   * question the student deliberately passed on. */
  skipped?: boolean | null;
};

// ── audit-1 P1-12: unsent-answer stash ──────────────────────────────
// A 401 mid-exam (expired auth session) bounces the student through
// /login?redirect=<here>. Every RECORDED answer lives server-side and seeds
// back from initialAnswers; the only client-local state at risk is the
// selection the student just committed but the server never recorded. It is
// stashed to sessionStorage (per session id) and re-merged on remount.
type StashedDraft = {
  questionId: string;
  selectedIndex?: number;
  selectedIndices?: number[];
  /** n28: a 401 mid-short_text must not lose the typed answer. */
  answerText?: string;
  /** n28: a 401 mid-Skip must not lose the skip. */
  skipped?: boolean;
};

const DRAFT_STASH_PREFIX = "innovision:play-draft:";

function stashUnsentAnswer(sessionId: string, draft: StashedDraft): void {
  try {
    sessionStorage.setItem(DRAFT_STASH_PREFIX + sessionId, JSON.stringify(draft));
  } catch {
    // storage unavailable (private mode / quota) — redirect without the draft
  }
}

function takeStashedAnswer(sessionId: string): StashedDraft | null {
  try {
    const key = DRAFT_STASH_PREFIX + sessionId;
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    sessionStorage.removeItem(key);
    const parsed = JSON.parse(raw) as StashedDraft | null;
    return parsed && typeof parsed.questionId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export type AnswerState = {
  /** Single-answer selection (presented space). Absent on multi questions. */
  selectedIndex?: number;
  /** QT-1: the committed multi-selection (presented space). */
  selectedIndices?: number[];
  isCorrect: boolean;
  correctIndex?: number;
  /** QT-1: the correct SET for multi feedback (presented space). */
  correctIndices?: number[];
  explanation?: string;
  /** v4.9: the committed free-text answer (presented as typed). */
  answerText?: string;
  /** v4.9: the student chose Skip. Renders the Skipped chip instead of a
   * Correct/Incorrect verdict — a skip is a deliberate non-answer. */
  skipped?: boolean;
  /** True when feedback came from a resume seed (no key/explanation). */
  seeded?: boolean;
};

type Phase =
  | "question"
  | "locked"
  | "feedback"
  | "submitting"
  | "submitted"
  | "timeUp"
  | "dead";

const FETCH_TIMEOUT_MS = 15_000;

/** Phases where the pause overlay is suppressed so the timeUp Retry-submit stays reachable. */
const BLOCK_INPUT_PHASES: Phase[] = ["timeUp", "submitting", "submitted", "dead"];

/**
 * The quiz engine (click-first). Owns the answer flow, the UX-only countdown
 * timer, and submit.
 *
 * Robustness notes (PLAN_PHASE5 §2/§4):
 *  - `submitLock` guards against double-submits (released in `finally`).
 *  - The countdown is seeded server-side (`initialRemainingMs`) and decremented
 *    monotonically — never `Date.now()` re-reads, never paused mid-question,
 *    stopped at ≤0 or when untimed.
 *  - When the timer hits 0, `timeUp` blocks new answers, AWAITS any in-flight
 *    answer fetch (so the last answer isn't silently dropped), then submits.
 *  - A 403 `time_expired` from an awaited answer is treated as confirmation
 *    (the client is already in `timeUp`), not an error.
 *  - Submit 200 or 409 `already_submitted` are both terminal: the end state is
 *    rendered from the response payload immediately (robustness: a
 *    `router.refresh()` may fail), then refreshed to reconcile with the DB.
 *  - Answer endpoints are idempotent (assessment `already_answered`, practice
 *    upsert), so a retry after an abort/network error is safe.
 *
 * Resume: seeded answers carry only `selectedIndex`/`isCorrect` (no key —
 * the key is never stored on session_answers); questions answered in the
 * current page session get full practice feedback.
 *
 * QT-3 shuffling: when `shuffled` is set, the questions/options arrive in
 * presented (session-seeded) space — outgoing answers are translated to
 * canonical indices before POST, incoming canonical feedback indices are
 * translated back. All other state stays presented-space.
 */
export function PlayClient({
  sessionId,
  quiz,
  questions,
  initialIndex = 0,
  initialAnswers = [],
  initialRemainingMs = null,
  shuffled = false,
  face,
  hasMultiQuestions = false,
}: {
  sessionId: string;
  quiz: Quiz;
  questions: Question[];
  initialIndex?: number;
  initialAnswers?: SeedAnswer[];
  initialRemainingMs?: number | null;
  /** QT-3: the envelope arrived in presented (shuffled) space — indices must be translated. */
  shuffled?: boolean;
  /** QT-1: the quiz contains at least one multi-select question — the
   * gesture calibration panel shows its toggle/commit practice module. */
  hasMultiQuestions?: boolean;
  face?: {
    enrolled: boolean;
    consentGiven: boolean;
    faceExempt: boolean;
    initialNonce: string;
    initialFaceStatus: FaceStatus;
    hasFaceChecks: boolean;
  };

}) {
  const router = useRouter();
  const t = useTranslations("play");
  const tCommon = useTranslations("common");
  // audit-1 P1-12: the mid-exam expired-session copy (authErrors key was
  // written for the register flow and unused until now).
  const tAuth = useTranslations("authErrors");
  // Polish round (W2 C4): the hand-loss warn chip copy lives in the vision
  // namespace (single source — the same phrase the wide layout renders).
  const tVision = useTranslations("vision");

  // audit-1 P1-12 / audit-2 L-12: consume the 401-stash ONCE at mount (state
  // initializer — stable across re-renders) and route it to the PENDING map,
  // never into `answers`. The old restore seeded a keyless `isCorrect:false`
  // AnswerState: practice rendered a graded "Incorrect" badge on an
  // ungraded draft, and the truthy `answers` entry disarmed Confirm/Next —
  // a dead-end with no actionable button until reload.
  const [stashedDraft] = useState<StashedDraft | null>(() =>
    takeStashedAnswer(sessionId),
  );
  const [index, setIndex] = useState(initialIndex < 0 ? 0 : initialIndex);
  const [answers, setAnswers] = useState<Record<string, AnswerState>>(() => {
    const seed: Record<string, AnswerState> = {};
    for (const a of initialAnswers) {
      seed[a.question_id] = {
        // QT-1: multi rows seed the presented SET (the server already
        // translated it); single rows seed the presented scalar. A row with
        // BOTH keys null (unreachable via the RPC) renders answered with no
        // highlight — never a fabricated option 0.
        ...(a.selected_indices
          ? { selectedIndices: a.selected_indices }
          : a.selected_index != null
            ? { selectedIndex: a.selected_index }
            : {}),
        // v4.9 (B6-3/FC-11): a resumed short_text row must show the text the
        // student typed, and a resumed SKIP must show the Skipped chip. Both
        // are ungated in student_answers_view precisely so resume works
        // pre-reveal. Without the skipped flag the seed's is_correct:false
        // would render a red ✗ for a question the student deliberately
        // passed on.
        ...(a.answer_text ? { answerText: a.answer_text } : {}),
        ...(a.skipped ? { skipped: true } : {}),
        isCorrect: a.is_correct === true,
        seeded: true,
      };
    }
    // n28: a stashed SKIP was never recorded (the 401 beat the RPC), but the
    // student's intent is unambiguous and the post-skip UI is exactly what
    // this renders (Skipped chip + Next). Unlike the old single-selection
    // restore, this cannot strand the question — a skip has no Confirm step.
    // Guarded so a genuinely recorded seed always wins.
    if (stashedDraft?.skipped && !seed[stashedDraft.questionId]) {
      seed[stashedDraft.questionId] = { skipped: true, isCorrect: false, seeded: true };
    }
    return seed;
  });
  const [phase, setPhase] = useState<Phase>(
    initialIndex < 0 ? "feedback" : "question",
  );
  const [submissionReason, setSubmissionReason] = useState<"time_up" | "manual" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(initialRemainingMs);
  const [result, setResult] = useState<{ score: number | null; total: number | null } | null>(null);
  const [holdProgress, setHoldProgress] = useState<HoldProgress | null>(null);
  const [gestureActive, setGestureActive] = useState(false);
  const [faceStatus, setFaceStatus] = useState<FaceStatus>(face?.initialFaceStatus ?? "off");
  const [faceUnavailable, setFaceUnavailable] = useState(false);
  // SQ-3: pending flag for the end-state "Try again" fresh attempt.
  const [retrying, setRetrying] = useState(false);
  // Submit-failure (plan W3 8th bar state): NOT a new Phase — a client-render
  // flag set by submitNow()'s failure branches, cleared on submit start and
  // success. The bar renders the destructive Retry state while
  // (timeUp || question) && lastSubmitFailed; pause overlays are suppressed
  // alongside so the retry stays reachable (same treatment as timeUp).
  const [lastSubmitFailed, setLastSubmitFailed] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  // Polish round (W2 C4): hand-loss warn mirrors from GestureLayer so the
  // chip renders INSIDE the fixed action bar instead of a fourth sticky
  // floating layer on the play screen. The SR channel is the existing polite
  // announcer (warnAnnouncement) — no new live region, contract kept.
  const [handWarn, setHandWarn] = useState(false);
  const [warnAnnouncement, setWarnAnnouncement] = useState<string | null>(null);
  // Wide gate (plan §2): one media query, comma-OR. Landscape phones get the
  // desktop split (a portrait composition in 390px of height is unusable);
  // SSR renders the mobile composition (getServerSnapshot false — the
  // accepted desktop/landscape hydration flash).
  const isWide = useMediaQuery("(min-width: 1024px), (orientation: landscape) and (min-width: 640px)");

  // Locks: one answer in flight at a time; no submit while answering.
  const submitLock = useRef(false);
  const retryLock = useRef(false);
  const inFlightAnswer = useRef<Promise<void> | null>(null);
  // Mirror of `phase` in a ref so concurrent handlers (submitNow / handleTimeUp) can
  // tell whether handleTimeUp already moved us into timeUp).
  const phaseRef = useRef<Phase>(initialIndex < 0 ? "feedback" : "question");
  function setPhaseAndRef(p: Phase) {
    phaseRef.current = p;
    setPhase(p);
  }

  const isPractice = quiz.mode === "practice";
  const question = questions[Math.min(index, questions.length - 1)];
  const answered = answers[question?.id];

  // Polish round (W2 C2): cam status for the quiz-info sheet — mirrors the
  // ProgressHud camStatus derivation so a phone can check camera state
  // without the header dot.
  const camStatusForInfo =
    quiz.mode !== "assessment" || faceStatus === "off" || faceStatus === "exempt" || faceStatus === "unavailable"
      ? null
      : faceStatus === "ready"
        ? "aligned"
        : "reposition";

  function formatTimeLimit(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // SQ-3 dead-end: when the seed is the all-answered state (initialIndex -1 →
  // feedback on Q1), "Next" would strand the student — advancing into an
  // already-answered question renders zero actionable buttons (selectOption
  // early-returns, Confirm requires unanswered, Next requires feedback). With
  // everything answered, the only sensible action is Finish → submit.
  const allAnswered = questions.length > 0 && questions.every((q) => answers[q.id]);

  // A11y: the answered option/Confirm unmounts as feedback mounts — move
  // focus to Next/Finish so keyboard + SR users keep their anchor (the
  // feedback chip itself is a plain span; the focus move is the announcement).
  const nextButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (phase === "feedback") nextButtonRef.current?.focus();
  }, [phase]);
  // Haptics (plan W3, mode-split): timeUp pattern fires in BOTH modes — no
  // per-commit buzz in assessments (exam-hall + camera micro-shake).
  useEffect(() => {
    if (phase === "timeUp") haptic(HAPTIC.timeUp);
  }, [phase]);
  // QT-1: in-progress multi-selections, keyed by question id (presented
  // space; committed by the Confirm button via answer()). Keying removes any
  // reset-on-navigation effect: a fresh question simply has no entry, and a
  // stale entry for an answered question is ignored at the read site.
  const [pendingByQuestion, setPendingByQuestion] = useState<Record<string, number[]>>(() => {
    // audit-2 L-12: the stashed multi draft re-arms the Confirm button for
    // its question (re-POSTs on confirm — the server never recorded it).
    // A stashed SINGLE selection has no pending UI (single answers commit on
    // click) — restoring it into `answers` would strand the question, so it
    // is intentionally dropped: the student re-clicks, one tap.
    return stashedDraft?.selectedIndices
      ? { [stashedDraft.questionId]: stashedDraft.selectedIndices }
      : {};
  });
  const pendingMulti = answers[question?.id] ? [] : (pendingByQuestion[question?.id] ?? []);
  function setPendingMulti(next: number[] | ((prev: number[]) => number[])) {
    if (!question) return;
    setPendingByQuestion((prev) => {
      const cur = prev[question.id] ?? [];
      const value = typeof next === "function" ? next(cur) : next;
      return { ...prev, [question.id]: value };
    });
  }

  // v4.9 (E-58): the practice oracle counter, keyed by question id EXACTLY like
  // `pendingByQuestion` — a committed practice answer bumps the entry, and the
  // current question's value is derived at the read site below. Deriving beats
  // mirroring in an effect: an effect that syncs storage into state would be a
  // cascading render (React Compiler rejects it) for a value that only changes
  // when THIS component writes it.
  const [practiceAttemptsByQuestion, setPracticeAttemptsByQuestion] = useState<
    Record<string, number>
  >(() => {
    // Lazy initializer: runs once, client-side, so SSR never touches storage.
    // n30: seed EVERY question, not just the current one — a resumed session
    // that lands mid-quiz must report an exhausted earlier question's count
    // (the old current-question-only seed read 0 until the next bump, so
    // "Try again" on a previously-limited question lost the limit line).
    if (!isPractice) return {};
    try {
      const seed: Record<string, number> = {};
      for (const q of questions) {
        const n = readPracticeAttempts(window.localStorage, quiz.id, q.id);
        if (n > 0) seed[q.id] = n;
      }
      return seed;
    } catch {
      return {}; // private mode / disabled storage — degrades to 0
    }
  });
  const practiceAttempts = question
    ? (practiceAttemptsByQuestion[question.id] ?? 0)
    : 0;
  function bumpPracticeAttemptsForCurrentQuestion() {
    if (!isPractice || !question) return;
    let next: number;
    try {
      next = bumpPracticeAttempts(window.localStorage, quiz.id, question.id);
    } catch {
      // Storage unavailable: still raise the in-page value so the limit can
      // show within this visit. Advisory-only by design.
      next = (practiceAttemptsByQuestion[question.id] ?? 0) + 1;
    }
    setPracticeAttemptsByQuestion((prev) => ({ ...prev, [question.id]: next }));
  }

  // v4.9: the in-progress free-text answer, keyed by question id exactly like
  // pendingMulti — a fresh question simply has no entry, so navigating away
  // and back preserves what the student typed without a reset effect.
  const [pendingTextByQuestion, setPendingTextByQuestion] = useState<Record<string, string>>(() =>
    // n28: a stashed short_text draft re-seeds the textarea for its question
    // (same rationale as the multi stash — the server never recorded it).
    stashedDraft?.answerText
      ? { [stashedDraft.questionId]: stashedDraft.answerText }
      : {},
  );
  const pendingText = answers[question?.id] ? "" : (pendingTextByQuestion[question?.id] ?? "");
  function setPendingText(next: string) {
    if (!question) return;
    setPendingTextByQuestion((prev) => ({ ...prev, [question.id]: next }));
  }

  // QT-3: presented→canonical mapping for the current question's options.
  // Recomputed from (sessionId, question id, count) via the shared pure module
  // — identical to the permutation the server applied when building the
  // envelope, by construction. null = shuffle off (identity).
  function optionPlanFor(q: Question): number[] | null {
    return shuffled ? shufflePlan(sessionId, optionScope(q.id), q.options.length) : null;
  }

  // ── Face pipeline (Phase 7) ─────────────────────────────────────
  // Availability is evaluated BEFORE enrollment/consent (boot failure →
  // 'unavailable' → passthrough regardless of enrolled/consentGiven).
  const faceTracker = useFaceTracker({
    // Terminal phases must tear the tracker down (mirrors useIntegrityAdvisories
    // and useIncidentRecorder below): on submit success / death the RSC swap
    // replaces PlayClient, and if router.refresh() stalls the webcam light +
    // MediaPipe landmarker would stay hot indefinitely with no pipeline.
    enabled:
      quiz.mode === "assessment" &&
      Boolean(face) &&
      phase !== "submitted" &&
      phase !== "dead",
    onUnavailable: () => setFaceUnavailable(true),
  });

  // Integrity hardening (Feature C): shared pause stamp so the debounced
  // blur (focus_lost) and the fullscreen-exit (fullscreen_exit) pauses for
  // the SAME app switch dedupe — see useFacePipeline / useFullscreenGuard.
  // faceStatusRef mirrors faceStatus (sync effect, React Compiler-safe)
  // because the fullscreenchange closure must read the CURRENT status.
  // fullscreenArmed: set at the gate Begin click so holdFullscreen flips
  // WITHIN the user gesture — entry is gesture-scoped (request() below), and
  // entry driven by the later 'ready' transition would reject (the blink
  // wait outlives transient user activation).
  const [fullscreenArmed, setFullscreenArmed] = useState(false);
  const sharedPauseStampRef = useRef(0);
  const faceStatusRef = useRef(faceStatus);
  useEffect(() => {
    faceStatusRef.current = faceStatus;
  });
  const fullscreenGuard = useFullscreenGuard({
    enabled: quiz.mode === "assessment" && Boolean(face),
    active: phase !== "submitted" && phase !== "dead" && phase !== "timeUp",
    // Held from the Begin click until a terminal phase; the true→false edge
    // deliberately exits fullscreen so the results/dead screen never rides
    // fullscreen. Entry is gesture-scoped only (request() in onBegin).
    holdFullscreen:
      fullscreenArmed && phase !== "submitted" && phase !== "dead",
    // Same ref the pipeline's focusLossPause checks-and-stamps — BOTH orders
    // of the app-switch double-fire (fullscreen-first, blur-first) dedupe.
    sharedPauseStampRef,
    onFullscreenExit: () => {
      // Only a verified, answering student leaving fullscreen is an integrity
      // event — exits during the gate or while already paused are ignored
      // (deterrence-only; no redundant server round-trip).
      if (faceStatusRef.current !== "ready") return;
      // Stamp BEFORE the POST: the debounced blur may fire while this fetch
      // is still in flight (slow network), and the blur path must dedupe
      // against the SAME app switch. If the POST provably fails below, the
      // stamp is cleared again so a genuine focus-loss pause can still
      // reach the server.
      const stampedAt = Date.now();
      sharedPauseStampRef.current = stampedAt;
      void fetch(`/api/sessions/${sessionId}/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "fullscreen_exit" }),
      })
        .then((r) => {
          if (!r.ok) throw new Error("pause failed");
          return r.json().catch(() => ({}));
        })
        .then((body: Record<string, unknown> | undefined) => {
          // The RPC is authoritative (plain pause today; flagged only if the
          // reason is ever promoted to the focus-loss counter).
          if (body?.sessionStatus === "flagged") {
            pipeline.setStatusBoth("flagged");
            pipeline.checkAgain();
            return;
          }
          pipeline.pauseLocally("fullscreen_exit");
        })
        .catch(() => {
          // network/HTTP failure — the session is NOT paused server-side, so
          // retract our stamp (only if unchanged) and let the blur path own
          // the real pause record; block input locally meanwhile.
          if (sharedPauseStampRef.current === stampedAt) sharedPauseStampRef.current = 0;
          pipeline.pauseLocally("fullscreen_exit");
        });
    },
  });
  // Screen wake lock (plan W3): a screen auto-lock mid-assessment cascades
  // into a focus_lost pause. Acquired once the gate is passed (beginGate),
  // re-armed on visibilitychange by the hook, released on terminal phases.
  const wakeLockEnabled =
    quiz.mode === "assessment" &&
    Boolean(face) &&
    faceStatus !== "gate" &&
    faceStatus !== "off" &&
    phase !== "submitted" &&
    phase !== "dead";
  useWakeLock({ enabled: wakeLockEnabled });

  const pipeline = useFacePipeline({
    sessionId,
    quizMode: quiz.mode,
    enrolled: face?.enrolled ?? false,
    consentGiven: face?.consentGiven ?? false,
    faceExempt: face?.faceExempt ?? false,
    initialNonce: face?.initialNonce ?? "",
    initialFaceStatus: face?.initialFaceStatus ?? "off",
    questionId: question?.id ?? null,
    questionVisible: phase === "question" || phase === "locked",
    phase,
    isHandActive: holdProgress !== null,
    sharedPauseStampRef,
    onHandLossPause: () => {
      // The server pause POST happens in the hook; here we keep the gesture
      // layer from emitting input while paused (sessionPaused gate).
    },
    onPhaseChange: (p: FacePipelinePhase) => {
      // A session completed server-side (e.g. another tab's timer / flagged
      // poll) must move the quiz to the terminal state.
      if (p === "submitted" || p === "dead") setPhaseAndRef(p);
    },
    onReset: () => {
      // D13 — the pipeline observed a 404 on a verify POST: the session was
      // reset by a lecturer mid-flight. Terminal dead screen (no retry).
      setError(t("toast.resetDead"));
      setPhaseAndRef("dead");
    },
    onRecoveredRemaining: (ms) => {
      // 0045 §5 (audit-1 §2.13): after a blink recovery the server reports
      // the post-credit remaining time. Adopt it wholesale — the countdown
      // used to freeze through the whole pause while the server credited at
      // most 120 s, and the drift surfaced as a mid-answer time_expired 403.
      setRemainingMs(ms);
    },
    onFaceStatus: (s) => setFaceStatus(s),
  });

  // Pass the tracker to the pipeline once booted.
  useEffect(() => {
    pipeline.setTracker(faceTracker.trackerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faceTracker.available]);

  // ── Integrity advisories (lecturer-visible hints, never blocking) ──
  const { micStreamRef } = useIntegrityAdvisories({
    sessionId,
    // audit-1 P2 (R6 P1-B): `enabled` flipping false at a terminal phase
    // runs the hook's cleanup, which stops the mic tracks — without it the
    // OS mic indicator stayed hot after submit (the camera tracker is
    // disposed but the advisory mic stream was not).
    enabled:
      quiz.mode === "assessment" &&
      Boolean(face) &&
      faceTracker.available &&
      phase !== "submitted" &&
      phase !== "dead",
    armed: faceStatus === "ready",
    tracker: faceTracker.trackerRef.current,
  });

  // ── Incident ring-buffer recorder (uploads ONLY on incidents) ──────
  // Skipped under the E2E fake seam — headless runs must not exercise a real
  // getUserMedia/MediaRecorder path the fake tracker doesn't cover.
  //
  // R2-INC-F2: `enabled` carries a PHASE term (mirroring useIntegrityAdvisories
  // above). Without it the recorder stayed armed after session death — a
  // session in `dead`/`submitted` can never produce another incident, so the
  // capture machinery must be torn down; the hook's own `!enabled` cleanup
  // runs on the flip (this is the client-side half of the fix; the hook owns
  // the actual recorder/stream teardown).
  const isFakeFace =
    isFakeFaceSeamEnabled() && getFakeFaceTracker() != null;
  useIncidentRecorder({
    sessionId,
    enabled:
      quiz.mode === "assessment" &&
      Boolean(face) &&
      !isFakeFace &&
      phase !== "submitted" &&
      phase !== "dead",
    status: faceStatus,
    phase,
    // The clip's stored reason is the PAUSE CAUSE, not the bare status — the
    // dashboard renders it to the lecturer ("face" vs focus loss vs
    // fullscreen exit vs a flagged/unavailable degradation).
    reason: faceStatus === "paused" ? pipeline.pausedReason : faceStatus,
    micStreamRef,
  });

  // If the tracker is unavailable, force the pipeline to passthrough.
  useEffect(() => {
    if (faceUnavailable && quiz.mode === "assessment" && faceStatus !== "unavailable") {
      pipeline.setStatusBoth("unavailable");
      // Record the gap once (idempotent server-side).
      void fetch(`/api/sessions/${sessionId}/face-unavailable`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faceUnavailable]);

  // Monotonic countdown — UX only, never trusted (the RPC is authoritative).
  // Pauses while the session is paused or flagged so the student doesn't lose
  // quiz time while waiting for lecturer review or completing blink recovery.
  //
  // R2-SESS-F2 — `dead` is TERMINAL (deliberate, do not "fix" by removing it
  // from this list): the countdown must not resurrect dead → timeUp → submit.
  // Before D-F1(a) `dead` was an ACCIDENTAL rescuer: the quiz_not_live answer
  // path dead-ended and only the still-ticking countdown (timed quizzes)
  // eventually submitted. That path now submits directly (see the
  // quiz_not_live branch in answer()), so every remaining `dead` entry is a
  // session a submit cannot help — reset by a lecturer (404), completed in
  // another tab, or a verify that surfaced the end (outcome surfaceEnd). Any
  // strand caused by a quiz closing under a non-answering tab is covered
  // server-side by quiz_autoclose's seal (0048 §5), NOT by a client timer.
  useEffect(() => {
    if (remainingMs === null) return;
    if (phase === "submitted" || phase === "timeUp" || phase === "dead") return;
    if (faceStatus === "flagged" || faceStatus === "paused") return;
    if (remainingMs <= 0) {
      void handleTimeUp();
      return;
    }
    const t = setInterval(() => {
      setRemainingMs((prev) => (prev === null ? null : Math.max(0, prev - 1000)));
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remainingMs, phase, faceStatus]);

  // ── AX-3: discrete timer milestones for screen readers ───────────
  // The countdown pill itself is aria-live="off" (per-second ticks would
  // spam); instead each threshold fires ONE announcement: T-10m/5m/1m polite,
  // <30s assertive-once (coinciding with the pill's red flip). Value-keyed
  // (not wall-clock) so pause/flag gaps are inherently tolerated. The
  // announced-set ref (FlaggedWaitTicker transition idiom) guarantees
  // once-per-milestone even across re-renders. Announcement state is derived
  // DURING RENDER (no setState-in-effect) — the ref mutates only when a new
  // milestone fires, so re-renders don't re-trigger.
  const announcedMilestones = useRef<Set<TimerMilestone>>(new Set());
  const [milestoneAnnouncement, setMilestoneAnnouncement] = useState<string | null>(null);
  const [assertiveAnnouncement, setAssertiveAnnouncement] = useState<string | null>(null);
  // AX-3: "Answer N confirmed" channel (polite; fired from answer() success).
  const [answerAnnouncement, setAnswerAnnouncement] = useState<string | null>(null);
  if (remainingMs !== null) {
    const milestone = milestoneFor(remainingMs);
    if (milestone && !announcedMilestones.current.has(milestone)) {
      announcedMilestones.current.add(milestone);
      if (milestone === "s30") {
        setAssertiveAnnouncement(t("hud.milestoneS30"));
      } else {
        setMilestoneAnnouncement(
          milestone === "m10"
            ? t("hud.milestoneM10")
            : milestone === "m5"
              ? t("hud.milestoneM5")
              : t("hud.milestoneM1"),
        );
      }
    }
  }

  async function handleTimeUp() {
    // R2-SESS-F2: `dead` is terminal — a timer that fires while the session
    // is gone/completed must not re-enter timeUp and submit. See the
    // countdown comment above for the full decision.
    if (phase === "submitted" || phase === "timeUp" || phase === "dead") return;
    setSubmissionReason("time_up");
    setPhaseAndRef("timeUp");
    setError(null);
    setNotice(t("toast.timeUp"));
    // Await any in-flight answer so the student's last answer isn't dropped.
    if (inFlightAnswer.current) {
      try {
        await inFlightAnswer.current;
      } catch {
        // The awaited answer may have rejected (abort/network); the submit
        // below is still safe (idempotent), and a 403 time_expired from it is
        // treated as confirmation — the client is already in timeUp.
      }
    }
    await submitNow();
  }

  function selectOption(optionIndex: number) {
    if (phase !== "question") return;
    if (!question) return;
    // Defensive bounds guard (P6): the RPC is the backstop, but a malformed
    // gesture/click must never attempt an out-of-range index.
    if (optionIndex < 0 || optionIndex >= question.options.length) return;
    // Ignore clicks on already-answered questions while in question phase
    // (resume) — they must advance via Next instead.
    if (answers[question.id]) return;
    // QT-1: multi-select questions TOGGLE membership in the pending set;
    // the answer commits when the student hits Confirm.
    if (question.type === "multi_select") {
      setPendingMulti((prev) =>
        prev.includes(optionIndex)
          ? prev.filter((i) => i !== optionIndex)
          : [...prev, optionIndex],
      );
      return;
    }
    void answer(optionIndex);
  }

  // v4.9 overloads: a string is a short_text answer, the literal "skip" is
  // the skip affordance. Both ride the SAME submit lock / phase machine as a
  // selection so first-answer-wins and the error arms are shared, not forked.
  async function answer(selection: number | number[] | string | "skip") {
    if (submitLock.current) return;
    submitLock.current = true;
    setPhaseAndRef("locked");
    setError(null);

    const isSkip = selection === "skip";
    const isText = typeof selection === "string" && !isSkip;
    const isMulti = Array.isArray(selection);
    const scalar = isMulti || isSkip || isText ? undefined : (selection as number);
    const set = isMulti ? (selection as number[]) : undefined;
    const text = isText ? (selection as string) : undefined;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const promise = (async () => {
      try {
        // QT-3: the student clicked/selected PRESENTED slots; the wire (and
        // session_answers) stay canonical, so translate before POST. The RPC
        // keeps validating each canonical index against the real options.
        // QT-1: multi sets are normalized (sorted+distinct) client-side to
        // mirror the RPC's canonical form.
        const plan = optionPlanFor(question);
        const wire = isMulti
          ? [...new Set(set!.map((i) => (plan ? (toCanonical(i, plan) ?? i) : i)))].sort((a, b) => a - b)
          : isMulti || isSkip || isText
            ? undefined
            : (plan ? (toCanonical(scalar!, plan) ?? scalar!) : scalar!);
        // Skip and short_text carry no option index at all — the AnswerSchema
        // arm is shape-exclusivity, so sending a stray index alongside either
        // would 400.
        const reqBody: Record<string, unknown> = isSkip
          ? { questionId: question.id, skipped: true }
          : isText
            ? { questionId: question.id, answerText: text }
            : isMulti
              ? { questionId: question.id, selectedIndices: wire }
              : { questionId: question.id, selectedIndex: wire };
        const res = await fetch(`/api/sessions/${sessionId}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(reqBody),
          signal: controller.signal,
        });
        // Strictly parse the body; a non-JSON 200 must NOT render "Incorrect"
        // for a correct answer (the server recorded the truth). If a 200 body
        // has no usable shape, surface an error instead of fabricating feedback.
        let body: Record<string, unknown> = {};
        if (res.ok || res.status === 409 || res.status === 403) {
          body = await res.json().catch(() => ({}));
        }

        // Shape-validate the SUCCESS body: practice requires `isCorrect:boolean`;
        // assessment 200 is a KEYLESS ack (`recorded:true`, no correctness). If
        // neither shape matches, the response is malformed — do NOT fabricate.
        const isPracticeAck = isPractice && typeof body.isCorrect === "boolean";
        const isAssessmentAck = !isPractice && body.recorded === true;
        if (res.ok && !isPracticeAck && !isAssessmentAck) {
          setError(tCommon("errorGeneric"));
          setPhaseAndRef("question");
          return;
        }

        if (res.status === 409 && body.error === "already_answered") {
          // Assessment re-answer (e.g. resume racing an in-flight answer):
          // render answered state from the selection only — the replay
          // carries NO correctness pre-reveal (keyless, PLAN v4 §4).
          setAnswers((prev) => ({
            ...prev,
            [question.id]: {
              ...(isSkip
                ? { skipped: true }
                : isText
                  ? { answerText: text }
                  : isMulti
                    ? { selectedIndices: set }
                    : { selectedIndex: scalar }),
              isCorrect: isPractice ? Boolean(body.isCorrect) : false,
            },
          }));
          setPendingMulti([]);
          setPhaseAndRef("feedback");
          return;
        }

        if (res.status === 403 && body.error === "time_expired") {
          // Server authoritative — the timer expired server-side. If the
          // client is already in timeUp (handleTimeUp is awaiting us), do NOT
          // re-enter timeUp / re-submit — just let handleTimeUp's own submit
          // run after this promise resolves. Otherwise (answer raced the
          // deadline without the countdown firing), enter timeUp + submit.
          const alreadyTimeUp = phaseRef.current === "timeUp";
          setPhaseAndRef("timeUp");
          if (!alreadyTimeUp) {
            await submitNow();
          }
          return;
        }

        if (res.status === 409 && body.error === "session_not_active") {
          // Mirror the 403 time_expired pattern: the server is authoritative.
          // GET the real status and branch (PLAN_PHASE7 §2):
          //  - paused → 'question' (recoverable — the face pipeline will
          //    blink-recover; the answer can be re-tried).
          //  - flagged → stay 'timeUp' when alreadyTimeUp (the flagged overlay
          //    must not be replaced by a dead-end); else 'question' + overlay.
          //  - completed/gone → 'dead'.
          const alreadyTimeUp = phaseRef.current === "timeUp";
          let realStatus: string | undefined;
          try {
            const statusRes = await fetch(`/api/sessions/${sessionId}`, { method: "GET" });
            realStatus = (await statusRes.json().catch(() => ({}))).status;
          } catch {
            // network — fall through to the conservative branch below
          }
          if (realStatus === "paused") {
            setError(t("toast.sessionPaused"));
            setPhaseAndRef("question");
            // Mirror the server truth into the face pipeline (audit fix): the
            // pause may have originated in another tab or raced the local
            // pause POST, leaving this client's pipeline `ready` with NO
            // overlay and NO Recover button — the student would sit on a
            // live-looking quiz that refuses every answer. pauseLocally is a
            // no-op unless the pipeline really is `ready`, so a pipeline that
            // already mirrored the pause is untouched.
            pipeline.pauseLocally("face");
            return;
          }
          if (realStatus === "flagged") {
            if (alreadyTimeUp) {
              // Stay in timeUp; the flagged overlay + Retry-submit stay visible.
              setError(t("toast.sessionFlagged"));
              setPhaseAndRef("timeUp");
            } else {
              setError(t("toast.sessionFlagged"));
              setPhaseAndRef("question");
            }
            return;
          }
          if (realStatus === "completed") {
            setPhaseAndRef("dead");
            return;
          }
          // Unknown/gone (the status GET failed, or returned no `status`).
          //
          // audit-3 adversarial review: this is a TRANSIENT-FAILURE path, not a
          // terminal verdict — the GET can fail on a network blip even though
          // the session is alive and still holding unsent answers. Since `dead`
          // is now terminal for both the countdown and handleTimeUp
          // (R2-SESS-F2), routing here would strand an active session with NO
          // submit control. Route to `timeUp` instead, which renders the
          // Retry-submit affordance; `dead` stays reserved for the explicit
          // terminal signals (the 404 reset above, and `completed`).
          setError(t("toast.sessionInactive"));
          setPhaseAndRef("timeUp");
          return;
        }

        // D-F1 (High): the quiz was closed (or the student removed) mid-session.
        // Do NOT dead-end — `submit_session` is deliberately permissive for
        // active/paused sessions, so the earned evidence must still be
        // submitted. answer() still holds submitLock until its finally, so the
        // submit is handed off on a macrotask (the SAME reason the
        // quiz_window_closed branch below defers). A failed submit lands in
        // timeUp with the Retry-submit control — never a silent dead screen.
        if (res.status === 409 && body.error === "quiz_not_live") {
          const alreadyTimeUp = phaseRef.current === "timeUp";
          setError(t("toast.quizUnavailable"));
          setPhaseAndRef("timeUp");
          if (!alreadyTimeUp) {
            setTimeout(() => void submitNow(), 0);
          }
          return;
        }

        // QC-3: closes_at passed mid-session — answers hard-stop but submit
        // stays open (submit-only grace). Enter timeUp (Retry-submit UI).
        // NOTE: an inline submitNow() here would no-op — answer() still holds
        // submitLock until its finally (same reason the 403 time_expired
        // branch relies on handleTimeUp's await-then-submit). The deferred
        // hand-off below fires AFTER the lock is released; for timed quizzes
        // the countdown's handleTimeUp path covers it instead.
        if (res.status === 409 && body.error === "quiz_window_closed") {
          const alreadyTimeUp = phaseRef.current === "timeUp";
          setPhaseAndRef("timeUp");
          if (!alreadyTimeUp) {
            setError(t("toast.quizWindowClosed"));
            setTimeout(() => void submitNow(), 0);
          }
          return;
        }

        if (res.status === 404) {
          // D13 — the session was reset by a lecturer mid-flight (or is
          // otherwise gone). Terminal dead screen, no retry, no re-submit.
          setError(t("toast.resetDead"));
          setPhaseAndRef("dead");
          return;
        }

        if (res.status === 401) {
          // audit-1 P1-12: auth session expired mid-exam. Stash the unsent
          // selection, then bounce through login and BACK to this exact URL;
          // the remount re-seeds recorded answers + restores the draft.
          // n28: carry the payload SHAPE — a multi set, a typed short_text, a
          // skip, or the single scalar — so every answer type survives the
          // login bounce (the old stash carried indices only).
          stashUnsentAnswer(sessionId, {
            questionId: question.id,
            ...(isMulti
              ? { selectedIndices: set }
              : isSkip
                ? { skipped: true }
                : isText
                  ? { answerText: text }
                  : { selectedIndex: scalar }),
          });
          setError(tAuth("sessionExpired"));
          setTimeout(() => {
            // router.push (not location.assign): the login hand-off stays in
            // the SPA, and the play page remounts fresh on the way back.
            router.push(
              `/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`,
            );
          }, 800);
          return;
        }

        if (!res.ok) {
          setError(
            typeof body.message === "string"
              ? body.message
              : typeof body.error === "string"
                ? body.error
                : tCommon("errorGeneric"),
          );
          setPhaseAndRef("question");
          return;
        }

        // QT-3: practice feedback carries the CANONICAL correct index/indices;
        // the state space (and rendering) is presented — translate back.
        const rawCorrect = body.correctIndex as number | undefined;
        const presentedCorrect =
          rawCorrect === undefined
            ? undefined
            : plan
              ? (toPresented(rawCorrect, plan) ?? rawCorrect)
              : rawCorrect;
        // QT-1: the correct SET for multi rows, element-wise.
        const rawCorrectSet = body.correctIndices as number[] | undefined;
        const presentedCorrectSet = Array.isArray(rawCorrectSet)
          ? rawCorrectSet.map((i) => (plan ? (toPresented(i, plan) ?? i) : i))
          : undefined;

        setAnswers((prev) => ({
          ...prev,
          [question.id]: {
            // v4.9: the committed shape mirrors what was sent — a skipped row
            // carries ONLY `skipped` (so the card renders the Skipped chip
            // rather than a red X for is_correct:false), and a short_text row
            // carries its text so a re-render/resume echoes it back.
            ...(isSkip
              ? { skipped: true }
              : isText
                ? { answerText: text }
                : isMulti
                  ? { selectedIndices: set }
                  : { selectedIndex: scalar }),
            isCorrect: isPractice
              ? Boolean(body.isCorrect)
              : false, // assessment: keyless ack — neutral "answered" state
            ...(presentedCorrect !== undefined ? { correctIndex: presentedCorrect } : {}),
            ...(presentedCorrectSet ? { correctIndices: presentedCorrectSet } : {}),
            ...(body.explanation !== undefined ? { explanation: body.explanation as string } : {}),
          },
        }));
        setPendingTextByQuestion((prev) => {
          if (!isText) return prev;
          const next = { ...prev };
          delete next[question.id];
          return next;
        });
        setPendingMulti([]);
        bumpPracticeAttemptsForCurrentQuestion();
        setPhaseAndRef("feedback");
        // AX-3: confirm the commit by its VISIBLE label (on-screen option
        // numerals, presented space — same number the student clicked), via
        // the polite announcer. Multi commits read the count instead of a
        // letter-per-option list. n21: skip/short_text answers carry NO scalar
        // (`scalar` is undefined by construction) — reading `scalar! + 1`
        // there announced "Answer NaN confirmed", so both use the label-free
        // key instead.
        setAnswerAnnouncement(
          isMulti
            ? t("hud.answerSetConfirmed", { count: set!.length })
            : isSkip || isText
              ? t("hud.answerRecorded")
              : t("hud.answerConfirmed", { label: scalar! + 1 }),
        );
        // Haptic (plan W3): practice commits only — no per-commit buzz in
        // recorded assessments.
        if (isPractice) haptic(HAPTIC.commit);
      } catch (err) {
        // Abort/network error → surface a retry (endpoints are idempotent).
        if ((err as Error)?.name === "AbortError") {
          setError(t("toast.recordTimeout"));
        } else {
          setError(t("toast.recordError"));
        }
        setPhaseAndRef("question");
      } finally {
        submitLock.current = false;
        clearTimeout(timeout);
      }
    })();

    inFlightAnswer.current = promise;
    await promise;
    inFlightAnswer.current = null;
  }

  async function submitNow() {
    // Guard against a double-submit (double-click Finish, or a timeUp racing a
    // manual submit). The first caller owns the POST; a second caller bails.
    if (submitLock.current) return;
    submitLock.current = true;
    setPhaseAndRef("submitting");
    setError(null);
    setLastSubmitFailed(false);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(`/api/sessions/${sessionId}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
      // Strictly parse the body; a non-JSON 200 (proxy/error page) must NOT be
      // silently treated as `{}` and render a misleading score.
      let body: Record<string, unknown> = {};
      if (res.ok || res.status === 409) {
        body = await res.json().catch(() => ({}));
      }

      if (res.status === 409 && body.error === "already_submitted") {
        // Terminal success — render the end state from the payload. For a
        // hidden assessment the RPC returns score:null; render the "awaiting
        // release" submitted card (no fabricated 0/N).
        setResult({
          score: typeof body.score === "number" ? body.score : null,
          total: typeof body.total === "number" ? body.total : questions.length,
        });
        setLastSubmitFailed(false);
        setPhaseAndRef("submitted");
        router.refresh();
        return;
      }

      if (res.status === 409 && body.error === "session_not_active") {
        // Submit from `flagged` → 409 (lecturer decision precedes score
        // finalization). Per PLAN_PHASE7 §2: if already timeUp, STAY timeUp
        // (Retry-submit + flagged overlay; the flagged poll survives timeUp);
        // else → 'question' + overlay.
        if (phaseRef.current === "timeUp") {
          setError(t("toast.sessionFlaggedLecturer"));
          setPhaseAndRef("timeUp");
        } else {
          setError(t("toast.sessionFlaggedLecturer"));
          setPhaseAndRef("question");
        }
        return;
      }

      if (res.status === 404) {
        // D13 — the session was reset by a lecturer mid-flight. Terminal dead
        // screen, no retry, no re-submit.
        setError(t("toast.resetDead"));
        setPhaseAndRef("dead");
        return;
      }

      if (res.status === 401) {
        // audit-1 P1-12: expired auth mid-submit — every recorded answer is
        // already server-side; re-auth and come straight back to the result.
        setError(tAuth("sessionExpired"));
        setTimeout(() => {
          // See the answer-path comment: SPA hand-off, fresh remount back.
          router.push(
            `/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`,
          );
        }, 800);
        return;
      }

      if (!res.ok) {
        setError(
          typeof body.message === "string"
            ? body.message
            : typeof body.error === "string"
              ? body.error
              : tCommon("errorGeneric"),
        );
        setLastSubmitFailed(true);
        setPhaseAndRef(phaseRef.current === "timeUp" ? "timeUp" : "question");
        return;
      }

      // Shape-validate the SUCCESS body: score may be a number (revealed) OR
      // null (assessment awaiting release); total defaults to question count.
      if (body.session == null || !("score" in body)) {
        setError(tCommon("errorGeneric"));
        setLastSubmitFailed(true);
        setPhaseAndRef(phaseRef.current === "timeUp" ? "timeUp" : "question");
        return;
      }

      setResult({
        score: typeof body.score === "number" ? body.score : null,
        total: typeof body.total === "number" ? body.total : questions.length,
      });
      setPhaseAndRef("submitted");
      // Render the end state immediately (above) THEN refresh to reconcile
      // with the DB (single source of truth when it lands).
      router.refresh();
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        setError(t("toast.submitTimeout"));
      } else {
        setError(t("toast.submitError"));
      }
      setLastSubmitFailed(true);
      // phaseRef, not the render closure: a timeUp auto-submit that failed must
      // stay timeUp (Retry-submit reachable; the remainingMs guard terminates).
      setPhaseAndRef(phaseRef.current === "timeUp" ? "timeUp" : "question");
    } finally {
      submitLock.current = false;
      clearTimeout(timeout);
    }
  }

  /**
   * SQ-3: practice "Try again" from the inline end state — start a REAL fresh
   * attempt and route into it. The start RPC's resume select only matches
   * active/paused sessions (0032), so after a completed practice attempt this
   * always returns a brand-new session id. Mirrors student-quizzes-client
   * handleStart's status mapping; on degraded states (window closed, network)
   * fall back to the quiz list — the button must never dead-end silently.
   */
  async function handleTryAgain() {
    if (retryLock.current) return;
    retryLock.current = true;
    setRetrying(true);
    // A fresh practice attempt starts with a clean oracle slate.
    try {
      clearPracticeAttempts(window.localStorage, quiz.id);
    } catch {
      // Storage unavailable — the counters simply persist.
    }
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quizId: quiz.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.session?.id) {
        router.push(`/play/${body.session.id}`);
        return;
      }
      if (res.status === 409 && body.error === "already_attempted" && body.session_id) {
        router.push(`/play/${body.session_id}`);
        return;
      }
      router.push("/student/quizzes");
    } catch {
      router.push("/student/quizzes");
    } finally {
      retryLock.current = false;
      setRetrying(false);
    }
  }

  function goNext() {
    // Phase guard (P6): the Next button only renders in `feedback`, so this is
    // behavior-preserving for clicks but blocks a stale palm-next frame from
    // flipping `timeUp`/`submitting` back to `question`.
    if (phase !== "feedback") return;
    // SQ-3: advancing into an all-answered state re-creates the stranded
    // resume dead-end (no actionable button on an answered question) — the
    // only correct action is submit, so the feedback button acts as Finish.
    if (allAnswered || index + 1 >= questions.length) {
      void submitNow();
      return;
    }
    setIndex((i) => i + 1);
    setPhaseAndRef("question");
    setError(null);
    setNotice(null);
  }

  // ── Render ──────────────────────────────────────────────────────
  // Defensive: the server guards against 0 questions, but a partial/broken RSC
  // payload must not crash the client (question would be undefined). Kept
  // after all hooks (rules-of-hooks).
  if (!question) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 p-4 text-sm font-bold text-destructive" role="alert">
          {t("toast.noQuestions")}
        </p>
      </div>
    );
  }

  if (phase === "submitted" && result) {
    const pct =
      result.score != null && result.total != null && result.total > 0
        ? Math.round((result.score / result.total) * 100)
        : 0;
    return (
      <div className="mx-auto max-w-2xl px-4 py-6 sm:py-12">
        <div className="rounded-[28px] border-[3px] border-border bg-card p-8 text-center shadow-[var(--shadow-clay)] md:p-10" role="status">
          <p className="text-sm font-extrabold uppercase tracking-wide text-muted-foreground">
            {isPractice ? t("end.practiceTitle") : result.score != null ? t("end.assessmentTitle") : t("end.submittedTitle")}
          </p>
          <h1 className="mt-1 font-heading text-2xl font-semibold [text-wrap:balance]">{quiz.title}</h1>
          {submissionReason === "time_up" && (
            <div className="mx-auto mt-3 inline-flex items-center gap-2 rounded-full border-[2px] border-amber-300 bg-amber-50 px-4 py-1.5 text-xs font-bold text-amber-800" role="status">
              ⏱️ {tCommon("timeExpired")}
            </div>
          )}
          {result.score != null ? (
            <>
              <p className="mt-6 font-heading text-6xl font-bold text-primary">
                {result.score}
                <span className="text-3xl text-muted-foreground"> / {result.total}</span>
              </p>
              <p className="mt-1 text-sm font-extrabold text-muted-foreground">{t("end.pctCorrect", { pct })}</p>
            </>
          ) : (
            <div className="mx-auto mt-6 max-w-md rounded-2xl border-[3px] border-border bg-muted/50 px-5 py-4" role="status">
              <p className="font-heading text-base font-semibold">
                {t("end.resultsPending")}
              </p>
            </div>
          )}
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button variant="outline" size="lg" onClick={() => router.push("/student/quizzes")}>
              {t("end.backToQuizzes")}
            </Button>
            {isPractice && (
              <Button size="lg" onClick={() => void handleTryAgain()} disabled={retrying}>
                {retrying ? t("end.tryAgainStarting") : t("end.tryAgain")}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Terminal dead-end: session no longer active / quiz no longer available.
  if (phase === "dead") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6 sm:py-12">
        <div className="rounded-[28px] border-[3px] border-destructive/40 bg-card p-8 text-center shadow-[var(--shadow-clay)] md:p-10" role="alert">
          <h1 className="font-heading text-2xl font-semibold">{quiz.title}</h1>
          <p className="mt-1 text-sm font-extrabold uppercase tracking-wide text-muted-foreground">
            {isPractice ? tCommon("practice") : tCommon("assessment")}
          </p>
          <p className="mx-auto mt-6 max-w-md rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive">
            {error ?? tCommon("errorGeneric")}
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Button variant="outline" size="lg" onClick={() => router.push("/student/quizzes")}>
              {t("end.backToQuizzes")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  /* Plan W3 8-state matrix, shared by both containers (exactly one renders):
       question+single unanswered → EMPTY (tap-option is the primary action);
       multi → Confirm answer (native disabled at 0 — mechanism unchanged) +
       aria-hidden count pill (sr-only multiSelectedCount span survives);
       feedback → Next/Finish (exact names); submitting/locked → disabled
       pre-pressed; timeUp OR failed submit → destructive-tinted Retry-submit;
       submitted/dead → full-screen takeover (no bar — earlier returns). */
  const submitFailed = lastSubmitFailed && (phase === "timeUp" || phase === "question");
  // True when any action-zone branch renders (multi confirm / feedback /
  // submitting / timeUp-or-failed retry / locked). State 1 (single
  // unanswered) renders nothing → the mobile bar's chrome collapses.
  // R15: skip is offered in the QUESTION phase only — never in locked /
  // feedback / submitting / terminal states, where the answer is already
  // decided (a skip is itself an answer, so offering it after one would
  // invite a 409).
  const canSkip = phase === "question" && !answered;
  const hasActionButtons =
    (phase === "question" && question.type === "multi_select" && !answered) ||
    // v4.9: a short_text question shows Confirm (disabled until non-blank),
    // and every type shows Skip while unanswered — without these arms the
    // buttons float outside the clay card on mobile and a previously-empty
    // question state becomes non-empty without the chrome to hold it.
    (phase === "question" && !answered && (question.type === "short_text" || canSkip)) ||
    phase === "feedback" ||
    phase === "submitting" ||
    phase === "timeUp" ||
    submitFailed ||
    phase === "locked";
  const actionZoneButtons = (
    <>
      {phase === "question" && question.type === "multi_select" && !answered && (
        <>
          {/* Pending-selection count (pre-existing SR channel; kept
              inside the live container which now announces it). */}
          <span className="sr-only">
            {t("multiSelectedCount", { count: pendingMulti.length })}
          </span>
          <span
            aria-hidden="true"
            className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-extrabold tabular-nums text-primary"
          >
            {pendingMulti.length}
          </span>
          {/* Palm-commit hint (QT-1 gesture amendment): holds toggle
              options, an open palm commits — always visible while
              gesture-active so the affordance is discoverable. Plain
              span: the live container above already announces it. */}
          {gestureActive && (
            <span className="text-sm font-bold text-muted-foreground max-sm:text-center">
              {t("multiPalmCommitHint")}
            </span>
          )}
          <Button
            size="lg"
            disabled={pendingMulti.length === 0}
            onClick={() => void answer([...pendingMulti])}
          >
            {t("multiConfirm")}
          </Button>
        </>
      )}
      {phase === "question" && question.type === "short_text" && !answered && (
        <>
          <Button
            size="lg"
            disabled={pendingText.trim().length === 0}
            onClick={() => void answer(pendingText.trim())}
          >
            {t("shortText.confirm")}
          </Button>
        </>
      )}
      {phase === "question" && !answered && canSkip && (
        <Button
          size="lg"
          variant="outline"
          data-testid="skip-question"
          onClick={() => void answer("skip")}
        >
          {t("skip.action")}
        </Button>
      )}
      {phase === "feedback" && (
        <div className={`gap-3 ${isWide ? "flex items-center" : "flex w-full flex-col items-stretch"}`}>
          {gestureActive && question.options.length < MAX_ANSWER_FINGERS && (
            // Plain span — inside the live container (no nested region).
            <span className="text-sm font-bold text-muted-foreground max-sm:text-center">
              {t("feedback.orHold")}
            </span>
          )}
          <Button
            size="lg"
            onClick={goNext}
            ref={nextButtonRef}
          >
            {allAnswered || index + 1 >= questions.length
              ? t("feedback.finish")
              : t("feedback.next")}
          </Button>
        </div>
      )}
      {phase === "submitting" && (
        <Button size="lg" disabled>{t("feedback.submitting")}</Button>
      )}
      {(phase === "timeUp" || submitFailed) && (
        <Button size="lg" variant="destructive" onClick={() => void submitNow()}>
          {t("feedback.retrySubmit")}
        </Button>
      )}
      {phase === "locked" && (
        <Button size="lg" disabled>{t("feedback.recording")}</Button>
      )}
    </>
  );

  return (
    // Mobile plan W3: min-h-dvh (100vh overshoots behind mobile browser
    // chrome). Overscroll suppression is route-scoped on the scroll root
    // via html:has(.play-stage) in globals.css.
    <div className="play-stage mx-auto w-full max-w-[1600px] min-h-dvh px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
      {/* Persistent video node for the FACE tracker (invisible background node) */}
      <video
        ref={faceTracker.videoRef}
        className="fixed top-0 left-0 size-1 opacity-0 pointer-events-none -z-50"
        autoPlay
        playsInline
        muted
        aria-hidden
      />

      <FaceVerifier
        status={faceStatus}
        phase={phase}
        enrolled={face?.enrolled ?? false}
        consentGiven={face?.consentGiven ?? false}
        remainingMs={remainingMs}
        pausedReason={pipeline.pausedReason}
        challengeSide={pipeline.challengeSide}
        challengeFailed={pipeline.challengeFailed}
        gateAttempt={pipeline.gateAttempt}
        stream={faceTracker.stream ?? null}
        quizTitle={quiz.title}
        resume={
          initialAnswers.length > 0
            ? { answered: initialAnswers.length, total: questions.length }
            : null
        }
        onBegin={() => {
          // Integrity hardening: arm + enter fullscreen INSIDE the Begin
          // click (a user gesture — requestFullscreen rejects outside one).
          // The guard no-ops when disabled (practice / env off / iOS Safari).
          setFullscreenArmed(true);
          fullscreenGuard.request();
          void pipeline.beginGate();
        }}
        onConsent={() => {
          void fetch("/api/face/consent", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ consent: true }),
          })
            .then((r) => {
              if (r.ok) {
                pipeline.markConsentGiven();
              } else {
                // A failed consent POST used to leave the gate's local
                // checkbox checked with Begin enabled — clicking it then
                // bounced off the server's consent_required with no visible
                // reason. Un-check so the student sees the consent panel
                // again and can retry deliberately.
                setError(t("toast.consentFailed"));
              }
            })
            .catch(() => {
              setError(t("toast.consentFailed"));
            });
        }}
        onRecover={() => {
          // Recovery click is a valid user gesture: re-enter fullscreen (the
          // Esc exit consumed the old one; no auto re-request is possible).
          fullscreenGuard.request();
          void pipeline.runRecovery();
        }}
        onCheckAgain={() => {
          void pipeline.checkAgain();
        }}
      >
        <GestureLayer
          // FC-1: the quiz-level flag (draft-frozen, so it cannot change
          // mid-live). Quiz flag wins over the user setting by construction:
          // it gates the layer itself rather than a preference.
          enabled={quiz.gesturesEnabled}
          // R6/B6-8: ordering/short_text must never ARM the AnswerPad. A
          // short_text question has no option to point at, so a held finger
          // would latch nothing while still suppressing the palm-next path.
          // U-65 pins the predicate itself (src/lib/sessions/gesture-arming).
          hasFingerInput={TYPE_HAS_FINGER_INPUT.has(question.type)}
          mode={quiz.mode}
          optionCount={question.options.length}
          questionId={question.id}
          // `answered` is the AnswerState record (or undefined) — the
          // predicate takes the truthiness the old inline `!answered` used.
          armed={isAnswerPadArmed({ phase, answered: Boolean(answered), type: question.type })}
          nextArmed={phase === "feedback"}
          answerMode={question.type === "multi_select" ? "multi" : "single"}
          hasMultiQuestions={hasMultiQuestions}
          blockInput={BLOCK_INPUT_PHASES.includes(phase) || lastSubmitFailed || faceStatus === "paused" || faceStatus === "recovering" || faceStatus === "flagged"}
          sessionPaused={faceStatus === "paused" || faceStatus === "recovering" || faceStatus === "flagged"}
          faceStatus={faceStatus}
          onPause={() => {
            void pipeline.handLossPause();
          }}
          onSelect={(i) => selectOption(i)}
          onToggleSelect={(i) => selectOption(i)}
          onCommit={() => {
            // Palm-commit mirrors the Confirm button (disabled at zero → a
            // notice instead of a silent no-op).
            if (submitLock.current || !question || answers[question.id]) return;
            if (pendingMulti.length === 0) {
              setNotice(t("multiSelectFirst"));
              return;
            }
            setNotice(null);
            void answer([...pendingMulti]);
          }}
          onNext={() => goNext()}
          onHoldProgress={setHoldProgress}
          onWarnChange={(warning) => {
            setHandWarn(warning);
            // Announce the transition once; clear the message when resolved
            // so a re-warn re-announces (node content must change to fire).
            setWarnAnnouncement(warning ? tVision("keepHandVisible") : null);
          }}
          onStatusChange={(s) => setGestureActive(s === "active")}
        >
          <div className={`flex flex-col gap-6 ${isWide ? "" : "pb-[calc(152px+var(--safe-bottom))]"}`}>
            {isWide ? (
              /* Desktop: title-in-flow + sidebar HUD (unchanged). */
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="min-w-0">
                  <span className={`inline-block rounded-full border-[3px] px-3.5 py-1 text-xs font-extrabold ${
                    isPractice
                      ? "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-300"
                      : "border-accent/40 bg-blue-100 text-accent dark:border-accent/40 dark:bg-blue-500/15 dark:text-blue-300"
                  }`}>
                    {isPractice ? tCommon("practice") : tCommon("assessment")}
                  </span>
                  <h1 className="mt-2 font-heading text-2xl font-semibold [text-wrap:balance]">{quiz.title}</h1>
                </div>
                <ProgressHud
                  current={index + 1}
                  total={questions.length}
                  remainingMs={remainingMs}
                  camStatus={
                    quiz.mode !== "assessment" || faceStatus === "off" || faceStatus === "exempt" || faceStatus === "unavailable"
                      ? null
                      : faceStatus === "ready"
                      ? "aligned"
                      : "reposition"
                  }
                />
              </div>
            ) : (
              /* Mobile (plan W3 + polish W2 C2): sticky compact header —
                 safe-top padded, opaque. The quiz title appears ONCE in the
                 gate sheet, never above the question flow. Row 1: an "info"
                 trigger (opens the quiz-info sheet: mode + time limit + cam
                 status) + counter + timer chip (verbatim role="timer"
                 markup, FIRST span.tabular-nums in DOM order — e10
                 contract, so the sheet is mounted outside the header).
                 Row 2: progress bar. The gesture PIP anchors top-right
                 below this header (gesture-layer fixed positioning). */
              <header className="sticky top-0 z-20 -mx-4 space-y-2 border-b-[3px] border-border bg-background px-4 pb-2 pt-[calc(var(--safe-top)+0.5rem)] sm:-mx-6 sm:px-6">
                {/* Heading-order anchor: the title lives visually in the gate
                    (assessments), but practice skips the gate entirely —
                    every question flow keeps an h1 (R3-A S1). */}
                <h1 className="sr-only">{quiz.title}</h1>
                <div className="flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 gap-1 rounded-full border-[3px] border-border bg-card px-2.5 py-1 text-label font-extrabold uppercase tracking-[0.04em] text-muted-foreground"
                    aria-label={t("infoOpen")}
                    aria-expanded={infoOpen}
                    onClick={() => setInfoOpen(true)}
                  >
                    <Info className="size-3.5" aria-hidden="true" />
                    {t("infoOpen")}
                  </Button>
                  <ProgressHud
                    variant="strip"
                    current={index + 1}
                    total={questions.length}
                    remainingMs={remainingMs}
                    camStatus={null}
                  />
                </div>
              </header>
            )}

            {/* Polish round (W2 C2): the mode pill + cam dot fold into a
                tap-to-open "quiz info" sheet on phones. Mounted OUTSIDE the
                header row so the timer chip stays the FIRST span.tabular-nums
                in DOM order (e10 contract). */}
            {!isWide && (
              <ResponsiveModal open={infoOpen} onOpenChange={setInfoOpen}>
                <ResponsiveModalContent className="sm:max-w-sm">
                  <ResponsiveModalHeader>
                    <ResponsiveModalTitle className="font-heading text-lg">
                      {t("info.title")}
                    </ResponsiveModalTitle>
                    <ResponsiveModalDescription>
                      {quiz.title}
                    </ResponsiveModalDescription>
                  </ResponsiveModalHeader>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3 rounded-2xl border-[3px] border-border bg-muted/60 px-4 py-3">
                      <span className="font-sans text-label font-extrabold uppercase tracking-[0.04em] text-muted-foreground">
                        {t("info.mode")}
                      </span>
                      <span className={`rounded-full border-[3px] px-3 py-0.5 font-sans text-label font-extrabold uppercase tracking-[0.04em] ${
                        isPractice
                          ? "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-300"
                          : "border-accent/40 bg-blue-100 text-accent dark:border-accent/40 dark:bg-blue-500/15 dark:text-blue-300"
                      }`}>
                        {isPractice ? tCommon("practice") : tCommon("assessment")}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 rounded-2xl border-[3px] border-border bg-muted/60 px-4 py-3">
                      <span className="font-sans text-label font-extrabold uppercase tracking-[0.04em] text-muted-foreground">
                        {t("info.timeLimit")}
                      </span>
                      <span className="font-heading text-base font-bold tabular-nums">
                        {quiz.timeLimitSec != null
                          ? formatTimeLimit(quiz.timeLimitSec)
                          : t("hud.noTimeLimit")}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 rounded-2xl border-[3px] border-border bg-muted/60 px-4 py-3">
                      <span className="font-sans text-label font-extrabold uppercase tracking-[0.04em] text-muted-foreground">
                        {t("info.camStatus")}
                      </span>
                      <span className="flex items-center gap-1.5 font-heading text-base font-bold">
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${
                            camStatusForInfo === "aligned"
                              ? "bg-emerald-500"
                              : camStatusForInfo === "reposition"
                              ? "bg-amber-400 animate-pulse"
                              : "bg-muted-foreground/40"
                          }`}
                          aria-hidden="true"
                        />
                        {camStatusForInfo === "aligned"
                          ? t("info.camAligned")
                          : camStatusForInfo === "reposition"
                          ? t("info.camReposition")
                          : t("info.camOff")}
                      </span>
                    </div>
                  </div>
                </ResponsiveModalContent>
              </ResponsiveModal>
            )}

            {isWide && (
              <div aria-live="polite">
                {error && (
                  <p className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive" role="alert">
                    {error}
                  </p>
                )}
                {notice && (
                  <p className="rounded-2xl border-[3px] border-amber-300 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800" role="status">
                    {notice}
                  </p>
                )}
              </div>
            )}

            {/* AX-3: discrete sr-only announcers. Polite channel carries timer
                milestones + answer confirmations; the assertive channel fires
                ONCE below 30s (separate node so a late polite message can
                never queue ahead of the urgent warning). */}
            <div className="sr-only" aria-live="polite" role="status">
              {milestoneAnnouncement}
              {answerAnnouncement}
              {warnAnnouncement}
            </div>
            <div className="sr-only" aria-live="assertive" role="alert">
              {assertiveAnnouncement}
            </div>

            <QuestionCard
              question={question}
              answer={answered}
              mode={quiz.mode}
              disabled={phase !== "question"}
              holdProgress={holdProgress}
              onSelect={selectOption}
              pendingMulti={pendingMulti}
              pendingText={pendingText}
              onTextChange={setPendingText}
              practiceAttempts={practiceAttempts}
            />

            {/* AX-3: the action zone announces its phase swaps (Recording →
                Submitting → Retry-submit) — the buttons unmount/mount, so a
                polite live region on the container is the only SR channel.
                The inner multi-count span is deliberately NOT itself a live
                region (no nested aria-live — a nested region would make some
                SR/VO combos announce both the inner and outer change).
                Plan W3 8-state matrix: the container STAYS MOUNTED in every
                non-terminal phase (state 1 renders it EMPTY — a re-inserted
                live region does not announce); on phones it is the fixed
                bottom action bar with full-width buttons and safe-area
                padding; error/notice render ABOVE it (outside the live
                region). */}
            {!isWide && (
              <div className="fixed inset-x-4 bottom-0 z-30 flex flex-col gap-2 pb-[max(0.75rem,var(--safe-bottom))] pt-2">
                {(error || notice) && (
                  <div aria-live="polite">
                    {error && (
                      <p className="rounded-2xl border-[3px] border-destructive/30 bg-card px-4 py-3 text-sm font-bold text-destructive" role="alert">
                        {error}
                      </p>
                    )}
                    {notice && (
                      <p className="rounded-2xl border-[3px] border-amber-300 bg-card px-4 py-3 text-sm font-bold text-amber-800 dark:border-amber-500/40 dark:text-amber-200" role="status">
                        {notice}
                      </p>
                    )}
                  </div>
                )}
                {/* Chrome collapses when state 1 leaves the container empty
                    (R2-B: a bordered empty box floating over the question is
                    dead space); the aria-live div itself stays mounted. */}
                <div
                  className={`flex flex-col items-stretch gap-2 transition-[padding] duration-200 [&_button]:w-full ${
                    hasActionButtons
                      ? "rounded-[22px] border-[3px] border-border bg-card p-3 shadow-[var(--shadow-clay)]"
                      : ""
                  }`}
                  aria-live="polite"
                >
                  {/* Hand-loss warn chip (polish W2 C4): mirrors GestureLayer's
                      warn state — visual status inside the action bar, not a
                      fourth floating layer. aria-hidden + text identical to
                      the sr-only announcer above (which is the sole live
                      channel — no nested live regions in this container). */}
                  {handWarn && (
                    <p
                      aria-hidden="true"
                      className="mx-auto flex w-fit items-center gap-2 rounded-full border-[3px] border-amber-400/70 bg-amber-50 px-3 py-1 text-xs font-extrabold tracking-wide text-amber-900 shadow-[0_2px_0_var(--border)] dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
                    >
                      <span className="size-2 shrink-0 animate-pulse rounded-full bg-amber-500 dark:bg-amber-400" aria-hidden />
                      {tVision("keepHandVisible")}
                    </p>
                  )}
                  {/* Multi status chip (plan W3 D6 + polish W2 C3): moved
                      INSIDE the action card so the fixed bottom area stays a
                      single layer. OUTSIDE the sr-only count span (which
                      remains the sole count channel — contract), aria-hidden. */}
                  {phase === "question" && question.type === "multi_select" && !answered && (
                    <p
                      aria-hidden="true"
                      className="mx-auto w-fit rounded-full bg-background px-3 py-1 text-center text-sm font-bold text-muted-foreground shadow-[0_2px_0_var(--border)]"
                    >
                      {t("multiStatusChip", { count: pendingMulti.length })}
                    </p>
                  )}
                  {actionZoneButtons}
                </div>
              </div>
            )}
            {isWide && (
              <div className="flex min-h-12 items-center justify-end" aria-live="polite">
                {actionZoneButtons}
              </div>
            )}
          </div>
        </GestureLayer>
      </FaceVerifier>
    </div>
  );
}

