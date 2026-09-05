"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { Switch } from "@/components/ui/switch";
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
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  ArrowLeft,
  Copy,
  CopyPlus,
  Archive,
  RotateCcw,
  Loader2,
  BarChart3,
} from "lucide-react";
import { formatDuration } from "@/lib/format/duration";
import { windowLocalInputToIso } from "@/lib/format/window";
import { HOURS_MAX, MINUTES_MAX, hmToSeconds } from "@/lib/quizzes/time-limit";
import { TITLE_MAX } from "@/lib/quizzes/validation";
import { MODE_CLASS, STATUS_CLASS, getModeLabel, getStatusLabel } from "@/lib/quizzes/labels";
import { DuplicateQuizDialog } from "@/components/quiz/duplicate-quiz-dialog";
import type { QuizMode } from "@/lib/types/aliases";

type ClassInfo = {
  id: string;
  title: string;
  join_code: string;
  created_at: string;
  archived_at?: string | null;
};

type RosterEntry = {
  student_id: string;
  enrolled_at: string;
  full_name: string | null;
  matric_no?: string | null;
};

type QuizRow = {
  id: string;
  class_id: string;
  title: string;
  mode: "practice" | "assessment";
  status: "draft" | "live" | "closed";
  time_limit_sec: number | null;
  created_at: string;
};

