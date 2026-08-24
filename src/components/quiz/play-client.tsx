"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { QuestionCard } from "@/components/quiz/question-card";
import { ProgressHud } from "@/components/quiz/progress-hud";
import { GestureLayer } from "@/components/vision/gesture-layer";
import { Button } from "@/components/ui/button";
import { MAX_ANSWER_FINGERS } from "@/lib/gestures/constants";
import type { HoldProgress } from "@/lib/gestures/types";
import { FaceVerifier } from "@/components/face/face-verifier";
import { useFacePipeline, type FacePipelinePhase } from "@/components/face/use-face-pipeline";
import { useFaceTracker } from "@/components/face/use-face-tracker";
import { useIntegrityAdvisories } from "@/components/face/use-integrity-advisories";
import { useIncidentRecorder } from "@/components/face/use-incident-recorder";
import { getFakeFaceTracker } from "@/lib/face/fake-seam";
import type { FaceStatus } from "@/lib/face/types";


type Question = {
  id: string;
  order_index: number;
  type: "mcq" | "true_false";
  prompt: string;
  options: string[];
  created_at: string;
};

type Quiz = {
  title: string;
  mode: "practice" | "assessment";
  timeLimitSec: number | null;
};

type SeedAnswer = {
  question_id: string;
  selected_index: number;
  is_correct: boolean | null;
};

