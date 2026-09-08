"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";

type SessionInfo = {
  id: string;
  student_id: string;
  mode: string;
  status: string;
  score: number | null;
  started_at: string | null;
};

type QuestionRow = {
  id: string;
  type: string;
  prompt: string;
  options: string[];
  order_index: number;
};

type AnswerRow = {
  question_id: string;
  selected_index: number | null;
  /** QT-1: multi-select rows carry the canonical selection set instead. */
  selected_indices: number[] | null;
  is_correct: boolean;
  answered_at: string | null;
};

const CHIP_CORRECT = "border-[2px] border-emerald-300 dark:border-emerald-700/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300";
const CHIP_WRONG = "border-[2px] border-destructive/30 bg-destructive/10 text-destructive";
const CHIP_SKIPPED = "border-[2px] border-border bg-muted text-muted-foreground";
const ROW_CORRECT = "bg-emerald-600 text-white";
const ROW_WRONG = "bg-destructive text-white";
const PICK_CORRECT = "border-emerald-300 dark:border-emerald-700/60 bg-emerald-50 dark:bg-emerald-950/30";
const PICK_WRONG = "bg-destructive/10 border-destructive/30";

export function SessionDetailClient({
  quizId,
  quizTitle,
  session,
  questions,
  answers,
  studentName,
}: {
  quizId: string;
  quizTitle: string;
  session: SessionInfo;
  questions: QuestionRow[];
  answers: AnswerRow[];
  studentName: string | null;
}) {
  const locale = useLocale();
  const t = useTranslations("lecturer.results");
  const tCommon = useTranslations("common");
  const answerByQuestion = new Map(answers.map((a) => [a.question_id, a]));

  function formatTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat(locale === "ms" ? "ms-MY" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "Asia/Kuala_Lumpur",
    }).format(d);
  }

  function formatOptionText(text: string, type: string): string {
    if (type === "true_false") {
      const lower = text.trim().toLowerCase();
      if (lower === "true" || lower === "betul") {
        return locale === "ms" ? "Betul" : "True";
      }
      if (lower === "false" || lower === "salah") {
        return locale === "ms" ? "Salah" : "False";
      }
    }
    return text;
  }

  const total = questions.length;
  const inProgress = session.score == null;
  const score = session.score ?? 0;
  const frac = !inProgress && total > 0 ? score / total : 0;
  // Clay score badge geometry: r=30 in a 72-box, rounded cap, starts at 12
  // o'clock via -rotate-90.
  const RING_R = 30;
  const RING_C = 2 * Math.PI * RING_R;

  const verdictChip = (isCorrect: boolean, isWrong: boolean, answered: boolean) => {
    const cls = answered ? (isCorrect ? CHIP_CORRECT : CHIP_WRONG) : CHIP_SKIPPED;
    const word = !answered
      ? (locale === "ms" ? "Langkau" : "Skipped")
      : isCorrect
        ? (locale === "ms" ? "Betul" : "Correct")
        : (locale === "ms" ? "Salah" : "Wrong");
    return { cls, glyph: !answered ? "—" : isCorrect ? "✓" : "✗", word };
  };

  return (
    <div className="space-y-5 md:space-y-7">
      {/* <sm: NO hero container — plain native header block directly on the
          page background (block flow: back row, then name|badge row); sm+:
          the floating gradient hero card. The badge sits on the name/meta
          row (items-center), not pinned to the top bar. */}
      <section className="relative mt-1 sm:overflow-hidden sm:rounded-[28px] sm:border-[3px] sm:border-border sm:bg-gradient-to-br sm:from-orange-100 sm:via-orange-50 sm:to-blue-50 sm:p-6 sm:shadow-[var(--shadow-clay)] sm:dark:from-orange-950/40 sm:dark:via-card sm:dark:to-blue-950/40 md:p-8">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 hidden h-36 w-36 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50 sm:block dark:bg-white/5" />
        <div className="relative">
          <Link
            href={`/lecturer/quizzes/${quizId}/results`}
            className="inline-flex min-h-[36px] items-center gap-1.5 text-sm font-extrabold text-muted-foreground transition-colors hover:text-primary"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> {tCommon("back")}
          </Link>
        </div>
        <div className="relative mt-0.5 flex items-center justify-between gap-3 sm:mt-2 sm:gap-4">
          <div className="min-w-0">
            {/* Very long names clamp at 2 lines (visual only — the full name
                stays in the DOM for screen readers, plus a title tooltip). */}
            <h1
              title={studentName ?? undefined}
              className="line-clamp-2 break-words font-heading text-[26px] font-semibold leading-tight md:text-4xl"
            >
              {studentName ?? t("tableHeaderStudent")}
            </h1>
            <p className="mt-0.5 text-[13px] font-semibold text-muted-foreground md:mt-2 md:text-sm">
              {quizTitle} · {formatTime(session.started_at)}
            </p>
          </div>

          {/* ONE score representation: a clay badge with the fraction,
              vertically centered on the name/meta row. No bar, no % —
              nothing is stated twice. The bare number keeps the
              span.font-heading.text-2xl shape; e2e (e25) reads it, and the
              "/ N" must stay visible too. */}
          <div
            role="img"
            aria-label={
              inProgress
                ? tCommon("inProgress")
                : `${t("tableHeaderScore")} ${session.score}/${total}`
            }
            className="grid h-[88px] w-[88px] shrink-0 place-items-center rounded-full border-[3px] border-border bg-card shadow-[var(--shadow-clay-sm)] md:h-[108px] md:w-[108px]"
          >
            <div className="relative grid place-items-center">
              <svg viewBox="0 0 72 72" className="absolute h-[74px] w-[74px] -rotate-90 md:h-[92px] md:w-[92px]" aria-hidden>
                <circle cx="36" cy="36" r={RING_R} fill="none" strokeWidth="8" className="stroke-border/80 dark:stroke-white/10" />
                {!inProgress && (
                  <circle
                    cx="36"
                    cy="36"
                    r={RING_R}
                    fill="none"
                    strokeWidth="8"
                    strokeLinecap="round"
                    strokeDasharray={RING_C}
                    strokeDashoffset={RING_C * (1 - frac)}
                    className="stroke-primary transition-[stroke-dashoffset] duration-700 ease-out"
                  />
                )}
              </svg>
              <div className="relative flex flex-col items-center leading-none">
                <span className="font-heading text-[26px] font-bold md:text-3xl">
                  {session.score ?? "—"}
                </span>
                {inProgress ? (
                  <span className="mt-1 text-[10px] font-extrabold text-muted-foreground">
                    {tCommon("inProgress")}
                  </span>
                ) : (
                  <span className="mt-1 text-xs font-extrabold text-muted-foreground">
                    / {total}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Heading straight on the page; each question one flat card — no
          wrapper card, no filler subtitle. */}
      <section aria-labelledby="breakdown-heading" className="space-y-3 md:space-y-4">
        <h2
          id="breakdown-heading"
          className="px-1 font-heading text-xl font-semibold md:text-2xl"
        >
          {t("breakdownTitle")}
        </h2>
        {total === 0 ? (
          <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-6 text-center text-sm font-semibold text-muted-foreground">
            {tCommon("notFound")}
          </p>
        ) : (
          <ol className="space-y-3 md:space-y-4">
            {questions.map((q) => {
              const a = answerByQuestion.get(q.id);
              const isCorrect = a != null && a.is_correct;
              const isWrong = a != null && !a.is_correct;
              const chip = verdictChip(isCorrect, isWrong, a != null);
              return (
                <li
                  key={q.id}
                  className="rounded-[22px] border-[3px] border-border bg-card px-4 py-4 shadow-[var(--shadow-clay-sm)] md:px-5"
                >
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 border-border bg-muted font-heading text-[13px] font-bold text-muted-foreground"
                    >
                      {q.order_index + 1}
                    </span>
                    <p className="min-w-0 flex-1 pt-0.5 font-heading text-[15px] font-semibold leading-snug text-foreground">
                      {q.prompt}
                    </p>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wide ${chip.cls}`}
                    >
                      {chip.glyph} {chip.word}
                    </span>
                  </div>
                  <ul className="mt-2.5 space-y-1 pl-10">
                    {q.options.map((opt, i) => {
                      // QT-1: multi questions may select SEVERAL options —
                      // every committed selection gets the highlight (the
                      // chip carries the single is_correct verdict).
                      const selected =
                        a != null &&
                        (q.type === "multi_select"
                          ? (a.selected_indices?.includes(i) ?? false)
                          : i === a.selected_index);
                      const letter = String.fromCharCode(65 + i);
                      return (
                        <li
                          key={i}
                          className={`flex items-center gap-2.5 text-sm ${
                            selected
                              ? `rounded-xl border-2 px-3 py-2 ${
                                  isCorrect
                                    ? `${PICK_CORRECT} text-foreground`
                                    : `${PICK_WRONG} text-foreground`
                                }`
                              : "px-3 py-1.5 text-muted-foreground"
                          }`}
                        >
                          <span
                            aria-hidden
                            className="w-4 shrink-0 text-xs font-extrabold text-muted-foreground/80"
                          >
                            {letter}
                          </span>
                          <span
                            className={`min-w-0 ${
                              selected ? "font-bold" : "font-semibold"
                            }`}
                          >
                            {formatOptionText(opt, q.type)}
                          </span>
                          {selected && (
                            <span
                              className={`ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-extrabold ${
                                isCorrect ? ROW_CORRECT : ROW_WRONG
                              }`}
                            >
                              {isCorrect ? "\u2713" : "\u2715"}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
