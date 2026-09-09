"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { VList } from "virtua";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BotAvatar } from "@/components/bot/bot-avatar";
import { QuestionImage } from "@/components/media/question-image";
import { ScoreRing } from "@/components/quiz/score-ring";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { ArrowRight, RotateCcw, X } from "lucide-react";

export type SafeQuestion = {
  id: string;
  order_index: number;
  type: "mcq" | "true_false";
  prompt: string;
  options: string[];
  /** Presence flag only — the storage path never crosses to the client. */
  has_image?: boolean;
};

type GradedResult = {
  selectedIndex: number;
  isCorrect: boolean;
  correctIndex: number;
  explanation: string | null;
};

/**
 * Stateless practice player shared by self-play (/play/student/[quizId]) and
 * shared play (/s/[code]). Grades EVERY answer through
 * POST /api/student-quizzes/shared/answer — the answer key never reaches this
 * component before it is needed (per-question reveal, D-SQ4). Progress is
 * checkpointed to sessionStorage so an accidental mobile refresh resumes.
 */
export function StudentPracticePlayer({
  quizKey,
  title,
  questions,
  backHref,
  backLabelKey,
}: {
  /** Stable per-quiz storage key (id for self-play, share code for shared). */
  quizKey: string;
  title: string;
  questions: SafeQuestion[];
  backHref: string;
  /**
   * Which sqPlayer back-label to use: self-play says "Back to My Quizzes",
   * shared play is a neutral "Back" (recipients have no My Quizzes).
   */
  backLabelKey: "backMine" | "back";
}) {
  const locale = useLocale();
  const t = useTranslations("sqPlayer");
  const tCommon = useTranslations("common");

  const STORAGE_KEY = `sq-progress:${quizKey}`;
  const lock = useRef(false);
  const [grading, setGrading] = useState(false);
  const [results, setResults] = useState<Record<string, GradedResult>>({});
  const [restored, setRestored] = useState(false);
  const [idx, setIdx] = useState(0);
  const [feedback, setFeedback] = useState<GradedResult | null>(null);
  const [unavailableIds, setUnavailableIds] = useState<Set<string>>(new Set());
  const [fatal, setFatal] = useState<"none" | "unavailable">("none");
  const [error, setError] = useState<string | null>(null);

  // Restore checkpoint once on mount. Deferred to a microtask so the first
  // paint is the fresh quiz (no hydration mismatch) and no setState fires
  // synchronously inside the effect body.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as Record<string, GradedResult>;
          setResults(saved);
          const firstUnanswered = questions.findIndex((q) => !saved[q.id]);
          setIdx(firstUnanswered === -1 ? questions.length : firstUnanswered);
        }
      } catch {
        // Corrupt checkpoint → start fresh.
      }
      setRestored(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(results));
    } catch {
      // Storage full/private — progress simply won't survive refresh.
    }
  }, [results, restored, STORAGE_KEY]);

  const answeredIds = new Set(Object.keys(results));
  // A question counts as RESOLVED once graded OR marked unavailable (plan §4
  // contract: exclude from tally, still reach the scored end screen).
  const resolvedCount = (() => {
    const s = new Set(answeredIds);
    for (const id of unavailableIds) s.add(id);
    return s.size;
  })();
  const score = Object.values(results).filter((r) => r.isCorrect).length;
  const done = restored && questions.length > 0 && resolvedCount >= questions.length;
  // Results screen only once every resolution is AND no per-question feedback
  // is pending — otherwise answering the LAST question would skip straight to
  // the summary without ever showing "Correct!/Not quite".
  const current = questions[idx];

  // Focus lands on each new question heading after advancing (the Next
  // button unmounts, which would otherwise drop keyboard/SR focus to body).
  const headingRef = useRef<HTMLHeadingElement>(null);

  const advance = useCallback(
    (from: number) => {
      setFeedback(null);
      setError(null);
      const next = questions.findIndex((q, i) => i > from && !unavailableIds.has(q.id));
      if (next !== -1) {
        setIdx(next);
      } else {
        // No further playable question — jump to results if everything answered
        // or unavailable.
        setIdx((prev) => prev + 1);
      }
      requestAnimationFrame(() => headingRef.current?.focus());
    },
    [questions, unavailableIds],
  );

  async function handleAnswer(selectedIndex: number) {
    if (!current || lock.current || feedback) return;
    lock.current = true;
    setGrading(true);
    setError(null);
    try {
      const res = await fetch("/api/student-quizzes/shared/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionId: current.id, selectedIndex }),
      });
      const body = await res.json().catch(() => ({}));

      if (res.status === 404 && body.error === "unavailable") {
        const nextUnavailable = new Set(unavailableIds).add(current.id);
        setUnavailableIds(nextUnavailable);
        if (nextUnavailable.size >= questions.length) {
          setFatal("unavailable");
          return;
        }
        advance(idx);
        return;
      }

      if (!res.ok || typeof body.is_correct !== "boolean") {
        setError(body.message ?? tCommon("errorGeneric"));
        return;
      }

      const result: GradedResult = {
        selectedIndex,
        isCorrect: body.is_correct,
        correctIndex: body.correct_index,
        explanation: body.explanation ?? null,
      };
      setResults((prev) => ({ ...prev, [current.id]: result }));
      setFeedback(result);
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      lock.current = false;
      setGrading(false);
    }
  }

  function handleRetry() {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setResults({});
    setUnavailableIds(new Set());
    setFeedback(null);
    setFatal("none");
    setIdx(0);
  }

  function formatOptionText(text: string): string {
    const lower = text.trim().toLowerCase();
    if (lower === "true" || lower === "betul") return locale === "ms" ? "Betul" : "True";
    if (lower === "false" || lower === "salah") return locale === "ms" ? "Salah" : "False";
    return text;
  }

  if (questions.length === 0) {
    return (
      <Centered>
        <p className="font-heading text-lg font-semibold">{t("noQuestions")}</p>
        <Link href={backHref}>
          <Button variant="outline">{t(backLabelKey)}</Button>
        </Link>
      </Centered>
    );
  }

  if (fatal === "unavailable") {
    return (
      <Centered>
        <p className="font-heading text-lg font-semibold">{t("unavailable")}</p>
        <Link href={backHref}>
          <Button variant="outline">{t(backLabelKey)}</Button>
        </Link>
      </Centered>
    );
  }

  if (done && !feedback) {
    const pct = Math.round((score / questions.length) * 100);
    const wrongIds = questions
      .filter((q) => {
        const r = results[q.id];
        return r ? !r.isCorrect : true; // unresolved rows count as "review me"
      })
      .map((q) => q.id);

    // ── Shared review row (identical content both layouts) ──
    const renderReviewRow = (q: SafeQuestion) => {
      const r = results[q.id];
      return (
        <ul className="space-y-2">
          {q.options.map((opt, oi) => {
            const selected = r ? oi === r.selectedIndex : false;
            const correct = r ? oi === r.correctIndex : false;
            return (
              <li
                key={oi}
                className={`flex items-center gap-3 rounded-xl border-2 px-3.5 py-2.5 text-sm ${
                  correct
                    ? `border-emerald-300 ${selected ? "bg-emerald-50 dark:bg-emerald-950/30" : "bg-emerald-50/50 dark:bg-emerald-950/15"}`
                    : selected
                      ? "border-destructive/30 bg-destructive/10"
                      : "border-transparent"
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
                  {selected
                    ? correct
                      ? "\u2713"
                      : "\u2715"
                    : correct
                      ? "\u2713"
                      : oi + 1}
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
          {r?.explanation && (
            <li className="rounded-xl border-2 border-border/60 bg-muted/40 px-4 py-3 text-sm font-semibold text-muted-foreground">
              <strong className="font-extrabold text-foreground">
                {t("explanationLabel")}
              </strong>{" "}
              {r.explanation}
            </li>
          )}
        </ul>
      );
    };

    // ════════════════ MOBILE (<lg default) ════════════════
    // Celebration banner + clay score ring + tiered praise, stacked
    // full-width actions, and the review as a verdict accordion (wrong/
    // unresolved questions start OPEN) on the native page scroll.
    const mobileLayout = (
      <div className="flex flex-col">
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
            <BotAvatar state="celebrate" size={46} />
          </div>
          <p className="relative text-xs font-extrabold uppercase tracking-wide text-muted-foreground">
            {t("endTitle")}
          </p>
          <h1 className="relative mt-1 font-heading text-2xl font-semibold [text-wrap:balance]">
            {title}
          </h1>
          <div className="relative mt-5 flex justify-center">
            <ScoreRing
              ratio={questions.length > 0 ? score / questions.length : 0}
              label={`${score}`}
              sub={`/ ${questions.length}`}
            />
          </div>
          <p className="relative mt-2 text-sm font-extrabold text-muted-foreground">
            {t("scorePct", { pct })}
          </p>
          <p className="relative mt-0.5 text-sm font-bold text-foreground">
            {t(
              pct >= 100
                ? "praisePerfect"
                : pct >= 75
                  ? "praiseStrong"
                  : pct >= 50
                    ? "praiseOk"
                    : "praiseRough",
            )}
          </p>
        </div>

        <div className="mt-5 flex flex-col items-stretch gap-2.5">
          <Button size="lg" onClick={handleRetry} className="w-full max-sm:h-14 max-sm:text-lg">
            <RotateCcw aria-hidden />
            {t("retryBtn")}
          </Button>
          <Link href={backHref} className="block">
            <Button variant="outline" size="lg" className="w-full max-sm:h-13">
              {t(backLabelKey)}
            </Button>
          </Link>
        </div>

        <section className="mt-7">
          <h2 className="mb-3 font-heading text-lg font-semibold">{t("reviewTitle")}</h2>
          <Accordion multiple defaultValue={wrongIds} render={<ol />} className="flex-col gap-3">
            {questions.map((q, i) => {
              const r = results[q.id];
              const isUnavailable = !r || unavailableIds.has(q.id);
              const isCorrect = r?.isCorrect === true;
              return (
                <AccordionItem
                  key={q.id}
                  value={q.id}
                  render={<li />}
                  className={`overflow-hidden rounded-[22px] border-2 bg-card shadow-[var(--shadow-clay-sm)] ${
                    isUnavailable
                      ? "border-border opacity-70"
                      : isCorrect
                        ? "border-[#C9D9B4]"
                        : "border-[#E6B3A8]"
                  }`}
                >
                  <AccordionTrigger className="items-center gap-3 px-5 py-3.5 hover:no-underline">
                    <span className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                      <span
                        aria-hidden
                        className={`grid size-7 shrink-0 place-items-center rounded-full border-2 text-sm font-extrabold ${
                          isUnavailable
                            ? "border-border bg-muted text-muted-foreground"
                            : isCorrect
                              ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-300"
                              : "border-destructive/30 bg-destructive/10 text-destructive"
                        }`}
                      >
                        {isUnavailable
                          ? "—"
                          : isCorrect
                            ? "\u2713"
                            : "\u2717"}
                      </span>
                      <span className="min-w-0 font-heading text-sm font-bold text-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [overflow:hidden]">
                        <span className="text-muted-foreground">{i + 1}.</span> {q.prompt}
                      </span>
                    </span>
                    {/* The ✓/✗/— disc carries the verdict; the registry
                        trigger's chevron handles the open/close affordance. */}
                  </AccordionTrigger>
                  <AccordionContent className="data-open:animate-accordion-down data-closed:animate-accordion-up">
                    <div className="px-5 pb-4">
                      {q.has_image && r && (
                        <div className="pb-3">
                          <QuestionImage questionId={q.id} prompt={q.prompt} compact />
                        </div>
                      )}
                      {isUnavailable ? (
                        <p className="text-sm font-bold text-muted-foreground" role="status">
                          {t("qUnavailable")}
                        </p>
                      ) : (
                        renderReviewRow(q)
                      )}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        </section>
      </div>
    );

    // ════════════════ WIDE (≥lg) ════════════════
    // Original composition: score typography + side-by-side buttons +
    // VList-virtualized review cards (updated with the disc grammar).
    const wideLayout = (
      <div className="relative mx-auto max-w-2xl">
        <div className="relative rounded-[28px] border-[3px] border-border bg-card p-8 text-center shadow-[var(--shadow-clay)] md:p-10">
          <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-[20px] bg-orange-100 shadow-[0_4px_0_rgba(194,65,12,0.15)]">
            <BotAvatar state="celebrate" size={46} />
          </div>
          <p className="text-sm font-extrabold uppercase tracking-wide text-muted-foreground">
            {t("endTitle")}
          </p>
          <h1 className="mt-1 font-heading text-2xl font-semibold [text-wrap:balance]">
            {title}
          </h1>
          <p className="mt-6 font-heading text-6xl font-bold text-primary">
            {score}
            <span className="text-3xl text-muted-foreground"> / {questions.length}</span>
          </p>
          <p className="mt-1 text-sm font-extrabold text-muted-foreground">
            {t("scorePct", { pct })}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href={backHref}>
              <Button variant="outline" size="lg">
                {t(backLabelKey)}
              </Button>
            </Link>
            <Button size="lg" onClick={handleRetry}>
              {t("retryBtn")}
            </Button>
          </div>
        </div>

        <div className="mt-6">
          <h2 className="mb-3 font-heading text-lg font-semibold">{t("reviewTitle")}</h2>
          {/* VList (polish W4 A10): variable-height rows are measured, so a
              200-question review doesn't mount every card at once. virtua
              computes height:100% inline — an explicit height is required
              (max-h alone collapses to 0); it sizes to the question count so
              short reviews don't get a blank scroll area. List semantics
              preserved via role="list"/"listitem" (the virtualized root is a
              div). */}
          <VList
            style={{ height: `min(${questions.length * 220 + 12}px, 100dvh)` }}
            role="list"
            aria-label={t("reviewTitle")}
          >
            {questions.map((q, i) => {
              const r = results[q.id];
              return (
                <div
                  key={q.id}
                  role="listitem"
                  className={`mb-3 overflow-hidden rounded-[22px] border-2 bg-card shadow-[var(--shadow-clay-sm)] ${
                    !r || unavailableIds.has(q.id)
                      ? "border-border opacity-70"
                      : r.isCorrect
                        ? "border-[#C9D9B4]"
                        : "border-[#E6B3A8]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3 px-5 py-4">
                    <p className="font-heading text-sm font-bold text-foreground">
                      <span className="text-muted-foreground">{i + 1}.</span> {q.prompt}
                    </p>
                    <span
                      className={`shrink-0 rounded-full border-2 px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wide ${
                        !r || unavailableIds.has(q.id)
                          ? "border-border bg-muted text-muted-foreground"
                          : r.isCorrect
                            ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                            : "border-destructive/30 bg-destructive/10 text-destructive"
                      }`}
                    >
                      {!r || unavailableIds.has(q.id)
                        ? t("qUnavailable")
                        : r.isCorrect
                          ? "\u2713"
                          : "\u2717"}
                    </span>
                  </div>
                  {r && (
                    <div className="px-5 pb-5">
                      {renderReviewRow(q)}
                    </div>
                  )}
                </div>
              );
            })}
          </VList>
        </div>
      </div>
    );

    return (
      <div className="relative mx-auto max-w-2xl px-4 py-6 sm:py-12">
        <div className="lg:hidden">{mobileLayout}</div>
        <div className="hidden lg:block">{wideLayout}</div>
      </div>
    );
  }

  if (!current) {
    // Between states (all remaining questions unavailable etc.) — neutral end.
    return (
      <Centered>
        <p className="font-heading text-lg font-semibold">{t("unavailable")}</p>
        <Link href={backHref}>
          <Button variant="outline">{t(backLabelKey)}</Button>
        </Link>
      </Centered>
    );
  }

  const currentResult = results[current.id];

  return (
    <div className="mx-auto max-w-2xl px-4 py-5 sm:py-8 md:py-12">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p aria-live="polite" className="text-sm font-extrabold uppercase tracking-wide text-muted-foreground">
          {t("progress", { current: idx + 1, total: questions.length })}
        </p>
        <Link href={backHref}>
          <Button variant="ghost" size="sm">
            {t(backLabelKey)}
          </Button>
        </Link>
      </div>

      <Card className="rounded-[28px] border-[3px] shadow-[var(--shadow-clay)]">
        <CardContent className="space-y-6 p-5 md:p-8">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="font-heading text-xl font-semibold [text-wrap:balance] outline-none md:text-2xl"
          >
            {current.prompt}
          </h1>

          {current.has_image && (
            <QuestionImage key={current.id} questionId={current.id} prompt={current.prompt} />
          )}

          <div className="grid gap-3">
            {current.options.map((opt, i) => {
              const picked = currentResult?.selectedIndex === i && !!feedback;
              const isCorrectOne =
                !!feedback &&
                (i === feedback.correctIndex ||
                  (picked && feedback.selectedIndex === i && feedback.isCorrect));
              const wrongPick = picked && !!feedback && !feedback.isCorrect;
              return (
                <button
                  key={i}
                  type="button"
                  disabled={!!feedback || grading}
                  onClick={() => void handleAnswer(i)}
                  className={`flex min-h-14 items-center gap-3 rounded-2xl border-[3px] px-4 py-3 text-left font-sans font-extrabold transition-[transform,box-shadow,background-color] duration-150 outline-none focus-visible:ring-4 focus-visible:ring-ring/40 disabled:cursor-default ${
                    isCorrectOne
                      ? "border-emerald-400 bg-emerald-50 text-emerald-900 shadow-[0_4px_0_rgba(5,150,105,0.35)]"
                      : wrongPick
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : "border-border bg-card text-foreground shadow-[0_4px_0_var(--border)] hover:-translate-y-0.5 hover:shadow-[0_6px_0_var(--border)] active:translate-y-0.5 active:shadow-none disabled:hover:translate-y-0"
                  }`}
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border-[2px] border-current text-xs">
                    {isCorrectOne ? "\u2713" : wrongPick ? "\u2715" : i + 1}
                  </span>
                  <span className="min-w-0">{formatOptionText(opt)}</span>
                </button>
              );
            })}
          </div>

          <div aria-live="polite" className="min-h-6 space-y-3">
            {error && (
              <p
                className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive"
                role="alert"
              >
                {error}
              </p>
            )}
            {feedback && (
              <>
                {feedback.isCorrect ? (
                  // The glowing green option row already signals success
                  // visually; keep only the sr-only live announcement.
                  <p role="status" className="sr-only">
                    {t("correctFeedback")}
                  </p>
                ) : (
                  <p
                    className="rounded-2xl border-[3px] border-amber-300 bg-amber-50 px-4 py-3 text-sm font-extrabold text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
                    role="status"
                  >
                    <X className="inline h-4 w-4" aria-hidden /> {t("wrongFeedback")}
                  </p>
                )}
                {feedback.explanation && (
                  <p className="rounded-2xl border-[3px] border-border bg-muted/50 px-4 py-3 text-sm font-semibold text-muted-foreground">
                    <strong className="font-extrabold text-foreground">
                      {t("explanationLabel")}
                    </strong>{" "}
                    {feedback.explanation}
                  </p>
                )}
              </>
            )}
          </div>

          {feedback && (
            <div className="flex max-sm:sticky max-sm:bottom-[max(1rem,var(--safe-bottom))] max-sm:justify-stretch justify-end">
              <Button size="lg" onClick={() => advance(idx)} className="max-sm:w-full max-sm:justify-center">
                {resolvedCount >= questions.length ? t("resultsBtn") : t("nextBtn")}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="flex flex-col items-center gap-4 text-center">{children}</div>
    </div>
  );
}
