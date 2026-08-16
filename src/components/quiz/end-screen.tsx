import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PartyPopper, ClipboardCheck } from "lucide-react";

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
};

/**
 * EndScreen — final score / total with a mode-aware message and a link back to
 * the quizzes list. Practice shows a "Try again" (start creates a new session —
 * D2); assessment does not (one attempt). Uses role="status".
 */
export function EndScreen({
  session,
  quiz,
  score,
  total,
}: {
  session: Session;
  quiz: Quiz;
  score: number;
  total: number;
}) {
  const isPractice = session.mode === "practice";
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;

  return (
    <div className="relative mx-auto max-w-2xl px-4 py-12">
      {/* decorative blobs */}
      <div aria-hidden className="pointer-events-none absolute -left-6 top-10 h-24 w-24 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-orange-200/50" />
      <div aria-hidden className="pointer-events-none absolute -right-4 bottom-16 h-20 w-20 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-200/50" />

      <div className="relative rounded-[28px] border-[3px] border-border bg-card p-8 text-center shadow-[var(--shadow-clay)] md:p-10" role="status">
        <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-[20px] bg-orange-100 text-primary shadow-[0_4px_0_rgba(194,65,12,0.15)]">
          {isPractice ? (
            <PartyPopper className="h-8 w-8" aria-hidden />
          ) : (
            <ClipboardCheck className="h-8 w-8" aria-hidden />
          )}
        </div>

        <p className="text-sm font-extrabold uppercase tracking-wide text-muted-foreground">
          {isPractice ? "Practice complete" : "Assessment submitted"}
        </p>
        <h1 className="mt-1 font-heading text-2xl font-semibold [text-wrap:balance]">{quiz.title}</h1>

        <p className="mt-6 font-heading text-6xl font-bold text-primary">
          {score}
          <span className="text-3xl text-muted-foreground"> / {total}</span>
        </p>
        <p className="mt-1 text-sm font-extrabold text-muted-foreground">{pct}% correct</p>

        <p className="mx-auto mt-5 max-w-md text-sm font-semibold text-muted-foreground">
          {isPractice
            ? "Practice again any time — each attempt creates a new session."
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
    </div>
  );
}
