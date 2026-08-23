"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BotAvatar } from "@/components/bot/bot-avatar";
import { ArrowRight, Check, X } from "lucide-react";

export type SafeQuestion = {
  id: string;
  order_index: number;
  type: "mcq" | "true_false";
  prompt: string;
  options: string[];
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
    return (
      <div className="relative mx-auto max-w-2xl px-4 py-12">
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

        {/* ── Review ── */}
        <div className="mt-6">
          <h2 className="mb-3 font-heading text-lg font-semibold">{t("reviewTitle")}</h2>
          <ol className="space-y-3">
            {questions.map((q, i) => {
              const r = results[q.id];
              return (
                <li
                  key={q.id}
                  className={`overflow-hidden rounded-[22px] border-2 bg-card shadow-[var(--shadow-clay-sm)] ${
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
                    <ul className="space-y-2 px-5 pb-5">
                      {q.options.map((opt, oi) => {
                        const selected = oi === r.selectedIndex;
                        const correct = oi === r.correctIndex;
                        return (
                          <li
                            key={oi}
                            className={`flex items-center gap-3 rounded-xl border-2 px-3.5 py-2.5 text-sm ${
                              correct
                                ? `border-emerald-300 ${selected ? "bg-emerald-50" : "bg-emerald-50/50"}`
                                : selected
                                  ? "border-destructive/30 bg-destructive/10"
                                  : "border-transparent"
                            }`}
                          >
                            <span
                              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-extrabold ${
                                correct
                                  ? "bg-emerald-600 text-white"
                                  : selected
                                    ? "bg-destructive text-white"
                                    : "border-border bg-muted text-muted-foreground"
                              }`}
                            >
                              {correct ? "\u2713" : selected ? "\u2715" : oi + 1}
                            </span>
                            <span
                              className={`min-w-0 font-semibold ${
                                selected || correct
                                  ? "text-foreground"
                                  : "text-muted-foreground"
                              }`}
                            >
                              {formatOptionText(opt)}
                            </span>
                          </li>
                        );
                      })}
                      {r.explanation && (
                        <li className="border-t-2 border-border/60 pt-3 text-sm font-semibold text-muted-foreground">
                          <strong className="font-extrabold text-foreground">
                            {t("explanationLabel")}
                          </strong>{" "}
                          {r.explanation}
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
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
    <div className="mx-auto max-w-2xl px-4 py-8 md:py-12">
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
        <CardContent className="space-y-6 p-6 md:p-8">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="font-heading text-xl font-semibold [text-wrap:balance] outline-none md:text-2xl"
          >
            {current.prompt}
          </h1>

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
                <p
                  className={`rounded-2xl border-[3px] px-4 py-3 text-sm font-extrabold ${
                    feedback.isCorrect
                      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                      : "border-amber-300 bg-amber-50 text-amber-800"
                  }`}
                  role="status"
                >
                  {feedback.isCorrect ? (
                    <>
                      <Check className="inline h-4 w-4" aria-hidden /> {t("correctFeedback")}
                    </>
                  ) : (
                    <>
                      <X className="inline h-4 w-4" aria-hidden /> {t("wrongFeedback")}
                    </>
                  )}
                </p>
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
            <div className="flex justify-end">
              <Button size="lg" onClick={() => advance(idx)}>
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
