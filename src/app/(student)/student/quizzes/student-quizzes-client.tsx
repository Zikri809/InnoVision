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
 *
 * P7: when the student is NOT enrolled for face verification, an enroll banner
 * links to /student/face/enroll (assessment quizzes require enrollment).
 */
export function StudentQuizzesClient({
  quizzes,
  enrolled,
}: {
  quizzes: QuizRow[];
  enrolled: boolean;
}) {
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
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold">Available quizzes</h1>
        <p className="mt-1 text-sm font-semibold text-muted-foreground">
          Quizzes published by your lecturers appear here.
        </p>
      </div>

      <div aria-live="polite">
        {error && (
          <p className="mb-4 rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>

      {!enrolled && (
        <div className="mb-5 rounded-2xl border-[3px] border-amber-300 bg-amber-50 p-5 shadow-[0_4px_0_rgba(217,119,6,0.15)]">
          <p className="font-heading text-base font-semibold text-amber-800">
            Face enrollment recommended
          </p>
          <p className="mt-1.5 text-sm font-semibold text-amber-700">
            Assessment quizzes use face verification. Enroll now so you&apos;re
            ready when an assessment opens.
          </p>
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => router.push("/student/face/enroll")}
          >
            Enroll your face
          </Button>
        </div>
      )}

      {quizzes.length === 0 ? (
        <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-8 text-center text-sm font-semibold text-muted-foreground">
          No quizzes available yet. Check back once your lecturer publishes one.
        </p>
      ) : (
        <ul className="space-y-4">
          {quizzes.map((q) => (
            <li key={q.id}>
              <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                  <div className="min-w-0">
                    <CardTitle className="text-lg">{q.title}</CardTitle>
                    <CardDescription>
                      {q.classes?.title ?? "Class"}
                    </CardDescription>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`rounded-full border-[3px] px-3 py-1 text-xs font-extrabold ${
                      q.mode === "practice"
                        ? "border-emerald-300 bg-emerald-100 text-emerald-800"
                        : "border-accent/40 bg-blue-100 text-accent"
                    }`}>
                      {MODE_LABEL[q.mode]}
                    </span>
                    {q.mode === "assessment" && q.time_limit_sec != null && (
                      <span className="rounded-full border-[3px] border-border bg-muted px-3 py-1 text-xs font-extrabold tabular-nums text-muted-foreground">
                        {q.time_limit_sec}s
                      </span>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-3">
                  {notice[q.id] ? (
                    <p className="text-sm font-bold text-muted-foreground" role="status">
                      {notice[q.id]}
                    </p>
                  ) : (
                    <span className="text-sm font-semibold text-muted-foreground">
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
