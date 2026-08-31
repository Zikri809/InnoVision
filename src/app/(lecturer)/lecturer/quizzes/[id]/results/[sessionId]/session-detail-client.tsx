"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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

const PILL_CORRECT = "border-[2px] border-emerald-300 dark:border-emerald-700/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300";
const PILL_WRONG = "border-[2px] border-destructive/30 bg-destructive/10 text-destructive";
const PILL_NONE = "border-[2px] border-border bg-muted text-muted-foreground";
const ROW_CORRECT = "bg-emerald-600 text-white";
const ROW_WRONG = "bg-destructive text-white";
const ROW_PLAIN = "border-2 border-border bg-muted text-muted-foreground";
const TINT_CORRECT = "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-700/60";
const TINT_WRONG = "bg-destructive/10 border-destructive/30";

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

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 p-7 shadow-[var(--shadow-clay)] md:p-8">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50" />
        <div className="relative">
          <Link
            href={`/lecturer/quizzes/${quizId}/results`}
            className="inline-flex items-center gap-1.5 text-sm font-extrabold text-muted-foreground transition-colors hover:text-primary"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> {tCommon("back")}
          </Link>
          <h1 className="mt-3 font-heading text-3xl font-semibold [text-wrap:balance]">
            {studentName ?? t("tableHeaderStudent")}
          </h1>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">
            {quizTitle} · {formatTime(session.started_at)}
          </p>

          <div className="mt-6 flex max-w-xl flex-wrap gap-4">
            <div className="rounded-2xl border-[3px] border-border bg-card px-4 py-3 shadow-[var(--shadow-clay-sm)]">
              <span className="font-heading text-2xl font-bold">{session.score ?? "—"}</span>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                {t("tableHeaderScore")} {session.score == null ? `(${tCommon("inProgress")})` : `/ ${questions.length}`}
              </p>
            </div>
            <div className="rounded-2xl border-[3px] border-border bg-card px-4 py-3 shadow-[var(--shadow-clay-sm)]">
              <span className="font-heading text-2xl font-bold">{answers.length}</span>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">{tCommon("completed")}</p>
            </div>
            <div className="rounded-2xl border-[3px] border-border bg-card px-4 py-3 shadow-[var(--shadow-clay-sm)]">
              <span className="font-heading text-2xl font-bold">
                {questions.length > 0 && session.score != null
                  ? `${Math.round((session.score / questions.length) * 100)}%`
                  : "—"}
              </span>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                {locale === "ms" ? "Ketepatan" : "Accuracy"}
              </p>
            </div>
          </div>
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>{t("breakdownTitle")}</CardTitle>
          <CardDescription>
            {t("breakdownSubtitle")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {questions.length === 0 ? (
            <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-6 text-center text-sm font-semibold text-muted-foreground">
              {tCommon("notFound")}
            </p>
          ) : (
            <ol className="space-y-4">
              {questions.map((q) => {
                const a = answerByQuestion.get(q.id);
                const isCorrect = a != null && a.is_correct;
                const isWrong = a != null && !a.is_correct;
                return (
                  <li
                    key={q.id}
                    className="overflow-hidden rounded-[22px] border-[3px] border-border bg-card shadow-[var(--shadow-clay-sm)]"
                  >
                    <div className="flex items-start justify-between gap-3 px-5 py-4">
                      <p className="font-heading text-sm font-bold text-foreground">
                        <span className="text-muted-foreground">{q.order_index + 1}.</span>{" "}
                        {q.prompt}
                      </p>
                      <span
                        className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wide ${
                          isCorrect ? PILL_CORRECT : isWrong ? PILL_WRONG : PILL_NONE
                        }`}
                      >
                        {isCorrect ? "✓" : isWrong ? "✗" : "—"}
                      </span>
                    </div>
                    <ul className="space-y-2 px-5 pb-5">
                      {q.options.map((opt, i) => {
                        // QT-1: multi questions may select SEVERAL options —
                        // every committed selection gets the highlight (the
                        // ✓/✗ pill still carries the single is_correct).
                        const selected =
                          a != null &&
                          (q.type === "multi_select"
                            ? (a.selected_indices?.includes(i) ?? false)
                            : i === a.selected_index);
                        return (
                          <li
                            key={i}
                            className={`flex items-center gap-3 rounded-xl border-2 px-3.5 py-2.5 text-sm ${
                              selected
                                ? isCorrect
                                  ? TINT_CORRECT
                                  : TINT_WRONG
                                : "border-transparent bg-transparent"
                            }`}
                          >
                            <span
                              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-extrabold ${
                                selected
                                  ? isCorrect
                                    ? ROW_CORRECT
                                    : ROW_WRONG
                                  : ROW_PLAIN
                              }`}
                            >
                              {selected ? "\u2713" : i + 1}
                            </span>
                            <span
                              className={`min-w-0 font-semibold ${
                                selected ? "text-foreground" : "text-muted-foreground"
                              }`}
                            >
                              {formatOptionText(opt, q.type)}
                            </span>
                            {selected && !isCorrect && (
                              <span className="ml-auto shrink-0 font-extrabold text-[#C4553B]">
                                {"\u2715"}
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
        </CardContent>
      </Card>
    </div>
  );
}