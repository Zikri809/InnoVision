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
import { ArrowLeft, Check, Copy } from "lucide-react";
import { formatDuration } from "@/lib/format/duration";

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

import { HOURS_MAX, MINUTES_MAX, hmToSeconds } from "@/lib/quizzes/time-limit";
import { TITLE_MAX } from "@/lib/quizzes/validation";
import { MODE_CLASS, MODE_LABEL, STATUS_CLASS, STATUS_LABEL } from "@/lib/quizzes/labels";
import type { QuizMode } from "@/lib/types/aliases";

const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : DATE_FMT.format(d);
}

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
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Ref lock guards against a fast double-click before React re-renders.
  const submitLock = useRef(false);

  function blockNonNumeric(e: React.KeyboardEvent<HTMLInputElement>) {
    if (["e", "E", "+", "-", "."].includes(e.key)) {
      e.preventDefault();
    }
  }

  async function copyJoinCode() {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(cls.join_code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyError("Could not copy the join code.");
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (submitLock.current) return;
    setError(null);
    submitLock.current = true;
    setCreating(true);
    try {
      const timeLimitSec =
        mode === "practice"
          ? null
          : (hours === "" && minutes === "" ? null : hmToSeconds(Number(hours) || 0, Number(minutes) || 0));

      const res = await fetch(`/api/classes/${cls.id}/quizzes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          mode,
          timeLimitSec,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? "Failed to create quiz.");
        return;
      }
      setTitle("");
      setHours("");
      setMinutes("");
      router.refresh();
    } catch {
      setError("Network error creating quiz.");
    } finally {
      submitLock.current = false;
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 p-7 shadow-[var(--shadow-clay)] md:p-8">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50" />
        <div className="relative">
          <Link
            href="/lecturer/classes"
            className="inline-flex items-center gap-1.5 text-sm font-extrabold text-muted-foreground transition-colors hover:text-primary"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> Back to classes
          </Link>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-6">
            <div className="min-w-0">
              <h1 className="font-heading text-3xl font-semibold [text-wrap:balance]">{cls.title}</h1>
              <p className="mt-1.5 text-sm font-semibold text-muted-foreground">
                {roster.length} {roster.length === 1 ? "student" : "students"} · {quizzes.length} {quizzes.length === 1 ? "quiz" : "quizzes"}
              </p>
            </div>
            {/* Join code */}
            <div className="rounded-2xl border-[3px] border-border bg-card px-5 py-4 text-center shadow-[var(--shadow-clay-sm)]">
              <p className="text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">Join code</p>
              <div className="mt-0.5 flex items-center justify-center gap-2">
                <p className="font-heading text-2xl font-bold tracking-[0.3em] text-primary">
                  {cls.join_code}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={copyJoinCode}
                  aria-label={copied ? "Join code copied" : "Copy join code"}
                >
                  {copied ? (
                    <Check className="size-4" aria-hidden />
                  ) : (
                    <Copy className="size-4" aria-hidden />
                  )}
                </Button>
              </div>
              {copyError && (
                <p className="mt-1 text-xs font-bold text-destructive" role="alert">
                  {copyError}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      <Card>
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
                  disabled={creating}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  maxLength={TITLE_MAX}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="quiz-mode" className="sr-only">
                  Mode
                </Label>
                <Select
                  value={mode}
                  onValueChange={(v) => setMode(v as "practice" | "assessment")}
                  disabled={creating}
                >
                  <SelectTrigger id="quiz-mode" className="w-full sm:w-40">
                    <SelectValue placeholder="Select mode">
                      {(v) => MODE_LABEL[v as QuizMode] ?? (v === "assessment" ? "Assessment" : "Practice")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="practice">Practice</SelectItem>
                    <SelectItem value="assessment">Assessment</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-1.5">
                <div className="space-y-1">
                  <Label htmlFor="quiz-time-hours" className="sr-only">
                    Time limit (hours)
                  </Label>
                  <Input
                    id="quiz-time-hours"
                    type="number"
                    min={0}
                    max={HOURS_MAX}
                    placeholder="0"
                    value={hours}
                    disabled={creating || mode === "practice"}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={blockNonNumeric}
                    aria-describedby="quiz-create-time-helper"
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "") {
                        setHours("");
                        return;
                      }
                      const num = Number(val);
                      if (Number.isNaN(num)) return;
                      const clamped = Math.max(0, Math.min(HOURS_MAX, Math.trunc(num)));
                      setHours(String(clamped));
                      if (clamped === HOURS_MAX) {
                        setMinutes("");
                      }
                    }}
                    className="w-16 text-center placeholder:text-center [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </div>
                <span aria-hidden className="pb-2.5 text-xs font-extrabold text-muted-foreground">h</span>
                <div className="space-y-1">
                  <Label htmlFor="quiz-time-minutes" className="sr-only">
                    Time limit (minutes)
                  </Label>
                  <Input
                    id="quiz-time-minutes"
                    type="number"
                    min={0}
                    max={MINUTES_MAX}
                    placeholder="0"
                    value={minutes}
                    disabled={creating || mode === "practice" || Number(hours) === HOURS_MAX}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={blockNonNumeric}
                    aria-describedby="quiz-create-time-helper"
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "") {
                        setMinutes("");
                        return;
                      }
                      const num = Number(val);
                      if (Number.isNaN(num)) return;
                      const clamped = Math.max(0, Math.min(MINUTES_MAX, Math.trunc(num)));
                      setMinutes(String(clamped));
                    }}
                    className="w-16 text-center placeholder:text-center [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </div>
                <span aria-hidden className="pb-2.5 text-xs font-extrabold text-muted-foreground">min</span>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p id="quiz-create-time-helper" className="text-xs font-semibold text-muted-foreground">
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
                      className="flex min-w-0 items-center gap-3 rounded-xl transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/70"
                    >
                      <span className="truncate font-heading text-base font-semibold">{q.title}</span>
                      <span className={`rounded-full border-[3px] px-2.5 py-0.5 text-xs font-extrabold ${MODE_CLASS[q.mode]}`}>
                        {MODE_LABEL[q.mode]}
                      </span>
                    </Link>
                    <div className="flex shrink-0 items-center gap-3">
                      {q.mode === "assessment" && q.time_limit_sec != null && (
                        <span className="text-xs font-bold tabular-nums text-muted-foreground">
                          {formatDuration(q.time_limit_sec)}
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
            <div className="grid place-items-center rounded-2xl border-[3px] border-dashed border-border bg-card/60 px-6 py-10 text-center">
              <p className="font-heading text-base font-semibold">No students yet</p>
              <p className="mt-1 text-sm font-semibold text-muted-foreground">
                Share the join code above to enroll your first student.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {roster.map((s) => (
                <li key={s.student_id} className="flex items-center justify-between gap-3 py-3">
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-orange-100 font-heading text-sm font-bold text-primary">
                      {(s.full_name ?? "U").trim().charAt(0).toUpperCase()}
                    </span>
                    <span translate="no" className="truncate font-heading text-base font-semibold">{s.full_name ?? "Unnamed student"}</span>
                  </span>
                  <span className="shrink-0 text-xs font-bold text-muted-foreground">
                    Joined {formatDate(s.enrolled_at)}
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
