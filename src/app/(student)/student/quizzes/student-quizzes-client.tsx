"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
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
 * server-side). Each card has a Start action:
 *  - 201 → navigate to /play/{session.id}. For practice this may be an EXISTING
 *    non-terminal session id (rejoin) — expected, not a bug.
 *  - 409 `already_attempted` → if the payload session is still active/paused,
 *    show a "Resume" action (a student who navigated away mid-assessment can
 *    get back in); if completed, show "You've already taken this assessment".
 *  - 404 → "This quiz is no longer available".
 */
export function StudentQuizzesClient({ quizzes }: { quizzes: QuizRow[] }) {
  const router = useRouter();
  // Ref lock guards against a fast double-click before React re-renders.
  const submitLock = useRef(false);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Record<string, string>>({});

  async function handleStart(quizId: string) {
    if (submitLock.current) return;
    setError(null);
    submitLock.current = true;
    setStartingId(quizId);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quizId }),
      });
      const body = await res.json().catch(() => ({}));

      if (res.ok && body.session?.id) {
        router.push(`/play/${body.session.id}`);
        return;
      }

      if (res.status === 409 && body.error === "already_attempted") {
        // The play page disambiguates the payload's session_id: an active /
        // paused session resumes (starts at the first unanswered question); a
        // completed one renders the EndScreen's clean "already taken" message
        // (E5 — no 500). This is strictly more robust than trying to guess the
        // status from the quiz list (the payload carries no status).
        if (body.session_id) {
          router.push(`/play/${body.session_id}`);
          return;
        }
        setNotice((prev) => ({
          ...prev,
          [quizId]: "You have already taken this assessment.",
        }));
        return;
      }

      if (res.status === 404) {
        setError("This quiz is no longer available.");
        return;
      }

      setError(body.message ?? body.error ?? "Could not start the quiz.");
    } catch {
      setError("Network error starting the quiz.");
    } finally {
      submitLock.current = false;
      setStartingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Available quizzes</h1>
        <p className="text-sm text-muted-foreground">
          Quizzes published by your lecturers appear here.
        </p>
      </div>

      {error && (
        <p className="mb-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

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
                <CardContent className="flex items-center justify-between gap-3">
                  {notice[q.id] ? (
                    <p className="text-sm text-muted-foreground" role="status">
                      {notice[q.id]}
                    </p>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {q.mode === "assessment"
                        ? "One attempt only."
                        : "Answer as many times as you like."}
                    </span>
                  )}
                  <Button
                    onClick={() => handleStart(q.id)}
                    disabled={startingId === q.id}
                  >
                    {startingId === q.id ? "Starting…" : "Start"}
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
