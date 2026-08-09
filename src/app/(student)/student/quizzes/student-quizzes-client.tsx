import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type QuizRow = {
  id: string;
  title: string;
  mode: "practice" | "assessment";
  status: "draft" | "live" | "closed";
  time_limit_sec: number | null;
  created_at: string;
  classes: { title: string } | null;
};

const MODE_LABEL: Record<QuizRow["mode"], string> = {
  practice: "Practice",
  assessment: "Assessment",
};

/**
 * Student quiz list — shows LIVE quizzes from enrolled classes (RLS-filtered
 * server-side). The play screen is Phase 5; for now cards are informational.
 */
export function StudentQuizzesClient({ quizzes }: { quizzes: QuizRow[] }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Available quizzes</h1>
        <p className="text-sm text-muted-foreground">
          Quizzes published by your lecturers appear here.
        </p>
      </div>

      {quizzes.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No quizzes available yet. Check back once your lecturer publishes one.
        </p>
      ) : (
        <ul className="space-y-3">
          {quizzes.map((q) => (
            <li key={q.id}>
              <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                  <div>
                    <CardTitle className="text-lg">{q.title}</CardTitle>
                    <CardDescription>
                      {q.classes?.title ?? "Class"}
                    </CardDescription>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded bg-muted px-2 py-0.5 text-xs">
                      {MODE_LABEL[q.mode]}
                    </span>
                    {q.mode === "assessment" && q.time_limit_sec != null && (
                      <span className="text-xs text-muted-foreground">
                        {q.time_limit_sec}s
                      </span>
                    )}
                  </div>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