export function ClassDetailClient({
  cls,
  roster,
  quizzes,
  ownedClasses,
}: {
  cls: ClassInfo;
  roster: RosterEntry[];
  quizzes: QuizRow[];
  /** AP-2: owned, unarchived classes — duplicate destination options. */
  ownedClasses: Array<{ id: string; title: string }>;
}) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("lecturer.classDetail");
  const tCommon = useTranslations("common");

  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"practice" | "assessment">("practice");
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  // QC-3: optional availability window at creation (datetime-local inputs;
  // converted to UTC ISO instants once at the client boundary).
  const [opensAt, setOpensAt] = useState("");
  const [closesAt, setClosesAt] = useState("");
  // Retake config (QC-4): assessment-only concept.
  const [allowRetake, setAllowRetake] = useState(false);
  const [maxAttempts, setMaxAttempts] = useState(2);
  // QT-3: per-student question/option shuffling (applies to BOTH modes).
  const [shuffleQuestions, setShuffleQuestions] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // AP-2: quiz duplication from the class quiz list.
  const [duplicateQuiz, setDuplicateQuiz] = useState<QuizRow | null>(null);

  // Ref lock guards against a fast double-click before React re-renders.
  const submitLock = useRef(false);

  function formatDate(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const dateFmt = new Intl.DateTimeFormat(locale === "ms" ? "ms-MY" : "en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "Asia/Kuala_Lumpur",
    });
    return dateFmt.format(d);
  }

  function blockNonNumeric(e: React.KeyboardEvent<HTMLInputElement>) {
    if (["e", "E", "+", "-", "."].includes(e.key)) {
      e.preventDefault();
    }
  }

  async function copyJoinCode() {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(cls.join_code);
      toast.success(t("joinCodeCopied"));
    } catch {
      setCopyError(t("copyJoinCodeError"));
    }
  }

  async function handleArchiveClass() {
    if (submitLock.current) return;
    setArchiveError(null);
    submitLock.current = true;
    setArchiving(true);
    try {
      const res = await fetch(`/api/classes/${cls.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setArchiveError(body.message ?? body.error ?? t("archiveClassError"));
        return;
      }
      setArchiveDialogOpen(false);
      router.push("/lecturer/classes/archived");
      router.refresh();
    } catch {
      setArchiveError(t("archiveClassError"));
    } finally {
      submitLock.current = false;
      setArchiving(false);
    }
  }

  async function handleRestoreClass() {
    if (submitLock.current) return;
    setRestoreError(null);
    submitLock.current = true;
    setRestoring(true);
    try {
      const res = await fetch(`/api/classes/${cls.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRestoreError(body.message ?? body.error ?? t("restoreClassError"));
        return;
      }
      setRestoreDialogOpen(false);
      router.refresh();
    } catch {
      setRestoreError(t("restoreClassError"));
    } finally {
      submitLock.current = false;
      setRestoring(false);
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

      const newOpens = windowLocalInputToIso(opensAt);
      const newCloses = windowLocalInputToIso(closesAt);

      const res = await fetch(`/api/classes/${cls.id}/quizzes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          mode,
          timeLimitSec,
          opensAt: newOpens,
          closesAt: newCloses,
          allowRetake: mode === "assessment" ? allowRetake : undefined,
          maxAttempts: mode === "assessment" && allowRetake ? maxAttempts : undefined,
          shuffleQuestions,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      setTitle("");
      setHours("");
      setMinutes("");
      setOpensAt("");
      setClosesAt("");
      setAllowRetake(false);
      setMaxAttempts(2);
      setShuffleQuestions(false);
      router.refresh();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      submitLock.current = false;
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 dark:from-orange-950/40 dark:via-card dark:to-blue-950/40 p-7 shadow-[var(--shadow-clay)] md:p-8">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50 dark:bg-white/5" />
        <div aria-hidden className="pointer-events-none absolute -bottom-12 left-1/3 h-28 w-28 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-100/60 dark:bg-blue-500/5" />
        <div className="relative">
          <div className="flex items-center justify-between gap-4">
            <Link
              href={cls.archived_at ? "/lecturer/classes/archived" : "/lecturer/classes"}
              className="inline-flex items-center gap-1.5 text-sm font-extrabold text-muted-foreground transition-colors hover:text-primary"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden /> {t("backToClasses")}
            </Link>
            {cls.archived_at ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setRestoreError(null);
                  setRestoreDialogOpen(true);
                }}
                className="border-[3px] border-primary/40 bg-card/90 text-xs font-extrabold text-primary hover:bg-primary hover:text-primary-foreground hover:border-primary transition-all shadow-[var(--shadow-clay-sm)]"
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {t("restoreClass")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setArchiveError(null);
                  setArchiveDialogOpen(true);
                }}
                className="border-[3px] border-amber-600/30 bg-card/90 text-xs font-extrabold text-amber-800 hover:bg-amber-100 hover:text-amber-950 hover:border-amber-600/60 dark:border-amber-500/60 dark:bg-amber-500/25 dark:text-amber-200 dark:hover:bg-amber-500/40 dark:hover:text-amber-100 transition-all shadow-[var(--shadow-clay-sm)]"
              >
                <Archive className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {t("archiveClass")}
              </Button>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-end justify-between gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <h1 className="font-heading text-3xl font-semibold [text-wrap:balance]">{cls.title}</h1>
                {cls.archived_at && (
                  <span className="rounded-full border-[3px] border-amber-600/40 bg-amber-100 px-3 py-0.5 text-xs font-extrabold text-amber-800 uppercase tracking-wider dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300">
                    {t("isArchivedBadge")}
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-sm font-semibold text-muted-foreground">
                {t("rosterCount", { count: roster.length })} · {t("quizCount", { count: quizzes.length })}
              </p>
            </div>
            {/* Join code */}
            <div className="rounded-2xl border-[3px] border-border bg-card px-5 py-4 text-center shadow-[var(--shadow-clay-sm)]">
              <p className="text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">{t("joinCode")}</p>
              <div className="mt-0.5 flex items-center justify-center gap-2">
                <p className="font-heading text-2xl font-bold tracking-[0.3em] text-primary">
                  {cls.join_code}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={copyJoinCode}
                  aria-label={t("copyJoinCode")}
                >
                  <Copy className="size-4" aria-hidden />
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

      {/* ── Archived class warning banner ── */}
      {cls.archived_at && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border-[3px] border-amber-400/60 bg-amber-50 p-5 text-amber-900 shadow-[var(--shadow-clay-sm)] dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-200/80 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
              <Archive className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <p className="text-sm font-bold text-amber-950 dark:text-amber-100">
                {t("isArchivedBadge")}
              </p>
              <p className="text-xs font-semibold text-amber-900/90 dark:text-amber-200/80">
                {t("archivedBannerNotice")}
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setRestoreError(null);
              setRestoreDialogOpen(true);
            }}
            className="shrink-0 font-extrabold"
          >
            <RotateCcw className="mr-1.5 h-4 w-4" aria-hidden />
            {t("restoreClass")}
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>{t("classQuizzes")}</CardTitle>
            <Link
              href={`/lecturer/classes/${cls.id}/gradebook`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <BarChart3 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {t("gradebookLink")}
            </Link>
          </div>
          <CardDescription>
            {t("quizCount", { count: quizzes.length })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!cls.archived_at && (
            <form onSubmit={handleCreate} className="mb-6 space-y-3 rounded-2xl border-[3px] border-border bg-muted/40 p-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
                <div className="space-y-1">
                  <Label htmlFor="quiz-title" className="sr-only">
                    {t("createQuizTitle")}
                  </Label>
                  <Input
                    id="quiz-title"
                    // Stable accessible name for E2E (the sr-only Label's
                    // text follows i18n copy, which drifted from the specs).
                    aria-label="Quiz title"
                    placeholder={t("quizTitlePlaceholder")}
                    value={title}
                    disabled={creating}
                    onChange={(e) => setTitle(e.target.value)}
                    required
                    maxLength={TITLE_MAX}
                  />
                </div>
              <div className="space-y-1">
                <Label htmlFor="quiz-mode" className="sr-only">
                  {t("modeLabel")}
                </Label>
                <Select
                  value={mode}
                  onValueChange={(v) => setMode(v as "practice" | "assessment")}
                  disabled={creating}
                >
                  <SelectTrigger
                    id="quiz-mode"
                    aria-label="Mode"
                    className="w-full sm:w-auto sm:min-w-[12rem]"
                  >

                    <SelectValue placeholder={t("modeLabel")}>
                      {(v) => getModeLabel(v as QuizMode, locale)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="practice">{tCommon("practice")}</SelectItem>
                    <SelectItem value="assessment">{tCommon("assessment")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="space-y-1">
                  <Label htmlFor="quiz-time-hours" className="sr-only">
                    {t("hoursShort")}
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
                <span aria-hidden className="text-xs font-extrabold text-muted-foreground">{t("hoursShort")}</span>
                <div className="space-y-1">
                  <Label htmlFor="quiz-time-minutes" className="sr-only">
                    {t("minutesShort")}
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
                <span aria-hidden className="text-xs font-extrabold text-muted-foreground">{t("minutesShort")}</span>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <DateTimePicker
                  id="quiz-opens-at"
                  ariaLabel={t("windowOpensLabel")}
                  value={opensAt}
                  onChange={setOpensAt}
                  disabled={creating}
                  placeholder={t("windowPlaceholder")}
                  buttonClassName="w-full sm:w-52"
                />
                <span aria-hidden className="text-xs font-extrabold text-muted-foreground">–</span>
                <DateTimePicker
                  id="quiz-closes-at"
                  ariaLabel={t("windowClosesLabel")}
                  value={closesAt}
                  onChange={setClosesAt}
                  disabled={creating}
                  placeholder={t("windowPlaceholder")}
                  buttonClassName="w-full sm:w-52"
                />
              </div>
            </div>
            {mode === "assessment" && (
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2.5 text-sm font-semibold text-foreground cursor-pointer">
                  <Switch
                    checked={allowRetake}
                    onCheckedChange={(checked) => setAllowRetake(checked)}
                    disabled={creating}
                  />
                  {t("retakeAllow")}
                </label>
                {allowRetake && (
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="quiz-max-attempts" className="text-xs font-extrabold text-foreground">
                      {t("retakeMaxAttempts")}
                    </Label>
                    <select
                      id="quiz-max-attempts"
                      value={maxAttempts}
                      onChange={(e) => setMaxAttempts(Math.trunc(Number(e.target.value)) || 1)}
                      disabled={creating}
                      className="rounded-lg border-[3px] border-border bg-card px-2 py-1 text-sm font-bold"
                    >
                      <option value={2}>2</option>
                      <option value={3}>3</option>
                    </select>
                  </div>
                )}
              </div>
            )}
            <div className="space-y-1">
              <label className="flex items-center gap-2.5 text-sm font-semibold text-foreground cursor-pointer">
                <Switch
                  checked={shuffleQuestions}
                  onCheckedChange={(checked) => setShuffleQuestions(checked)}
                  disabled={creating}
                />
                {t("shuffleQuestions")}
              </label>
              <p className="text-xs font-semibold text-muted-foreground">{t("shuffleQuestionsHelper")}</p>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
              <p id="quiz-create-time-helper" className="text-xs font-semibold text-muted-foreground">
                {opensAt || closesAt
                  ? t("windowHelperSet")
                  : mode === "practice"
                    ? (locale === "ms" ? "Kuiz latihan tidak dihadkan masa." : "Practice quizzes are untimed.")
                    : (hours || minutes)
                      ? t("timeLimitHelperSet", { hours: hours || "0", minutes: minutes || "0" })
                      : t("timeLimitHelperNone")}
              </p>

              <Button type="submit" disabled={creating || !title.trim()}>
                {creating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                    {t("creatingQuizBtn")}
                  </>
                ) : (
                  t("createQuizBtn")
                )}
              </Button>
            </div>

            {error && (
              <p className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive" role="alert">
                {error}
              </p>
            )}
          </form>
          )}

          {quizzes.length === 0 ? (
            <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-6 text-center text-sm font-semibold text-muted-foreground">
              {t("noQuizzes")}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {quizzes.map((q) => (
                <li key={q.id}>
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl px-2 py-3">
                    <Link
                      href={`/lecturer/quizzes/${q.id}/builder`}
                      className="flex min-w-0 items-center gap-3 rounded-xl transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/70"
                    >
                      <span className="truncate font-heading text-base font-semibold">{q.title}</span>
                      <span className={`rounded-full border-[3px] px-2.5 py-0.5 text-xs font-extrabold ${MODE_CLASS[q.mode]}`}>
                        {getModeLabel(q.mode, locale)}
                      </span>
                    </Link>
                    <div className="flex shrink-0 items-center gap-3">
                      {q.mode === "assessment" && q.time_limit_sec != null && (
                        <span className="text-xs font-bold tabular-nums text-muted-foreground">
                          {formatDuration(q.time_limit_sec, locale)}
                        </span>
                      )}
                      <span
                        className={`rounded-full border-[3px] px-2.5 py-0.5 text-xs font-extrabold ${STATUS_CLASS[q.status]}`}
                      >
                        {getStatusLabel(q.status, locale)}
                      </span>
                      {q.status !== "draft" && (
                        <Link
                          href={`/lecturer/quizzes/${q.id}/results`}
                          className="text-xs font-bold text-primary hover:underline"
                          aria-label={`${t("resultsBtn")} - ${q.title}`}
                        >
                          {t("resultsBtn")}
                        </Link>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 rounded-full border-[3px] px-2.5"
                        onClick={() => setDuplicateQuiz(q)}
                        aria-haspopup="dialog"
                        aria-label={`${t("duplicateBtn")} - ${q.title}`}
                      >
                        <CopyPlus className="size-4" aria-hidden="true" />
                      </Button>
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
          <CardTitle>{t("rosterTitle")}</CardTitle>
          <CardDescription>
            {t("rosterCount", { count: roster.length })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {roster.length === 0 ? (
            <div className="grid place-items-center rounded-2xl border-[3px] border-dashed border-border bg-card/60 px-6 py-10 text-center">
              <p className="font-heading text-base font-semibold">{t("noStudents")}</p>
              <p className="mt-1 text-sm font-semibold text-muted-foreground">
                {t("joinCode")}
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
                    <span className="min-w-0">
                      <span translate="no" className="block truncate font-heading text-base font-semibold">{s.full_name ?? t("unnamedStudent")}</span>
                      {s.matric_no && (
                        <span className="font-mono text-xs font-bold text-muted-foreground">{s.matric_no}</span>
                      )}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs font-bold text-muted-foreground">
                    {t("joinedOn", { date: formatDate(s.enrolled_at) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── AP-2 duplicate-quiz dialog ── */}
      <DuplicateQuizDialog
        quizId={duplicateQuiz?.id ?? ""}
        quizTitle={duplicateQuiz?.title ?? ""}
        sourceClassId={duplicateQuiz?.class_id ?? cls.id}
        // Unarchived owned classes only (see duplicate-quiz-dialog).
        classes={ownedClasses}
        open={duplicateQuiz !== null}
        onOpenChange={(open) => {
          if (!open) setDuplicateQuiz(null);
        }}
      />

      {/* ── Archive class confirmation dialog ── */}
      <ResponsiveModal
        open={archiveDialogOpen}
        onOpenChange={(open) => {
          if (!open && archiving) return;
          setArchiveDialogOpen(open);
        }}
      >
        <ResponsiveModalContent className="sm:max-w-md">
          <ResponsiveModalHeader>
            <div className="mb-2 grid h-12 w-12 place-items-center rounded-2xl border-[3px] border-amber-600/20 bg-amber-100 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300">
              <Archive className="h-6 w-6" aria-hidden />
            </div>
            <ResponsiveModalTitle className="font-heading text-xl font-bold text-foreground">
              {t("archiveClassTitle")}
            </ResponsiveModalTitle>
            <ResponsiveModalDescription className="pt-1 text-sm font-semibold text-muted-foreground">
              {t("archiveClassDescription", { title: cls.title })}
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>

          {archiveError && (
            <p className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive" role="alert">
              {archiveError}
            </p>
          )}

          <ResponsiveModalFooter className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={archiving}
              onClick={() => setArchiveDialogOpen(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button
              type="button"
              variant="default"
              disabled={archiving}
              onClick={handleArchiveClass}
              className="bg-amber-600 hover:bg-amber-700 text-white font-extrabold dark:bg-amber-500 dark:hover:bg-amber-400 dark:text-amber-950"
            >
              {archiving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  {t("archiveClassArchivingBtn")}
                </>
              ) : (
                <>
                  <Archive className="mr-2 h-4 w-4" aria-hidden />
                  {t("archiveClassConfirmBtn")}
                </>
              )}
            </Button>
          </ResponsiveModalFooter>
        </ResponsiveModalContent>
      </ResponsiveModal>

      {/* ── Restore class confirmation dialog ── */}
      <ResponsiveModal
        open={restoreDialogOpen}
        onOpenChange={(open) => {
          if (!open && restoring) return;
          setRestoreDialogOpen(open);
        }}
      >
        <ResponsiveModalContent className="sm:max-w-md">
          <ResponsiveModalHeader>
            <div className="mb-2 grid h-12 w-12 place-items-center rounded-2xl border-[3px] border-primary/20 bg-primary/10 text-primary">
              <RotateCcw className="h-6 w-6" aria-hidden />
            </div>
            <ResponsiveModalTitle className="font-heading text-xl font-bold text-foreground">
              {t("restoreClassTitle")}
            </ResponsiveModalTitle>
            <ResponsiveModalDescription className="pt-1 text-sm font-semibold text-muted-foreground">
              {t("restoreClassDescription", { title: cls.title })}
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>

          {restoreError && (
            <p className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive" role="alert">
              {restoreError}
            </p>
          )}

          <ResponsiveModalFooter className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={restoring}
              onClick={() => setRestoreDialogOpen(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button
              type="button"
              variant="default"
              disabled={restoring}
              onClick={handleRestoreClass}
            >
              {restoring ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  {t("restoreClassRestoringBtn")}
                </>
              ) : (
                <>
                  <RotateCcw className="mr-2 h-4 w-4" aria-hidden />
                  {t("restoreClassConfirmBtn")}
                </>
              )}
            </Button>
          </ResponsiveModalFooter>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}
