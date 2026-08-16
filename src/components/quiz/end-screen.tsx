import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PartyPopper, ClipboardCheck, Lock } from "lucide-react";
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

/**
 * EndScreen — mode-aware terminal state for a completed session.
 *
 * Three renderings (PLAN_REVEAL_RESULTS v4):
 *  - Practice: always reveals score + % + per-question breakdown.
 *  - Assessment revealed: score + % + breakdown (revealed_at set).
 *  - Assessment hidden: "Submitted ✓ — results will be released by your
 *    lecturer." — NO score, NO %, NO breakdown (a hidden score would leak).
 *
 * `score` may be null even on a completed assessment before reveal; the
 * parent NEVER fabricates `0 / N` for a hidden assessment.
 */
export function EndScreen({
  session,
  quiz,
  revealed,
  score,
  total,
  breakdown = [],
}: {
  session: Session;
  quiz: Quiz;
  revealed: boolean;
  score: number | null;
  total: number;
  breakdown?: ResultsBreakdownRow[];
}) {
  const isPractice = session.mode === "practice";
  const pct = revealed && total > 0 && score != null ? Math.round((score / total) * 100) : 0;

  return (
    <div className="relative mx-auto max-w-2xl px-4 py-12">
      {/* decorative blobs */}
      <div aria-hidden className="pointer-events-none absolute -left-6 top-10 h-24 w-24 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-orange-200/50" />
      <div aria-hidden className="pointer-events-none absolute -right-4 bottom-16 h-20 w-20 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-200/50" />

      <div className="relative rounded-[28px] border-[3px] border-border bg-card p-8 text-center shadow-[var(--shadow-clay)] md:p-10">
        <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-[20px] bg-orange-100 text-primary shadow-[0_4px_0_rgba(194,65,12,0.15)]">
          {isPractice ? (
            <PartyPopper className="h-8 w-8" aria-hidden />
          ) : revealed ? (
            <ClipboardCheck className="h-8 w-8" aria-hidden />
          ) : (
            <Lock className="h-8 w-8" aria-hidden />
          )}
        </div>

        <p className="text-sm font-extrabold uppercase tracking-wide text-muted-foreground">
          {isPractice ? "Practice complete" : revealed ? "Assessment complete" : "Assessment submitted"}
        </p>
        <h1 className="mt-1 font-heading text-2xl font-semibold [text-wrap:balance]">{quiz.title}</h1>

        {revealed && score != null ? (
          <>
            <p className="mt-6 font-heading text-6xl font-bold text-primary">
              {score}
              <span className="text-3xl text-muted-foreground"> / {total}</span>
            </p>
            <p className="mt-1 text-sm font-extrabold text-muted-foreground">{pct}% correct</p>
          </>
        ) : (
          <div className="mx-auto mt-6 max-w-md rounded-2xl border-[3px] border-border bg-muted/50 px-5 py-4" role="status">
            <p className="font-heading text-base font-semibold">
              Submitted ✓ — results will be released by your lecturer.
            </p>
          </div>
        )}

        <p className="mx-auto mt-5 max-w-md text-sm font-semibold text-muted-foreground">
          {isPractice
            ? "Practice again any time — each attempt creates a new session."
            : revealed
              ? "This assessment can only be taken once. Review your answers below."
              : "You have completed this assessment. It can only be taken once."}
        </p>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/student/quizzes">
            <Button variant="outline" size="lg">Back to quizzes</Button>
          </Link>
          {isPractice && (
            <Link href="/student/quizzes">
              <Button size="lg">Try again</Button>
            </Link>
          )}
        </div>
      </div>

      {revealed && breakdown.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-3 font-heading text-lg font-semibold">Answer breakdown</h2>
          <ol className="space-y-3">
            {breakdown.map((b) => {
              const isCorrect = b.is_correct === true;
              return (
                <li
                  key={b.question_id}
                  className={`overflow-hidden rounded-[22px] border-2 bg-card shadow-[var(--shadow-clay-sm)] ${
                    isCorrect ? "border-[#C9D9B4]" : "border-[#E6B3A8]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3 px-5 py-4">
                    <p className="font-heading text-sm font-bold text-[#7c2d12]">
                      <span className="text-muted-foreground">{b.order_index + 1}.</span>{" "}
                      {b.prompt}
                    </p>
                    <span
                      className={`shrink-0 rounded-full border-2 px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wide ${
                        isCorrect
                          ? "border-[#B8CC9E] bg-[#E9F0DF] text-[#5F7845]"
                          : b.selected_index == null
                            ? "border-border bg-muted text-muted-foreground"
                            : "border-[#E4B0A4] bg-[#FBE4E0] text-[#C4553B]"
                      }`}
                    >
                      {b.selected_index == null ? "Unanswered" : isCorrect ? "Correct" : "Wrong"}
                    </span>
                  </div>
                  <ul className="space-y-2 px-5 pb-5">
                    {b.options.map((opt, i) => {
                      const selected = i === b.selected_index;
                      const correct = i === b.correct_index;
                      return (
                        <li
                          key={i}
                          className={`flex items-center gap-3 rounded-xl border-2 px-3.5 py-2.5 text-sm ${
                            correct
                              ? `${selected ? "bg-[#F3F7EC]" : "bg-[#F3F7EC]/50"} border-[#C9D9B4]`
                              : selected
                                ? "border-[#E6B3A8] bg-[#FDF1EE]"
                                : "border-transparent bg-transparent"
                          }`}
                        >
                          <span
                            className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-extrabold ${
                              correct
                                ? "bg-[#7A9E5F] text-white"
                                : selected
                                  ? "bg-[#C4553B] text-white"
                                  : "border-border bg-muted text-muted-foreground"
                            }`}
                          >
                            {correct ? "\u2713" : selected ? "\u2715" : i + 1}
                          </span>
                          <span
                            className={`min-w-0 font-semibold ${
                              selected || correct ? "text-foreground" : "text-muted-foreground"
                            }`}
                          >
                            {opt}
                          </span>
                          {correct && !selected && (
                            <span className="ml-auto shrink-0 text-[11px] font-extrabold text-[#5F7845]">
                              Correct answer
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {b.explanation && (
                    <div className="border-t-2 border-border/60 px-5 py-3 text-sm font-semibold text-muted-foreground">
                      <strong className="font-extrabold text-foreground">Explanation:</strong>{" "}
                      {b.explanation}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}