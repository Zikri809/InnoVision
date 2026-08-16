"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ClipboardList, Zap, ShieldCheck, Timer, Play, ScanFace, Layers } from "lucide-react";
import { formatDuration } from "@/lib/format/duration";

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
 * Student quizzes dashboard — hero header, quick stats, and chunky quiz cards.
 * Start logic is identical to the previous list (201 → /play/{id}, 409
 * already_attempted → resume/notice, 404 → unavailable).
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

  const practiceCount = quizzes.filter((q) => q.mode === "practice").length;
  const assessmentCount = quizzes.filter((q) => q.mode === "assessment").length;

  return (
    <div className="space-y-8">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 p-7 shadow-[var(--shadow-clay)] md:p-9">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50" />
        <div aria-hidden className="pointer-events-none absolute -bottom-12 left-1/3 h-28 w-28 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-100/60" />
        <div className="relative">
          <span className="inline-flex items-center gap-2 rounded-full border-[3px] border-border bg-card px-3.5 py-1 text-xs font-extrabold text-primary">
            <ClipboardList className="h-4 w-4" aria-hidden /> Available quizzes
          </span>
          <h1 className="mt-4 font-heading text-3xl font-semibold [text-wrap:balance] md:text-4xl">
            Pick a quiz and wave your answer
          </h1>
          <p className="mt-2 max-w-xl text-sm font-semibold text-muted-foreground md:text-base">
            Practice as much as you like, or take a one-shot assessment — your
            hand is the mouse.
          </p>

          {/* quick stats */}
          <div className="mt-6 grid max-w-lg grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay-sm)]">
              <div className="flex items-center gap-2 text-emerald-600">
                <Zap className="h-5 w-5" aria-hidden />
                <span className="font-heading text-2xl font-bold">{practiceCount}</span>
              </div>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">Practice</p>
            </div>
            <div className="rounded-2xl border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay-sm)]">
              <div className="flex items-center gap-2 text-accent">
                <ShieldCheck className="h-5 w-5" aria-hidden />
                <span className="font-heading text-2xl font-bold">{assessmentCount}</span>
              </div>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                {assessmentCount === 1 ? "Assessment" : "Assessments"}
              </p>
            </div>
            <div className="rounded-2xl border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay-sm)] max-sm:col-span-2">
              <div className="flex items-center gap-2 text-primary">
                <ClipboardList className="h-5 w-5" aria-hidden />
                <span className="font-heading text-2xl font-bold">{quizzes.length}</span>
              </div>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">Total live</p>
            </div>
          </div>
        </div>
      </section>

      <div aria-live="polite">
        {error && (
          <p className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>

      {!enrolled && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-[24px] border-[3px] border-amber-300 bg-amber-50 p-5 shadow-[0_4px_0_rgba(217,119,6,0.15)]">
          <div className="flex items-start gap-3.5">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-amber-100 text-amber-700">
              <ScanFace className="h-6 w-6" aria-hidden />
            </span>
            <div>
              <p className="font-heading text-base font-semibold text-amber-800">
                Face enrollment recommended
              </p>
              <p className="mt-1 max-w-md text-sm font-semibold text-amber-700">
                Assessment quizzes use face verification. Enroll now so you&apos;re
                ready when an assessment opens.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => router.push("/student/face/enroll")}
          >
            Enroll your face
          </Button>
        </div>
      )}

      {/* ── Quiz cards ── */}
      {quizzes.length === 0 ? (
        <div className="grid place-items-center rounded-[28px] border-[3px] border-dashed border-border bg-card/60 px-8 py-16 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-orange-100 text-primary">
            <ClipboardList className="h-7 w-7" aria-hidden />
          </span>
          <p className="mt-4 font-heading text-lg font-semibold">No quizzes yet</p>
          <p className="mt-1 max-w-xs text-sm font-semibold text-muted-foreground">
            Check back once your lecturer publishes one for your classes.
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {quizzes.map((q) => {
            const isPractice = q.mode === "practice";
            return (
              <li key={q.id}>
                <Card className="flex h-full flex-col transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[8px_10px_0_rgba(194,65,12,0.16)]">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-3">
                      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${
                        isPractice ? "bg-emerald-100 text-emerald-600" : "bg-blue-100 text-accent"
                      }`}>
                        {isPractice ? <Zap className="h-6 w-6" aria-hidden /> : <ShieldCheck className="h-6 w-6" aria-hidden />}
                      </span>
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                        <span className={`rounded-full border-[3px] px-3 py-1 text-xs font-extrabold ${
                          isPractice
                            ? "border-emerald-300 bg-emerald-100 text-emerald-800"
                            : "border-accent/40 bg-blue-100 text-accent"
                        }`}>
                          {MODE_LABEL[q.mode]}
                        </span>
                        {q.mode === "assessment" && q.time_limit_sec != null && (
                          <span className="inline-flex items-center gap-1 rounded-full border-[3px] border-border bg-muted px-3 py-1 text-xs font-extrabold tabular-nums text-muted-foreground">
                            <Timer className="h-3.5 w-3.5" aria-hidden />
                            {formatDuration(q.time_limit_sec)}
                          </span>
                        )}
                      </div>
                    </div>
                    <CardTitle className="text-lg [text-wrap:balance]">{q.title}</CardTitle>
                    <CardDescription>
                      {q.classes?.title ?? "Class"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="mt-auto flex items-center justify-between gap-3 pt-1">
                    {notice[q.id] ? (
                      <p className="text-sm font-bold text-muted-foreground" role="status">
                        {notice[q.id]}
                      </p>
                    ) : (
                      <span className="text-sm font-semibold text-muted-foreground">
                        {isPractice
                          ? "Unlimited tries"
                          : "One attempt only"}
                      </span>
                    )}
                    <Button
                      variant={isPractice ? "default" : "accent"}
                      onClick={() => handleStart(q.id)}
                      disabled={startingId === q.id}
                    >
                      <Play className="h-4 w-4" aria-hidden />
                      {startingId === q.id ? "Starting…" : "Start"}
                    </Button>
                  </CardContent>
                </Card>
              </li>
            );
          })}

          {/* Balancing tile — points back to classes so a short list never looks stranded. */}
          <li>
            <Link
              href="/student/classes"
              className="group flex h-full min-h-[180px] w-full flex-col items-center justify-center gap-2 rounded-[22px] border-[3px] border-dashed border-border bg-transparent p-6 text-center text-muted-foreground transition-[border-color,color,transform] duration-200 hover:-translate-y-1 hover:border-primary hover:text-primary"
            >
              <span className="grid h-11 w-11 place-items-center rounded-2xl border-[3px] border-current">
                <Layers className="h-5 w-5" aria-hidden />
              </span>
              <span className="text-sm font-extrabold">Browse your classes</span>
              <span className="max-w-[180px] text-xs font-semibold text-muted-foreground">
                Join more classes to unlock more quizzes
              </span>
            </Link>
          </li>
        </ul>
      )}
    </div>
  );
}
