import Link from "next/link";
import { Button } from "@/components/ui/button";

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
 * EndScreen — final score / total with a mode-aware message and a link back
 * to the quizzes list. Practice shows a "Try again" (start creates a new
 * session — D2); assessment does not (one attempt). Uses role="status".
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

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">{quiz.title}</h1>
        <p className="text-sm text-muted-foreground">
          {isPractice ? "Practice" : "Assessment"}
        </p>
      </div>

      <div className="rounded-xl border bg-card p-8 text-center" role="status">
        <p className="text-sm text-muted-foreground">Your score</p>
        <p className="mt-2 text-5xl font-semibold">
          {score} <span className="text-2xl text-muted-foreground">/ {total}</span>
        </p>
        {isPractice ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Practice again any time — each attempt creates a new session.
          </p>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            You have completed this assessment. It can only be taken once.
          </p>
        )}
        <div className="mt-6 flex justify-center gap-3">
          <Link href="/student/quizzes">
            <Button variant="outline">Back to quizzes</Button>
          </Link>
          {isPractice && (
            <Link href="/student/quizzes">
              <Button>Try again</Button>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
