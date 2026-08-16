"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type ClassInfo = {
  id: string;
  title: string;
  join_code: string;
  created_at: string;
};

type RosterEntry = {
  student_id: string;
  enrolled_at: string;
  full_name: string | null;
};

type QuizRow = {
  id: string;
  title: string;
  mode: "practice" | "assessment";
  status: "draft" | "live" | "closed";
  time_limit_sec: number | null;
  created_at: string;
};

const STATUS_LABEL: Record<QuizRow["status"], string> = {
  draft: "Draft",
  live: "Live",
  closed: "Closed",
};

const STATUS_CLASS: Record<QuizRow["status"], string> = {
  draft: "border-border bg-muted text-muted-foreground",
  live: "border-emerald-300 bg-emerald-100 text-emerald-800",
  closed: "border-destructive/40 bg-destructive/10 text-destructive",
};

const MODE_LABEL: Record<QuizRow["mode"], string> = {
  practice: "Practice",
  assessment: "Assessment",
};

const MODE_CLASS: Record<QuizRow["mode"], string> = {
  practice: "border-emerald-300 bg-emerald-100 text-emerald-800",
  assessment: "border-accent/40 bg-blue-100 text-accent",
};

export function ClassDetailClient({
  cls,
  roster,
  quizzes,
}: {
  cls: ClassInfo;
  roster: RosterEntry[];
  quizzes: QuizRow[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"practice" | "assessment">("practice");
  const [timeLimitSec, setTimeLimitSec] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ref lock guards against a fast double-click before React re-renders.
  const submitLock = useRef(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (submitLock.current) return;
    setError(null);
    submitLock.current = true;
    setCreating(true);
    try {
      const res = await fetch(`/api/classes/${cls.id}/quizzes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          mode,
          timeLimitSec: timeLimitSec === "" ? null : Number(timeLimitSec),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? "Failed to create quiz.");
        return;
      }
      setTitle("");
      setTimeLimitSec("");
      router.refresh();
    } catch {
      setError("Network error creating quiz.");
    } finally {
      submitLock.current = false;
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <Link
          href="/lecturer/classes"
          className="text-sm font-bold text-muted-foreground hover:text-primary hover:underline"
        >
          ← Back to classes
        </Link>
        <h1 className="mt-2 font-heading text-2xl font-semibold">{cls.title}</h1>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Join code</CardTitle>
          <CardDescription>
            Share this code with students to enroll them in this class.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="rounded-2xl border-[3px] border-border bg-orange-50 px-4 py-4 text-center font-heading text-3xl font-semibold tracking-[0.4em] text-primary">
            {cls.join_code}
          </p>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Quizzes</CardTitle>
          <CardDescription>
            {quizzes.length} quiz{quizzes.length === 1 ? "" : "zes"} in this class
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="mb-6 space-y-3 rounded-2xl border-[3px] border-border bg-muted/40 p-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
              <div className="space-y-1">
                <Label htmlFor="quiz-title" className="sr-only">
                  Quiz title
                </Label>
                <Input
                  id="quiz-title"
                  placeholder="e.g. Chapter 1 Quiz"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  maxLength={200}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="quiz-mode" className="sr-only">
                  Mode
                </Label>
                <Select value={mode} onValueChange={(v) => setMode(v as "practice" | "assessment")}>
                  <SelectTrigger id="quiz-mode" className="w-40">
                    <SelectValue placeholder="Mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="practice">Practice</SelectItem>
                    <SelectItem value="assessment">Assessment</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="quiz-time-limit" className="sr-only">
                  Time limit (seconds)
                </Label>
                <Input
                  id="quiz-time-limit"
                  type="number"
                  min={1}
                  max={7200}
                  placeholder="Time limit (s)"
                  value={timeLimitSec}
                  onChange={(e) => setTimeLimitSec(e.target.value)}
                  className="w-40"
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold text-muted-foreground">
                Leave the time limit empty for an untimed quiz.
              </p>
              <Button type="submit" disabled={creating || !title.trim()}>
                {creating ? "Creating…" : "New quiz"}
              </Button>
            </div>
            {error && (
              <p className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive" role="alert">
                {error}
              </p>
            )}
          </form>

          {quizzes.length === 0 ? (
            <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-6 text-center text-sm font-semibold text-muted-foreground">
              No quizzes yet. Create one above.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {quizzes.map((q) => (
                <li key={q.id}>
                  <div className="flex items-center justify-between gap-3 rounded-xl px-2 py-3">
                    <Link
                      href={`/lecturer/quizzes/${q.id}/builder`}
                      className="flex min-w-0 items-center gap-3 rounded transition-colors hover:text-primary"
                    >
                      <span className="font-heading text-base font-semibold">{q.title}</span>
                      <span className={`rounded-full border-[3px] px-2.5 py-0.5 text-xs font-extrabold ${MODE_CLASS[q.mode]}`}>
                        {MODE_LABEL[q.mode]}
                      </span>
                    </Link>
                    <div className="flex shrink-0 items-center gap-3">
                      {q.mode === "assessment" && q.time_limit_sec != null && (
                        <span className="text-xs font-bold tabular-nums text-muted-foreground">
                          {q.time_limit_sec}s
                        </span>
                      )}
                      <span
                        className={`rounded-full border-[3px] px-2.5 py-0.5 text-xs font-extrabold ${STATUS_CLASS[q.status]}`}
                      >
                        {STATUS_LABEL[q.status]}
                      </span>
                      {q.status !== "draft" && (
                        <Link
                          href={`/lecturer/quizzes/${q.id}/results`}
                          className="text-xs font-bold text-primary hover:underline"
                        >
                          Results
                        </Link>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Roster</CardTitle>
          <CardDescription>
            {roster.length} enrolled student{roster.length === 1 ? "" : "s"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {roster.length === 0 ? (
            <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-6 text-center text-sm font-semibold text-muted-foreground">
              No students have joined yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {roster.map((s) => (
                <li key={s.student_id} className="flex items-center justify-between py-2.5">
                  <span className="font-heading text-base font-semibold">{s.full_name ?? "Unnamed student"}</span>
                  <span className="text-xs font-bold text-muted-foreground">
                    Joined {new Date(s.enrolled_at).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
