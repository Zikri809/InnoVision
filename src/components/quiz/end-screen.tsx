"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Lock, RotateCcw, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BotAvatar } from "@/components/bot/bot-avatar";
import { QuestionImage } from "@/components/media/question-image";
import { VList } from "virtua";
import { ScoreRing } from "@/components/quiz/score-ring";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import type { ResultsBreakdownRow } from "@/app/play/[sessionId]/page";

type Session = {
  id: string;
  quiz_id: string;
  student_id: string;
  mode: "practice" | "assessment";
  status: "active" | "paused" | "flagged" | "completed";
  started_at: string;
  submitted_at: string | null;
  score: number | null;
  last_activity_at: string;
};

type Quiz = {
  id: string;
  title: string;
  mode: "practice" | "assessment";
  status: "draft" | "live" | "closed";
  time_limit_sec: number | null;
  results_revealed_at?: string | null;
};

/** Praise line tiers — i18n keys `play.end.praisePerfect` etc. */
const PRAISE_KEYS = {
  perfect: "praisePerfect",
  strong: "praiseStrong",
  ok: "praiseOk",
  rough: "praiseRough",
} as const;

export function EndScreen({
  session,
  quiz,
  revealed,
  score,
  total,
  breakdown = [],
  initialPendingCount = 0,
}: {
  session: Session;
  quiz: Quiz;
  revealed: boolean;
  score: number | null;
  total: number;
  breakdown?: ResultsBreakdownRow[];
  /** v4.9: answers still awaiting AI marking (student_pending_count), read
   * server-side by the play RSC. The poll below refreshes it in the client —
   * it cannot be a callback prop, because a server component cannot pass a
   * function to a client component. */
  initialPendingCount?: number;
}) {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("play.end");
  const tCommon = useTranslations("common");
  const isPractice = session.mode === "practice";

  // L9/X2-6: the DENOMINATOR is the RESOLVED question count, not the raw
  // total. A pending answer has no mark yet, so dividing by `total` would
  // show a student 2/5 for a quiz where 3 answers are still being marked —
  // a score that reads as a failure rather than as "not finished yet".
  // Skipped rows count as resolved (they are a graded 0).
  // The live count: seeded from the RSC, then refreshed by the poll below.
  const [pendingCount, setPendingCount] = useState(initialPendingCount);
  const resolved = Math.max(0, total - pendingCount);
  // `resolved === 0` (every answer pending) has no meaningful percentage —
  // the original `total > 0` guard, narrowed to null so the UI renders a
  // neutral pending label instead of a false "0%". A stale pendingCount can
  // also push score/resolved past 100, hence the clamp.
  const pct =
    revealed && resolved > 0 && score != null
      ? Math.min(100, Math.round((score / resolved) * 100))
      : null;

  // R16/X2-7: the banner has TWO states and the poll runs in BOTH.
  //  (a) pendingCount > 0            → "answers are being marked"
  //  (b) pendingCount = 0, assessment, score null, not revealed
  //                                  → "marks finalised, waiting for release"
  // The poll must NOT stop at (b): the student's own marks resolving is not
  // the same event as the QUIZ being revealed (that needs the whole class,
  // via v_all_done or autoclose).
  const awaitingRelease =
    !isPractice && session.mode === "assessment" && pendingCount === 0 && score == null && !revealed;
  const showPendingBanner = !isPractice && (pendingCount > 0 || awaitingRelease);

  useEffect(() => {
    if (!showPendingBanner) return;
    const id = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/sessions/${session.id}`, { cache: "no-store" });
          if (!res.ok) return;
          const body = (await res.json()) as {
            pending_count?: unknown;
            status?: unknown;
            revealed?: unknown;
          };
          const next = typeof body.pending_count === "number" ? body.pending_count : null;
          // A failed/absent field must NOT be read as "zero pending" — that
          // would flip the banner to state (b) on a transient blip and tell
          // the student their marks are final when they are not.
          if (next !== null) setPendingCount(next);
          // n29: `revealed`/`score` are static RSC props, so this poll can
          // never observe them. The envelope's own fields can: once the
          // session is completed, nothing is pending and the results are
          // revealed, there is nothing left to poll for — stop, and refresh
          // so the RSC hands the EndScreen its now-revealed score.
          if (body.status === "completed" && next === 0 && body.revealed === true) {
            clearInterval(id);
            router.refresh();
          }
        } catch {
          // Transient network failure: keep the last known count and retry on
          // the next tick. The poll is advisory; the server is the truth.
        }
      })();
    }, 15_000);
    return () => clearInterval(id);
  }, [showPendingBanner, session.id, router]);

  // SQ-3: practice "Try Again" starts a REAL fresh attempt — POST /api/sessions
  // (rejoin semantics: a completed practice session never matches the RPC's
  // resume select, so this always returns a new session id) and route into it.
  // Mirrors student-quizzes-client handleStart's status mapping.
  const retryLock = useRef(false);
  const [retrying, setRetrying] = useState(false);

  async function handleTryAgain() {
    if (retryLock.current) return;
    retryLock.current = true;
    setRetrying(true);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quizId: session.quiz_id }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.session?.id) {
        router.push(`/play/${body.session.id}`);
        return;
      }
      // Assessment sessions never see this button (isPractice-gated), but a
      // 409 with a live session id is still a valid route-into target.
      if (res.status === 409 && body.error === "already_attempted" && body.session_id) {
        router.push(`/play/${body.session_id}`);
        return;
      }
      // Degraded (window closed / offline): fall back to the quiz list rather
      // than stranding the student — the button must never dead-end silently.
      router.push("/student/quizzes");
    } catch {
      router.push("/student/quizzes");
    } finally {
      retryLock.current = false;
      setRetrying(false);
    }
  }

  function formatOptionText(text: string): string {
    const lower = text.trim().toLowerCase();
    if (lower === "true" || lower === "betul") {
      return locale === "ms" ? "Betul" : "True";
    }
    if (lower === "false" || lower === "salah") {
      return locale === "ms" ? "Salah" : "False";
    }
    return text;
  }

  // ── Result banner facts (shared by both layouts) ──
  const timedOut =
    quiz.time_limit_sec != null &&
    session.submitted_at != null &&
    (new Date(session.submitted_at).getTime() - new Date(session.started_at).getTime()) / 1000 >=
      quiz.time_limit_sec - 2;
  const bannerTitle = isPractice ? t("practiceTitle") : revealed ? t("assessmentTitle") : t("submittedTitle");
  const praiseTier = (pct ?? 0) >= 100 ? "perfect" : (pct ?? 0) >= 75 ? "strong" : (pct ?? 0) >= 50 ? "ok" : "rough";

  // ── Wide-layout breakdown row: the original always-expanded card
  // (prompt + verdict pill header, options, explanation) inside the VList. ──
  const renderRow = (b: ResultsBreakdownRow) => {
    const isCorrect = b.is_correct === true;
    // QT-1: multi rows carry their selections/key as SETS
    // (selected_index is ALWAYS null on them — presence of the set
    // decides "answered", never the scalar).
    const isMulti = b.type === "multi_select";
    const isShortText = b.type === "short_text";
    const selectedSet = isMulti ? (b.selected_indices ?? []) : [];
    const correctSet = isMulti ? (b.correct_indices ?? []) : [];
    // v4.9: a short_text row is "answered" by its TEXT; a skipped row is
    // deliberately NOT answered (and must not render the red ✗ that
    // is_correct:false would otherwise produce).
    const answered = b.skipped
      ? false
      : isShortText
        ? (b.answer_text ?? "").trim().length > 0
        : isMulti
          ? selectedSet.length > 0
          : b.selected_index != null;
    // The marking state, when the row carries one. `pending`/`failed` are
    // neutral by contract (never red) — an unresolved mark is not a wrong
    // answer, and a transient infra failure is not the student's fault.
    const markState = b.skipped
      ? "skipped"
      : b.mark_status === "pending"
        ? "pending"
        : b.mark_status === "needs_review"
          ? "needsReview"
          : b.mark_status === "failed"
            ? "failed"
            : null;
    return (
      <div
        key={b.question_id}
        data-testid={
          markState === "needsReview" || markState === "pending"
            ? "needs-review-row"
            : undefined
        }
        className={`overflow-hidden rounded-[22px] border-2 bg-card shadow-[var(--shadow-clay-sm)] ${
          markState
            ? "border-border"
            : isCorrect
              ? "border-[#C9D9B4]"
              : "border-[#E6B3A8]"
        }`}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4">
          <p className="font-heading text-sm font-bold text-foreground">
            <span className="text-muted-foreground">{b.order_index + 1}.</span> {b.prompt}
          </p>
          <span
            className={`shrink-0 rounded-full border-2 px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wide ${
              markState
                ? "border-border bg-muted text-muted-foreground"
                : isCorrect
                  ? "border-emerald-300 dark:border-emerald-700/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300"
                  : answered
                    ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : "border-border bg-muted text-muted-foreground"
            }`}
          >
            {/* A pending / needs-review / skipped row gets its LABEL instead
                of a check/cross glyph: an unresolved mark is not a verdict,
                and a skip is a deliberate non-answer, not a wrong one. */}
            {markState === "pending"
              ? t("pendingCell")
              : markState === "needsReview"
                ? t("needsReviewRow")
                : markState === "failed"
                  ? t("failedRow")
                  : markState === "skipped"
                    ? t("skippedRow")
                    : !answered
                      ? "—"
                      : isCorrect
                        ? "✓"
                        : "✗"}
          </span>
        </div>
        {b.has_image && (
          <div className="px-5">
            <QuestionImage questionId={b.question_id} prompt={b.prompt} compact />
          </div>
        )}
        {isShortText ? (
          <div className="space-y-3 px-5 pb-5">
            <div className="rounded-xl border-2 border-border bg-muted/40 px-3.5 py-2.5">
              <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">
                {tCommon("aria.yourAnswer")}
              </p>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {(b.answer_text ?? "").trim() || "—"}
              </p>
            </div>
            {b.answer_key && (
              <div className="rounded-xl border-2 border-emerald-300 dark:border-emerald-700/60 bg-emerald-50/50 dark:bg-emerald-950/15 px-3.5 py-2.5">
                <p className="text-[11px] font-extrabold uppercase tracking-wide text-emerald-800 dark:text-emerald-300">
                  {t("correctAnswer")}
                </p>
                <p className="mt-1 text-sm font-semibold text-foreground">{b.answer_key}</p>
              </div>
            )}
          </div>
        ) : (
        <ul className="space-y-2 px-5 pb-5">
          {b.options.map((opt, i) => {
            const selected = isMulti ? selectedSet.includes(i) : i === b.selected_index;
            const correct = isMulti ? correctSet.includes(i) : i === b.correct_index;
            return (
              <li
                key={i}
                className={`flex items-center gap-3 rounded-xl border-2 px-3.5 py-2.5 text-sm ${
                  correct
                    ? `${selected ? "bg-emerald-50 dark:bg-emerald-950/30" : "bg-emerald-50/50 dark:bg-emerald-950/15"} border-emerald-300 dark:border-emerald-700/60`
                    : selected
                      ? "border-destructive/30 bg-destructive/10"
                      : "border-transparent bg-transparent"
                }`}
              >
                {/* YOUR CHOICE = solid disc (✓ green / ✕ red). THE KEY = hollow
                    disc with a ✓ (key you missed). Numbers stay hollow gray. */}
                <span
                  aria-hidden
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-extrabold ${
                    selected
                      ? correct
                        ? "bg-emerald-600 text-white"
                        : "bg-destructive text-white"
                      : correct
                        ? "border-[3px] border-emerald-600 bg-card text-emerald-600 dark:bg-transparent"
                        : "border-border bg-muted text-muted-foreground"
                  }`}
                >
                  {selected ? (correct ? "\u2713" : "\u2715") : correct ? "\u2713" : i + 1}
                </span>
                <span
                  className={`min-w-0 font-semibold ${
                    selected || correct ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {formatOptionText(opt)}
                </span>
                <span className="sr-only">
                  {selected && correct
                    ? tCommon("aria.yourCorrectChoice")
                    : selected
                      ? tCommon("aria.yourWrongChoice")
                      : correct
                        ? tCommon("aria.missedCorrectAnswer")
                        : ""}
                </span>
              </li>
            );
          })}
        </ul>
        )}
        {b.explanation && (
          <div className="border-t-2 border-border/60 px-5 py-3 text-sm font-semibold text-muted-foreground">
            <strong className="font-extrabold text-foreground">{t("explanation")}</strong>{" "}
            {b.explanation}
          </div>
        )}
      </div>
    );
  };

  // ── Accordion breakdown row (mobile): the trigger IS the verdict —
  // question number, prompt, and the ✓/✗/— pill; the panel reveals the
  // option review + explanation. e42/e45 assert the ✓/✕ glyphs and the
  // "Correct answer" tag inside `ol > li`; nested option rows stay <li>. ──
  const renderAccordionRow = (b: ResultsBreakdownRow) => {
    const isCorrect = b.is_correct === true;
    const isMulti = b.type === "multi_select";
    const isShortText = b.type === "short_text";
    const selectedSet = isMulti ? (b.selected_indices ?? []) : [];
    const correctSet = isMulti ? (b.correct_indices ?? []) : [];
    const answered = b.skipped
      ? false
      : isShortText
        ? (b.answer_text ?? "").trim().length > 0
        : isMulti
          ? selectedSet.length > 0
          : b.selected_index != null;
    const markState = b.skipped
      ? "skipped"
      : b.mark_status === "pending"
        ? "pending"
        : b.mark_status === "needs_review"
          ? "needsReview"
          : b.mark_status === "failed"
            ? "failed"
            : null;
    return (
      <AccordionItem
        key={b.question_id}
        value={b.question_id}
        // The accordion root renders as <ol>; items render as <li> so the
        // e42/e45 `ol > li` probes keep resolving.
        render={<li />}
        className={`overflow-hidden rounded-[22px] border-2 bg-card shadow-[var(--shadow-clay-sm)] ${
          markState
            ? "border-border"
            : isCorrect
              ? "border-[#C9D9B4]"
              : "border-[#E6B3A8]"
        }`}
      >
        <AccordionTrigger className="items-center gap-3 px-5 py-3.5 hover:no-underline">
          <span className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
            <span
              className={`grid size-7 shrink-0 place-items-center rounded-full border-2 text-sm font-extrabold ${
                markState
                  ? "border-border bg-muted text-muted-foreground"
                  : isCorrect
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-300"
                    : answered
                      ? "border-destructive/30 bg-destructive/10 text-destructive"
                      : "border-border bg-muted text-muted-foreground"
              }`}
              aria-hidden
            >
              {markState === "pending"
                ? "…"
                : markState === "needsReview" || markState === "skipped" || markState === "failed"
                  ? "—"
                  : !answered
                    ? "—"
                    : isCorrect
                      ? "✓"
                      : "✗"}
            </span>
            <span className="min-w-0 font-heading text-sm font-bold text-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [overflow:hidden]">
              <span className="text-muted-foreground">{b.order_index + 1}.</span> {b.prompt}
            </span>
          </span>
          {/* The ✓/✗/— disc carries the verdict; the registry trigger's
              built-in chevron (group-aria-expanded swap) sits at the end. */}
        </AccordionTrigger>
        <AccordionContent className="data-open:animate-accordion-down data-closed:animate-accordion-up">
          <div className="px-5 pb-4">
            {b.has_image && (
              <div className="pb-3">
                <QuestionImage questionId={b.question_id} prompt={b.prompt} compact />
              </div>
            )}
            {isShortText ? (
              <div className="space-y-3">
                <div className="rounded-xl border-2 border-border bg-muted/40 px-3.5 py-2.5">
                  <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">
                    {tCommon("aria.yourAnswer")}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-foreground">
                    {(b.answer_text ?? "").trim() || "—"}
                  </p>
                </div>
                {b.answer_key && (
                  <div className="rounded-xl border-2 border-emerald-300 dark:border-emerald-700/60 bg-emerald-50/50 dark:bg-emerald-950/15 px-3.5 py-2.5">
                    <p className="text-[11px] font-extrabold uppercase tracking-wide text-emerald-800 dark:text-emerald-300">
                      {t("correctAnswer")}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-foreground">{b.answer_key}</p>
                  </div>
                )}
              </div>
            ) : (
            <ul className="space-y-2">
              {b.options.map((opt, i) => {
                const selected = isMulti ? selectedSet.includes(i) : i === b.selected_index;
                const correct = isMulti ? correctSet.includes(i) : i === b.correct_index;
                return (
                  <li
                    key={i}
                    className={`flex items-center gap-3 rounded-xl border-2 px-3.5 py-2.5 text-sm ${
                      correct
                        ? `${selected ? "bg-emerald-50 dark:bg-emerald-950/30" : "bg-emerald-50/50 dark:bg-emerald-950/15"} border-emerald-300 dark:border-emerald-700/60`
                        : selected
                          ? "border-destructive/30 bg-destructive/10"
                          : "border-transparent bg-transparent"
                    }`}
                  >
                    {/* YOUR CHOICE = solid disc (✓ green / ✕ red). THE KEY =
                        hollow disc with a ✓ (key you missed). Numbers stay
                        hollow gray. */}
                    <span
                      aria-hidden
                      className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-extrabold ${
                        selected
                          ? correct
                            ? "bg-emerald-600 text-white"
                            : "bg-destructive text-white"
                          : correct
                            ? "border-[3px] border-emerald-600 bg-card text-emerald-600 dark:bg-transparent"
                            : "border-border bg-muted text-muted-foreground"
                      }`}
                    >
                      {selected ? (correct ? "\u2713" : "\u2715") : correct ? "\u2713" : i + 1}
                    </span>
                    <span
                      className={`min-w-0 font-semibold ${
                        selected || correct ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {formatOptionText(opt)}
                    </span>
                    <span className="sr-only">
                      {selected && correct
                        ? tCommon("aria.yourCorrectChoice")
                        : selected
                          ? tCommon("aria.yourWrongChoice")
                          : correct
                            ? tCommon("aria.missedCorrectAnswer")
                            : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
            )}
            {b.explanation && (
              <div className="mt-3 rounded-xl border-2 border-border/60 bg-muted/40 px-4 py-3 text-sm font-semibold text-muted-foreground">
                <strong className="font-extrabold text-foreground">{t("explanation")}</strong>{" "}
                {b.explanation}
              </div>
            )}
          </div>
        </AccordionContent>
      </AccordionItem>
    );
  };

  // Wrong/skipped questions start OPEN (that's what a student reviews);
  // correct ones start closed. `multiple` lets any mix stay open.
  const defaultOpenIds = breakdown
    .filter((b) => b.is_correct !== true)
    .map((b) => b.question_id);

  // ══════════════════════════ MOBILE (<lg default) ══════════════════════════
  // Celebration banner, then the breakdown as a plain scrolling document
  // (no VList viewport on phones — the page scrolls natively and a fixed
  // score card would eat half the viewport).
  const mobileLayout = (
    <div className="flex flex-col">
      {/* Banner: avatar tile, eyebrow, title, clay score ring + praise. */}
      <div className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-card px-5 pb-6 pt-7 text-center shadow-[var(--shadow-clay)]">
        <div
          aria-hidden
          className="pointer-events-none absolute -left-8 -top-8 h-24 w-24 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-orange-200/50"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-6 -right-6 h-20 w-20 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-200/50"
        />
        <div className="relative mx-auto mb-4 grid h-16 w-16 place-items-center rounded-[20px] bg-orange-100 shadow-[0_4px_0_rgba(194,65,12,0.15)]">
          {isPractice ? (
            <BotAvatar state="celebrate" size={46} />
          ) : revealed ? (
            <BotAvatar state="success" size={46} />
          ) : (
            <Lock className="h-8 w-8 text-primary" aria-hidden />
          )}
        </div>
        <p className="relative text-xs font-extrabold uppercase tracking-wide text-muted-foreground">
          {bannerTitle}
        </p>
        <h1 className="relative mt-1 font-heading text-2xl font-semibold [text-wrap:balance]">{quiz.title}</h1>

        {timedOut && (
          <div
            className="relative mx-auto mt-3 inline-flex items-center gap-2 rounded-full border-[2px] border-amber-300 bg-amber-50 px-4 py-1.5 text-xs font-bold text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
            role="status"
          >
            {tCommon("timeExpired")}
          </div>
        )}

        {revealed && score != null ? (
          <>
            <div className="relative mt-5 flex justify-center">
              <ScoreRing
                ratio={resolved > 0 ? Math.min(1, score / resolved) : 0}
                label={`${score}`}
                sub={`/ ${resolved}`}
              />
            </div>
            <p className="relative mt-2 text-sm font-extrabold text-muted-foreground">
              {pct != null ? t("pctCorrect", { pct }) : t("pendingCell")}
            </p>
            {pct != null && (
              <p className="relative mt-0.5 text-sm font-bold text-foreground">
                {t(PRAISE_KEYS[praiseTier])}
              </p>
            )}
          </>
        ) : (
          <div
            className="relative mx-auto mt-5 max-w-md rounded-2xl border-[3px] border-border bg-muted/50 px-5 py-4"
            role="status"
          >
            <p className="font-heading text-base font-semibold">{t("resultsPending")}</p>
          </div>
        )}
      </div>


      {/* Actions — full-width stack, Try again first (primary action). */}
      <div className="mt-5 flex flex-col items-stretch gap-2.5">
        {isPractice && (
          <Button size="lg" onClick={() => void handleTryAgain()} disabled={retrying} className="w-full max-sm:h-14 max-sm:text-lg">
            <RotateCcw aria-hidden />
            {retrying ? t("tryAgainStarting") : t("tryAgain")}
          </Button>
        )}
        <Link href="/student/quizzes" className="block">
          <Button variant="outline" size="lg" className="w-full max-sm:h-13">
            {t("backToQuizzes")}
          </Button>
        </Link>
      </div>

      {/* Breakdown: verdict accordion (native page scroll on phones).
          The <ol> wrapper + AccordionItems-as-<li> preserve the list
          contract (e42/e45 probe `ol > li`). */}
      {revealed && breakdown.length > 0 && (
        <section className="mt-7">
          <h2 className="mb-3 font-heading text-lg font-semibold">{t("answerBreakdown")}</h2>
          <Accordion multiple defaultValue={defaultOpenIds} render={<ol />} className="flex-col gap-3">
            {breakdown.map(renderAccordionRow)}
          </Accordion>
        </section>
      )}
    </div>
  );

  // ══════════════════════════ WIDE (≥lg) ══════════════════════════
  // The proven composition verbatim (score typography, button row, VList
  // breakdown) — only the emoji ⏱️ became a lucide Timer icon.
  const wideLayout = (
    <div className="relative mx-auto max-w-2xl">
      <div className="relative rounded-[28px] border-[3px] border-border bg-card p-8 text-center shadow-[var(--shadow-clay)] md:p-10">
        <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-[20px] bg-orange-100 shadow-[0_4px_0_rgba(194,65,12,0.15)]">
          {isPractice ? (
            <BotAvatar state="celebrate" size={46} />
          ) : revealed ? (
            <BotAvatar state="success" size={46} />
          ) : (
            <Lock className="h-8 w-8 text-primary" aria-hidden />
          )}
        </div>

        <p className="text-sm font-extrabold uppercase tracking-wide text-muted-foreground">
          {bannerTitle}
        </p>
        <h1 className="mt-1 font-heading text-2xl font-semibold [text-wrap:balance]">{quiz.title}</h1>

        {timedOut && (
          <div
            className="mx-auto mt-3 inline-flex items-center gap-2 rounded-full border-[2px] border-amber-300 bg-amber-50 px-4 py-1.5 text-xs font-bold text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
            role="status"
          >
            <Timer className="h-3.5 w-3.5" aria-hidden />
            {tCommon("timeExpired")}
          </div>
        )}

        {revealed && score != null ? (
          <>
            <p className="mt-6 font-heading text-display font-bold text-primary">
              {score}
              <span className="text-3xl text-muted-foreground"> / {resolved}</span>
            </p>
            <p className="mt-1 text-sm font-extrabold text-muted-foreground">
              {pct != null ? t("pctCorrect", { pct }) : t("pendingCell")}
            </p>
          </>
        ) : (
          <div className="mx-auto mt-6 max-w-md rounded-2xl border-[3px] border-border bg-muted/50 px-5 py-4" role="status">
            <p className="font-heading text-base font-semibold">{t("resultsPending")}</p>
          </div>
        )}

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/student/quizzes">
            <Button variant="outline" size="lg">{t("backToQuizzes")}</Button>
          </Link>
          {isPractice && (
            <Button size="lg" onClick={() => void handleTryAgain()} disabled={retrying}>
              {retrying ? t("tryAgainStarting") : t("tryAgain")}
            </Button>
          )}
        </div>
      </div>

      {revealed && breakdown.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-3 font-heading text-lg font-semibold">{t("answerBreakdown")}</h2>
          {/* VList (polish W4 A10): same virtualization as the practice review —
              an assessment with 200 questions must not mount every card at
              once. Height is explicit (virtua computes height:100% inline;
              a max-h alone collapses to 0) and sizes to the question count. */}
          <VList
            style={{ height: `min(${breakdown.length * 220 + 12}px, 100dvh)` }}
            role="list"
            aria-label={t("answerBreakdown")}
          >
            {breakdown.map((b) => (
              <div key={b.question_id} role="listitem">
                {renderRow(b)}
              </div>
            ))}
          </VList>
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* ── Pending-marking banner (R16/L2/L6/X2-7) ──
          Two states, one place. `pending-banner` is the frozen testid.
          State (a): answers still being AI-marked — the poll above keeps
          re-reading until they resolve.
          State (b): marks resolved but the QUIZ is not revealed yet. The
          poll must continue here: the student's own marks resolving is not
          the quiz being released (that needs the whole class). */}
      {showPendingBanner && (
        <div
          data-testid="pending-banner"
          className="mx-auto mt-4 max-w-md rounded-2xl border-[3px] border-border bg-muted/50 px-5 py-4 text-center"
          role="status"
          aria-live="polite"
        >
          <p className="font-heading text-base font-semibold text-foreground">
            {pendingCount > 0 ? t("pendingBanner") : t("pendingResolved")}
          </p>
          {pendingCount > 0 && (
            <p className="mt-1 text-sm font-bold text-muted-foreground">
              {t("pendingCount", { count: pendingCount })}
            </p>
          )}
        </div>
      )}

      <div className="mx-auto max-w-2xl px-4 py-6 lg:hidden">{mobileLayout}</div>
      <div className="hidden px-4 py-6 sm:py-12 lg:block">
        {wideLayout}
      </div>
    </>
  );
}
