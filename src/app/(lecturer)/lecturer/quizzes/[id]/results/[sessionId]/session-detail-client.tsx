"use client";

import Link from "next/link";
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
  is_correct: boolean;
  answered_at: string | null;
};

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : DATE_FMT.format(d);
}

// Warm-family correctness styles (sage green / terracotta) that stay inside
// the clay palette instead of clashing with pure mint/pure red.
const PILL_CORRECT = "border-[#B8CC9E] bg-[#E9F0DF] text-[#5F7845]";
const PILL_WRONG = "border-[#E4B0A4] bg-[#FBE4E0] text-[#C4553B]";
const PILL_NONE = "border-border bg-muted text-muted-foreground";
const ROW_CORRECT = "bg-[#7A9E5F] text-white";
const ROW_WRONG = "bg-[#C4553B] text-white";
const ROW_PLAIN = "border-border bg-muted text-muted-foreground";
const TINT_CORRECT = "bg-[#F3F7EC]";
const TINT_WRONG = "bg-[#FDF1EE]";

/**
 * Lecturer's per-session answer breakdown for one quiz session. Shows each
 * question, the option the student selected, and correct/wrong — NOT the
 * correct answer (D10: questions arrive without correct_index/explanation).
 */
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
  const answerByQuestion = new Map(answers.map((a) => [a.question_id, a]));

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 p-7 shadow-[var(--shadow-clay)] md:p-8">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50" />
        <div className="relative">
          <Link
            href={`/lecturer/quizzes/${quizId}/results`}
            className="inline-flex items-center gap-1.5 text-sm font-extrabold text-muted-foreground transition-colors hover:text-primary"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> Back to results
          </Link>
          <h1 className="mt-3 font-heading text-3xl font-semibold [text-wrap:balance]">
            {studentName ?? "Removed student"}
          </h1>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">
            {quizTitle} · Started {formatTime(session.started_at)}
          </p>

          <div className="mt-6 flex max-w-xl flex-wrap gap-4">
            <div className="rounded-2xl border-[3px] border-border bg-card px-4 py-3 shadow-[var(--shadow-clay-sm)]">
              <span className="font-heading text-2xl font-bold">{session.score ?? "—"}</span>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                Score {session.score == null ? "(in progress)" : `of ${questions.length}`}
              </p>
            </div>
            <div className="rounded-2xl border-[3px] border-border bg-card px-4 py-3 shadow-[var(--shadow-clay-sm)]">
              <span className="font-heading text-2xl font-bold">{answers.length}</span>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">Answered</p>
            </div>
            <div className="rounded-2xl border-[3px] border-border bg-card px-4 py-3 shadow-[var(--shadow-clay-sm)]">
              <span className="font-heading text-2xl font-bold">
                {answers.filter((a) => a.is_correct).length}
              </span>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">Correct</p>
            </div>
          </div>
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Answer breakdown</CardTitle>
          <CardDescription>
            Each question this student answered, with the option they selected.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {questions.length === 0 ? (
            <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-6 text-center text-sm font-semibold text-muted-foreground">
              No questions for this quiz.
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
                    className="overflow-hidden rounded-[22px] border-2 border-[#F0DCC8] bg-card shadow-[var(--shadow-clay-sm)]"
                  >
                    <div className="flex items-start justify-between gap-3 px-5 py-4">
                      <p className="font-heading text-sm font-bold text-[#7c2d12]">
                        <span className="text-muted-foreground">{q.order_index + 1}.</span>{" "}
                        {q.prompt}
                      </p>
                      <span
                        className={`shrink-0 rounded-full border-2 px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wide ${
                          isCorrect ? PILL_CORRECT : isWrong ? PILL_WRONG : PILL_NONE
                        }`}
                      >
                        {isCorrect ? "Correct" : isWrong ? "Wrong" : "Unanswered"}
                      </span>
                    </div>
                    <ul className="space-y-2 px-5 pb-5">
                      {q.options.map((opt, i) => {
                        const selected = a != null && i === a.selected_index;
                        return (
                          <li
                            key={i}
                            className={`flex items-center gap-3 rounded-xl border-2 px-3.5 py-2.5 text-sm ${
                              selected
                                ? isCorrect
                                  ? `${TINT_CORRECT} border-[#C9D9B4]`
                                  : `${TINT_WRONG} border-[#E6B3A8]`
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
                              {opt}
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