export type AnswerState = {
  selectedIndex: number;
  isCorrect: boolean;
  correctIndex?: number;
  explanation?: string;
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
 * Robustness notes (PLAN_PHASE5 Â§2/Â§4):
 *  - `submitLock` guards against double-submits (released in `finally`).
 *  - The countdown is seeded server-side (`initialRemainingMs`) and decremented
 *    monotonically — never `Date.now()` re-reads, never paused mid-question,
 *    stopped at â‰¤0 or when untimed.
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
 */
export function PlayClient({
  sessionId,
  quiz,
  questions,
  initialIndex = 0,
  initialAnswers = [],
  initialRemainingMs = null,
  face,
}: {
  sessionId: string;
  quiz: Quiz;
  questions: Question[];
  initialIndex?: number;
  initialAnswers?: SeedAnswer[];
  initialRemainingMs?: number | null;
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

  const [index, setIndex] = useState(initialIndex < 0 ? 0 : initialIndex);
  const [answers, setAnswers] = useState<Record<string, AnswerState>>(() => {
    const seed: Record<string, AnswerState> = {};
    for (const a of initialAnswers) {
      seed[a.question_id] = {
        selectedIndex: a.selected_index,
        isCorrect: a.is_correct === true,
        seeded: true,
      };
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

  // Locks: one answer in flight at a time; no submit while answering.
  const submitLock = useRef(false);
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

  // ── Face pipeline (Phase 7) ─────────────────────────────────────
  // Availability is evaluated BEFORE enrollment/consent (boot failure →
  // 'unavailable' → passthrough regardless of enrolled/consentGiven).
  const faceTracker = useFaceTracker({
    enabled: quiz.mode === "assessment" && Boolean(face),
    onUnavailable: () => setFaceUnavailable(true),
  });

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
    enabled: quiz.mode === "assessment" && Boolean(face) && faceTracker.available,
    armed: faceStatus === "ready",
    tracker: faceTracker.trackerRef.current,
  });

  // ── Incident ring-buffer recorder (uploads ONLY on incidents) ──────
  // Skipped under the E2E fake seam — headless runs must not exercise a real
  // getUserMedia/MediaRecorder path the fake tracker doesn't cover.
  const isFakeFace =
    process.env.NODE_ENV !== "production" && getFakeFaceTracker() != null;
  useIncidentRecorder({
    sessionId,
    enabled: quiz.mode === "assessment" && Boolean(face) && !isFakeFace,
    status: faceStatus,
    phase,
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
  useEffect(() => {
    if (remainingMs === null) return;
    if (phase === "submitted" || phase === "timeUp") return;
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

  async function handleTimeUp() {
    if (phase === "submitted" || phase === "timeUp") return;
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
    void answer(optionIndex);
  }

  async function answer(optionIndex: number) {
    if (submitLock.current) return;
    submitLock.current = true;
    setPhaseAndRef("locked");
    setError(null);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const promise = (async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId: question.id, selectedIndex: optionIndex }),
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
          // render answered state from the selected index only — the replay
          // carries NO correctness pre-reveal (keyless, PLAN v4 §4).
          setAnswers((prev) => ({
            ...prev,
            [question.id]: {
              selectedIndex: optionIndex,
              isCorrect: isPractice ? Boolean(body.isCorrect) : false,
            },
          }));
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
          // Unknown/gone → dead (terminal).
          setError(t("toast.sessionInactive"));
          setPhaseAndRef("dead");
          return;
        }

        if (res.status === 409 && body.error === "quiz_not_live") {
          setError(t("toast.quizUnavailable"));
          setPhaseAndRef("dead");
          return;
        }

        if (res.status === 404) {
          // D13 — the session was reset by a lecturer mid-flight (or is
          // otherwise gone). Terminal dead screen, no retry, no re-submit.
          setError(t("toast.resetDead"));
          setPhaseAndRef("dead");
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

        setAnswers((prev) => ({
          ...prev,
          [question.id]: {
            selectedIndex: optionIndex,
            isCorrect: isPractice
              ? Boolean(body.isCorrect)
              : false, // assessment: keyless ack — neutral "answered" state
            ...(body.correctIndex !== undefined ? { correctIndex: body.correctIndex as number } : {}),
            ...(body.explanation !== undefined ? { explanation: body.explanation as string } : {}),
          },
        }));
        setPhaseAndRef("feedback");
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

      if (!res.ok) {
        setError(
          typeof body.message === "string"
            ? body.message
            : typeof body.error === "string"
              ? body.error
              : tCommon("errorGeneric"),
        );
        setPhaseAndRef(phaseRef.current === "timeUp" ? "timeUp" : "question");
        return;
      }

      // Shape-validate the SUCCESS body: score may be a number (revealed) OR
      // null (assessment awaiting release); total defaults to question count.
      if (body.session == null || !("score" in body)) {
        setError(tCommon("errorGeneric"));
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
      // phaseRef, not the render closure: a timeUp auto-submit that failed must
      // stay timeUp (Retry-submit reachable; the remainingMs guard terminates).
      setPhaseAndRef(phaseRef.current === "timeUp" ? "timeUp" : "question");
    } finally {
      submitLock.current = false;
      clearTimeout(timeout);
    }
  }

  function goNext() {
    // Phase guard (P6): the Next button only renders in `feedback`, so this is
    // behavior-preserving for clicks but blocks a stale palm-next frame from
    // flipping `timeUp`/`submitting` back to `question`.
    if (phase !== "feedback") return;
    if (index + 1 >= questions.length) {
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
      <div className="mx-auto max-w-2xl px-4 py-12">
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
              <Button size="lg" onClick={() => router.push("/student/quizzes")}>{t("end.tryAgain")}</Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Terminal dead-end: session no longer active / quiz no longer available.
  if (phase === "dead") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
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

  return (
    <div className="mx-auto w-full max-w-[1600px] min-h-[calc(100vh-3rem)] px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
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
        onBegin={() => {
          void pipeline.beginGate();
        }}
        onConsent={() => {
          void fetch("/api/face/consent", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ consent: true }),
          })
            .then((r) => {
              if (r.ok) pipeline.markConsentGiven();
            })
            .catch(() => {});
        }}
        onRecover={() => {
          void pipeline.runRecovery();
        }}
        onCheckAgain={() => {
          void pipeline.checkAgain();
        }}
      >
        <GestureLayer
          mode={quiz.mode}
          optionCount={question.options.length}
          questionId={question.id}
          armed={phase === "question" && !answered}
          nextArmed={phase === "feedback"}
          blockInput={BLOCK_INPUT_PHASES.includes(phase) || faceStatus === "paused" || faceStatus === "recovering" || faceStatus === "flagged"}
          sessionPaused={faceStatus === "paused" || faceStatus === "recovering" || faceStatus === "flagged"}
          faceStatus={faceStatus}
          onPause={() => {
            void pipeline.handLossPause();
          }}
          onSelect={(i) => selectOption(i)}
          onNext={() => goNext()}
          onHoldProgress={setHoldProgress}
          onStatusChange={(s) => setGestureActive(s === "active")}
        >
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0">
                <span className={`inline-block rounded-full border-[3px] px-3.5 py-1 text-xs font-extrabold ${
                  isPractice
                    ? "border-emerald-300 bg-emerald-100 text-emerald-800"
                    : "border-accent/40 bg-blue-100 text-accent"
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

            <QuestionCard
              question={question}
              answer={answered}
              mode={quiz.mode}
              disabled={phase !== "question"}
              holdProgress={holdProgress}
              onSelect={selectOption}
            />

            <div className="flex min-h-12 items-center justify-end">
              {phase === "feedback" && (
                <div className="flex items-center gap-3">
                  {gestureActive && question.options.length < MAX_ANSWER_FINGERS && (
                    <span className="text-sm font-bold text-muted-foreground" role="status">
                      {t("feedback.orHold")}
                    </span>
                  )}
                  <Button size="lg" onClick={goNext}>
                    {index + 1 >= questions.length ? t("feedback.finish") : t("feedback.next")}
                  </Button>
                </div>
              )}
              {phase === "submitting" && (
                <Button size="lg" disabled>{t("feedback.submitting")}</Button>
              )}
              {phase === "timeUp" && (
                <Button size="lg" onClick={() => void submitNow()}>{t("feedback.retrySubmit")}</Button>
              )}
              {phase === "locked" && (
                <Button size="lg" disabled>{t("feedback.recording")}</Button>
              )}
            </div>
          </div>
        </GestureLayer>
      </FaceVerifier>
    </div>
  );
}

