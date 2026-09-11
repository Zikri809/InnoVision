"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Copy,
  CopyPlus,
  Archive,
  RotateCcw,
  Loader2,
  BarChart3,
  Plus,
  MoreVertical,
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

  // Mobile redesign: segmented tabs & drawer quiz creator
  const [activeTab, setActiveTab] = useState<"quizzes" | "roster">("quizzes");
  // ?newQuiz=1 (dock FAB deep link) auto-opens the create form on arrival;
  // the param is stripped (history-replace) so refresh/back doesn't re-open it.
  // State starts false so SSR doesn't touch window; the effect below opens it.
  const [createQuizModalOpen, setCreateQuizModalOpen] = useState(false);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("newQuiz")) return;
    const params = new URLSearchParams(window.location.search);
    params.delete("newQuiz");
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : window.location.pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read-once external init: the deep link lives in window.location.search, unreadable during SSR
    setCreateQuizModalOpen(true);
  }, [router]);

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
      setCreateQuizModalOpen(false);
      router.refresh();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      submitLock.current = false;
      setCreating(false);
    }
  }

  function renderQuizForm(isModal: boolean = false) {
    if (isModal) {
      // Mobile drawer variant: stacked fields with visible labels, segmented
      // mode control, error on top. The CTA lives in the drawer's pinned
      // footer via the form="quiz-create-form" association; a `hidden sm:flex`
      // fallback row covers the drawer→dialog swap (≥640px while open), where
      // the footer prop is ignored.
      return (
        <form
          id="quiz-create-form"
          onSubmit={handleCreate}
          className="space-y-4"
        >
          {error && (
            <p
              role="alert"
              className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive"
            >
              {error}
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="quiz-title-modal">{t("quizTitleLabel")}</Label>
            <Input
              id="quiz-title-modal"
              placeholder={t("quizTitlePlaceholder")}
              value={title}
              disabled={creating}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={TITLE_MAX}
            />
          </div>

          <div className="space-y-1.5">
            <span className="text-sm font-bold leading-none text-foreground">{t("modeLabel")}</span>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                aria-pressed={mode === "practice"}
                onClick={() => setMode("practice")}
                disabled={creating}
                className={cn(
                  "h-11 rounded-xl border-[3px] px-3 text-sm font-extrabold transition-all",
                  mode === "practice"
                    ? "border-primary bg-primary text-primary-foreground shadow-[0_2px_0_var(--primary-deep)]"
                    : "border-border bg-card text-muted-foreground shadow-[0_2px_0_var(--border)] hover:border-primary/40 hover:text-foreground"
                )}
              >
                {tCommon("practice")}
              </button>
              <button
                type="button"
                aria-pressed={mode === "assessment"}
                onClick={() => setMode("assessment")}
                disabled={creating}
                className={cn(
                  "h-11 rounded-xl border-[3px] px-3 text-sm font-extrabold transition-all",
                  mode === "assessment"
                    ? "border-primary bg-primary text-primary-foreground shadow-[0_2px_0_var(--primary-deep)]"
                    : "border-border bg-card text-muted-foreground shadow-[0_2px_0_var(--border)] hover:border-primary/40 hover:text-foreground"
                )}
              >
                {tCommon("assessment")}
              </button>
            </div>
            <p className="text-xs font-semibold text-muted-foreground">
              {mode === "practice" ? t("modePractice") : t("modeAssessment")}
            </p>
          </div>

          <div className="space-y-2">
            <span className="text-sm font-bold leading-none text-foreground">{t("windowGroupLabel")}</span>
            <div className="space-y-1">
              <Label htmlFor="quiz-opens-at-modal" className="text-xs font-extrabold text-muted-foreground">
                {t("windowOpensLabel")}
              </Label>
              <DateTimePicker
                id="quiz-opens-at-modal"
                ariaLabel={t("windowOpensLabel")}
                value={opensAt}
                onChange={setOpensAt}
                disabled={creating}
                placeholder={t("windowPlaceholder")}
                className="w-full"
                buttonClassName="w-full"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="quiz-closes-at-modal" className="text-xs font-extrabold text-muted-foreground">
                {t("windowClosesLabel")}
              </Label>
              <DateTimePicker
                id="quiz-closes-at-modal"
                ariaLabel={t("windowClosesLabel")}
                value={closesAt}
                onChange={setClosesAt}
                disabled={creating}
                placeholder={t("windowPlaceholder")}
                className="w-full"
                buttonClassName="w-full"
              />
            </div>
          </div>

          {mode === "assessment" && (
            <div className="space-y-1.5">
              <span className="text-sm font-bold leading-none text-foreground">{t("timeLimitLabel")}</span>
              <div className="flex items-center gap-1.5">
                <div className="space-y-1">
                  <Label htmlFor="quiz-time-hours-modal" className="sr-only">
                    {t("hoursShort")}
                  </Label>
                  <Input
                    id="quiz-time-hours-modal"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={HOURS_MAX}
                    placeholder="0"
                    value={hours}
                    disabled={creating}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={blockNonNumeric}
                    aria-describedby="quiz-create-time-helper-modal"
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
                    className="w-20 text-center placeholder:text-center [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </div>
                <span aria-hidden className="text-sm font-extrabold text-muted-foreground">{t("hoursShort")}</span>
                <div className="space-y-1">
                  <Label htmlFor="quiz-time-minutes-modal" className="sr-only">
                    {t("minutesShort")}
                  </Label>
                  <Input
                    id="quiz-time-minutes-modal"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={MINUTES_MAX}
                    placeholder="0"
                    value={minutes}
                    disabled={creating || Number(hours) === HOURS_MAX}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={blockNonNumeric}
                    aria-describedby="quiz-create-time-helper-modal"
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
                    className="w-20 text-center placeholder:text-center [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </div>
                <span aria-hidden className="text-sm font-extrabold text-muted-foreground">{t("minutesShort")}</span>
              </div>
            </div>
          )}

          {mode === "assessment" && (
            <div className="space-y-2">
              <label className="flex cursor-pointer items-center gap-2.5 text-sm font-semibold text-foreground">
                <Switch
                  checked={allowRetake}
                  onCheckedChange={(checked) => setAllowRetake(checked)}
                  disabled={creating}
                />
                {t("retakeAllow")}
              </label>
              {allowRetake && (
                <div className="flex items-center gap-2">
                  <Label htmlFor="quiz-max-attempts-modal" className="text-xs font-extrabold text-muted-foreground">
                    {t("retakeMaxAttempts")}
                  </Label>
                  <select
                    id="quiz-max-attempts-modal"
                    value={maxAttempts}
                    onChange={(e) => setMaxAttempts(Math.trunc(Number(e.target.value)) || 1)}
                    disabled={creating}
                    className="h-11 rounded-xl border-[3px] border-border bg-card px-2 py-1 text-sm font-bold"
                  >
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                </div>
              )}
            </div>
          )}

          <div className="space-y-1">
            <label className="flex cursor-pointer items-center gap-2.5 text-sm font-semibold text-foreground">
              <Switch
                checked={shuffleQuestions}
                onCheckedChange={(checked) => setShuffleQuestions(checked)}
                disabled={creating}
              />
              {t("shuffleQuestions")}
            </label>
            <p className="text-xs font-semibold text-muted-foreground">{t("shuffleQuestionsHelper")}</p>
          </div>

          <p
            id="quiz-create-time-helper-modal"
            className="text-xs font-semibold text-muted-foreground"
          >
            {opensAt || closesAt
              ? t("windowHelperSet")
              : mode === "practice"
                ? (locale === "ms" ? "Kuiz latihan tidak dihadkan masa." : "Practice quizzes are untimed.")
                : (hours || minutes)
                  ? t("timeLimitHelperSet", { hours: hours || "0", minutes: minutes || "0" })
                  : t("timeLimitHelperNone")}
          </p>
        </form>
      );
    }
    return (
      <form
        onSubmit={handleCreate}
        className={cn(
          "space-y-3",
          !isModal && "mb-6 rounded-2xl border-[3px] border-border bg-muted/40 p-4"
        )}
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
          <div className="space-y-1">
            <Label htmlFor={isModal ? "quiz-title-modal" : "quiz-title"} className="sr-only">
              {t("createQuizTitle")}
            </Label>
            <Input
              id={isModal ? "quiz-title-modal" : "quiz-title"}
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
            <Label htmlFor={isModal ? "quiz-mode-modal" : "quiz-mode"} className="sr-only">
              {t("modeLabel")}
            </Label>
            <Select
              value={mode}
              onValueChange={(v) => setMode(v as "practice" | "assessment")}
              disabled={creating}
            >
              <SelectTrigger
                id={isModal ? "quiz-mode-modal" : "quiz-mode"}
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
              <Label htmlFor={isModal ? "quiz-time-hours-modal" : "quiz-time-hours"} className="sr-only">
                {t("hoursShort")}
              </Label>
              <Input
                id={isModal ? "quiz-time-hours-modal" : "quiz-time-hours"}
                type="number"
                min={0}
                max={HOURS_MAX}
                placeholder="0"
                value={hours}
                disabled={creating || mode === "practice"}
                onFocus={(e) => e.target.select()}
                onKeyDown={blockNonNumeric}
                aria-describedby={isModal ? "quiz-create-time-helper-modal" : "quiz-create-time-helper"}
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
              <Label htmlFor={isModal ? "quiz-time-minutes-modal" : "quiz-time-minutes"} className="sr-only">
                {t("minutesShort")}
              </Label>
              <Input
                id={isModal ? "quiz-time-minutes-modal" : "quiz-time-minutes"}
                type="number"
                min={0}
                max={MINUTES_MAX}
                placeholder="0"
                value={minutes}
                disabled={creating || mode === "practice" || Number(hours) === HOURS_MAX}
                onFocus={(e) => e.target.select()}
                onKeyDown={blockNonNumeric}
                aria-describedby={isModal ? "quiz-create-time-helper-modal" : "quiz-create-time-helper"}
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
              id={isModal ? "quiz-opens-at-modal" : "quiz-opens-at"}
              ariaLabel={t("windowOpensLabel")}
              value={opensAt}
              onChange={setOpensAt}
              disabled={creating}
              placeholder={t("windowPlaceholder")}
              buttonClassName="w-full sm:w-52"
            />
            <span aria-hidden className="text-xs font-extrabold text-muted-foreground">–</span>
            <DateTimePicker
              id={isModal ? "quiz-closes-at-modal" : "quiz-closes-at"}
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
                <Label htmlFor={isModal ? "quiz-max-attempts-modal" : "quiz-max-attempts"} className="text-xs font-extrabold text-foreground">
                  {t("retakeMaxAttempts")}
                </Label>
                <select
                  id={isModal ? "quiz-max-attempts-modal" : "quiz-max-attempts"}
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
          <p id={isModal ? "quiz-create-time-helper-modal" : "quiz-create-time-helper"} className="text-xs font-semibold text-muted-foreground">
            {opensAt || closesAt
              ? t("windowHelperSet")
              : mode === "practice"
                ? (locale === "ms" ? "Kuiz latihan tidak dihadkan masa." : "Practice quizzes are untimed.")
                : (hours || minutes)
                  ? t("timeLimitHelperSet", { hours: hours || "0", minutes: minutes || "0" })
                  : t("timeLimitHelperNone")}
          </p>

          <Button type="submit" disabled={creating || !title.trim()} className={isModal ? "w-full sm:w-auto font-extrabold" : ""}>
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
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 dark:from-orange-950/40 dark:via-card dark:to-blue-950/40 p-4 sm:p-7 md:p-8 shadow-[var(--shadow-clay)]">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50 dark:bg-white/5" />
        <div aria-hidden className="pointer-events-none absolute -bottom-12 left-1/3 h-28 w-28 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-100/60 dark:bg-blue-500/5" />
        <div className="relative">
          <div className="flex items-center justify-between gap-3 min-h-8">
            <Link
              href={cls.archived_at ? "/lecturer/classes/archived" : "/lecturer/classes"}
              className="hit-slop inline-flex items-center gap-1.5 h-8 max-sm:h-8 px-3 rounded-xl border-[2.5px] border-border bg-card/90 text-xs font-extrabold text-muted-foreground hover:text-foreground hover:border-primary/40 shadow-[0_2px_0_var(--border)] transition-all hover:-translate-y-0.5 active:translate-y-0.5"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              <span>{t("backToClasses")}</span>
            </Link>
            {cls.archived_at ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  setRestoreError(null);
                  setRestoreDialogOpen(true);
                }}
                className="hit-slop h-8 max-sm:h-8 px-3 rounded-xl border-[2.5px] border-primary/40 bg-card/90 text-xs font-extrabold text-primary hover:bg-primary hover:text-primary-foreground hover:border-primary shadow-[0_2px_0_var(--border)] transition-all hover:-translate-y-0.5 active:translate-y-0.5"
              >
                <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />
                {t("restoreClass")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  setArchiveError(null);
                  setArchiveDialogOpen(true);
                }}
                className="hit-slop h-8 max-sm:h-8 px-3 rounded-xl border-[2.5px] border-amber-600/40 bg-card/90 text-xs font-extrabold text-amber-800 hover:bg-amber-100 hover:text-amber-950 hover:border-amber-600/60 dark:border-amber-500/60 dark:bg-amber-500/25 dark:text-amber-200 dark:hover:bg-amber-500/40 dark:hover:text-amber-100 shadow-[0_2px_0_var(--border)] transition-all hover:-translate-y-0.5 active:translate-y-0.5"
              >
                <Archive className="mr-1 h-3.5 w-3.5" aria-hidden />
                {t("archiveClass")}
              </Button>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-end justify-between gap-6">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
                <h1 className="font-heading text-xl sm:text-3xl font-semibold [text-wrap:balance]">{cls.title}</h1>
                {cls.archived_at && (
                  <span className="rounded-full border-[3px] border-amber-600/40 bg-amber-100 px-3 py-0.5 text-xs font-extrabold text-amber-800 uppercase tracking-wider dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300">
                    {t("isArchivedBadge")}
                  </span>
                )}
              </div>
              <p className="mt-1 sm:mt-1.5 text-xs sm:text-sm font-semibold text-muted-foreground">
                {t("rosterCount", { count: roster.length })} · {t("quizCount", { count: quizzes.length })}
              </p>

              {/* Mobile compact join code pill */}
              <div className="mt-2.5 flex items-center gap-2 sm:hidden">
                <button
                  type="button"
                  onClick={copyJoinCode}
                  className="inline-flex items-center gap-1.5 rounded-full border-[2.5px] border-border bg-card px-3 py-1 text-xs font-bold text-primary shadow-[var(--shadow-clay-sm)] active:scale-95 transition-transform"
                  aria-label={`${t("copyJoinCode")}: ${cls.join_code}`}
                >
                  <span className="text-muted-foreground font-semibold">{t("joinCode")}:</span>
                  <span className="font-mono font-black tracking-wider">{cls.join_code}</span>
                  <Copy className="size-3 text-muted-foreground" aria-hidden />
                </button>
                {copyError && (
                  <p className="text-xs font-bold text-destructive" role="alert">
                    {copyError}
                  </p>
                )}
              </div>
            </div>

            {/* Desktop Join code card */}
            <div className="hidden sm:block rounded-2xl border-[3px] border-border bg-card px-5 py-4 text-center shadow-[var(--shadow-clay-sm)]">
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

      <Card className={cn(activeTab !== "quizzes" && "max-sm:hidden", "gap-0 py-0 [--card-spacing:0px]")}>
        <CardHeader className="px-2.5 sm:px-6 pt-1 sm:pt-4 pb-0 sm:pb-4 border-b border-border/40">
          <div className="flex items-center justify-between gap-1.5 sm:gap-3 min-h-9 sm:min-h-8">
            {/* Mobile: Integrated Tabs Switcher */}
            <div role="tablist" aria-label="Class sections" className="sm:hidden flex items-center gap-0.5 -mb-[1px]">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "quizzes"}
                onClick={() => setActiveTab("quizzes")}
                className={cn(
                  "hit-slop flex items-center gap-1 px-2 sm:px-3 py-2 border-b-[3px] font-extrabold text-xs transition-all",
                  activeTab === "quizzes"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <span>{t("quizzesTitle")}</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-black leading-none",
                    activeTab === "quizzes"
                      ? "bg-primary/20 text-primary"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {quizzes.length}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "roster"}
                onClick={() => setActiveTab("roster")}
                className={cn(
                  "hit-slop flex items-center gap-1 px-2 sm:px-3 py-2 border-b-[3px] font-extrabold text-xs transition-all",
                  activeTab === "roster"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <span>{t("studentsTab")}</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-black leading-none",
                    activeTab === "roster"
                      ? "bg-primary/20 text-primary"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {roster.length}
                </span>
              </button>
            </div>

            {/* Desktop: Standard Section Heading */}
            <div className="hidden sm:flex items-center gap-2">
              <CardTitle className="font-heading font-semibold text-lg sm:text-xl leading-none text-foreground">
                {t("classQuizzes")}
              </CardTitle>
              <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-extrabold text-primary leading-none">
                {quizzes.length}
              </span>
            </div>

            {/* Right Action Buttons */}
            <div className="flex shrink-0 items-center gap-1 pb-1 sm:pb-0">
              {!cls.archived_at && (
                <Button
                  type="button"
                  size="xs"
                  onClick={() => setCreateQuizModalOpen(true)}
                  className="hit-slop sm:hidden size-7 max-sm:size-7 p-0 rounded-[10px] border border-transparent bg-primary text-[#fff7ed] shadow-[0_2px_0_var(--primary-deep)] hover:-translate-y-0.5 active:translate-y-0.5 flex items-center justify-center transition-all"
                  aria-label={t("createQuizBtn")}
                >
                  <Plus className="size-3.5 stroke-[3] text-[#fff7ed]" aria-hidden />
                </Button>
              )}
              <Link
                href={`/lecturer/classes/${cls.id}/gradebook`}
                className="hit-slop inline-flex items-center gap-1 h-7 max-sm:h-7 px-2 sm:px-3 rounded-lg border border-transparent bg-transparent text-xs font-bold text-muted-foreground hover:text-foreground hover:bg-muted/50 active:bg-muted/80 transition-colors"
              >
                <BarChart3 className="size-3.5 text-muted-foreground" aria-hidden />
                <span>{t("gradebookLink")}</span>
              </Link>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-4 sm:px-6 pt-0 sm:pt-4 pb-2 sm:pb-4">
          {/* Desktop inline create quiz form */}
          {!cls.archived_at && (
            <div className="hidden sm:block mb-4">
              {renderQuizForm(false)}
            </div>
          )}

          {quizzes.length === 0 ? (
            <p className="rounded-2xl border-[3px] border-dashed border-border bg-card p-6 text-center text-sm font-semibold text-muted-foreground">
              {t("noQuizzes")}
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {quizzes.map((q) => (
                <li key={q.id} className="py-2 sm:py-3 first:pt-1.5 transition-colors hover:bg-muted/20 rounded-xl px-1 sm:px-2">
                  <div className="flex items-center justify-between gap-3">
                    {/* Left: Content (Title on line 1, Metadata on line 2) */}
                    <div className="min-w-0 flex-1 space-y-1">
                      <Link
                        href={`/lecturer/quizzes/${q.id}/builder`}
                        className="block truncate rounded-lg transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="truncate font-heading text-sm sm:text-base font-bold text-foreground hover:text-primary transition-colors">
                          {q.title}
                        </span>
                      </Link>
                      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                        <span
                          className={cn(
                            "rounded-full border-[2px] px-2 py-0.5 text-[10px] sm:text-xs font-extrabold",
                            MODE_CLASS[q.mode]
                          )}
                        >
                          {getModeLabel(q.mode, locale)}
                        </span>
                        <span
                          className={cn(
                            "rounded-full border-[2px] px-2 py-0.5 text-[10px] sm:text-xs font-extrabold",
                            STATUS_CLASS[q.status]
                          )}
                        >
                          {getStatusLabel(q.status, locale)}
                        </span>
                        {q.mode === "assessment" && q.time_limit_sec != null && (
                          <span className="text-[11px] sm:text-xs font-bold tabular-nums text-muted-foreground">
                            {formatDuration(q.time_limit_sec, locale)}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Right: Actions */}
                    {/* Desktop: Direct 1-click action buttons */}
                    <div className="hidden sm:flex shrink-0 items-center gap-2">
                      {q.status !== "draft" && (
                        <Link
                          href={`/lecturer/quizzes/${q.id}/results`}
                          className="inline-flex items-center justify-center rounded-full border-[2px] border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-extrabold text-primary hover:bg-primary hover:text-primary-foreground hover:border-primary transition-all shadow-[var(--shadow-clay-sm)]"
                          aria-label={`${t("resultsBtn")} - ${q.title}`}
                        >
                          {t("resultsBtn")}
                        </Link>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 w-8 p-0 rounded-full border-[2px] sm:border-[2.5px] shadow-[var(--shadow-clay-sm)]"
                        onClick={() => setDuplicateQuiz(q)}
                        aria-haspopup="dialog"
                        aria-label={`${t("duplicateBtn")} - ${q.title}`}
                      >
                        <CopyPlus className="size-3.5 sm:size-4" aria-hidden="true" />
                      </Button>
                    </div>

                    {/* Mobile: 3-dots action menu (<sm) */}
                    <div className="sm:hidden flex shrink-0 items-center">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="hit-slop h-8 w-8 p-0 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 active:bg-muted/80 transition-colors"
                              aria-label={`Actions - ${q.title}`}
                            >
                              <MoreVertical className="size-4" aria-hidden="true" />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end" className="w-40 p-1.5 shadow-[var(--shadow-clay)]">
                          {q.status !== "draft" && (
                            <DropdownMenuItem
                              onClick={() => router.push(`/lecturer/quizzes/${q.id}/results`)}
                              className="flex items-center gap-2 cursor-pointer font-bold text-xs text-primary focus:bg-primary/10"
                            >
                              <BarChart3 className="size-4 text-primary" />
                              <span>{t("resultsBtn")}</span>
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() => setDuplicateQuiz(q)}
                            className="flex items-center gap-2 cursor-pointer font-bold text-xs"
                          >
                            <CopyPlus className="size-4 text-muted-foreground" />
                            <span>{t("duplicateBtn")}</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className={cn(activeTab !== "roster" && "max-sm:hidden", "gap-0 py-0 [--card-spacing:0px]")}>
        <CardHeader className="px-2.5 sm:px-6 pt-1 sm:pt-4 pb-0 sm:pb-4 border-b border-border/40">
          <div className="flex items-center justify-between gap-1.5 sm:gap-3 min-h-9 sm:min-h-8">
            {/* Mobile: Integrated Tabs Switcher */}
            <div role="tablist" aria-label="Class sections" className="sm:hidden flex items-center gap-0.5 -mb-[1px]">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "quizzes"}
                onClick={() => setActiveTab("quizzes")}
                className={cn(
                  "hit-slop flex items-center gap-1 px-2 sm:px-3 py-2 border-b-[3px] font-extrabold text-xs transition-all",
                  activeTab === "quizzes"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <span>{t("quizzesTitle")}</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-black leading-none",
                    activeTab === "quizzes"
                      ? "bg-primary/20 text-primary"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {quizzes.length}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "roster"}
                onClick={() => setActiveTab("roster")}
                className={cn(
                  "hit-slop flex items-center gap-1 px-2 sm:px-3 py-2 border-b-[3px] font-extrabold text-xs transition-all",
                  activeTab === "roster"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <span>{t("studentsTab")}</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-black leading-none",
                    activeTab === "roster"
                      ? "bg-primary/20 text-primary"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {roster.length}
                </span>
              </button>
            </div>

            {/* Desktop: Standard Section Heading */}
            <div className="hidden sm:flex items-center gap-2">
              <CardTitle className="font-heading font-semibold text-lg sm:text-xl leading-none text-foreground">
                {t("rosterTitle")}
              </CardTitle>
              <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-extrabold text-primary leading-none">
                {roster.length}
              </span>
            </div>

            {/* Right Action Buttons (Mobile only Gradebook button to maintain symmetry with Quizzes tab) */}
            <div className="sm:hidden flex shrink-0 items-center pb-1">
              <Link
                href={`/lecturer/classes/${cls.id}/gradebook`}
                className="hit-slop inline-flex items-center gap-1 h-7 max-sm:h-7 px-2 sm:px-3 rounded-lg border border-transparent bg-transparent text-xs font-bold text-muted-foreground hover:text-foreground hover:bg-muted/50 active:bg-muted/80 transition-colors"
              >
                <BarChart3 className="size-3.5 text-muted-foreground" aria-hidden />
                <span>{t("gradebookLink")}</span>
              </Link>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-4 sm:px-6 pt-0 sm:pt-4 pb-2 sm:pb-4">
          {roster.length === 0 ? (
            <div className="grid place-items-center rounded-2xl border-[3px] border-dashed border-border bg-card/60 px-6 py-10 text-center">
              <p className="font-heading text-base font-semibold">{t("noStudents")}</p>
              <p className="mt-1 text-sm font-semibold text-muted-foreground">
                {t("joinCode")}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {roster.map((s) => (
                <li key={s.student_id} className="flex items-center justify-between gap-3 py-2 sm:py-3 first:pt-1.5 px-1 sm:px-2 rounded-xl transition-colors hover:bg-muted/20">
                  <span className="flex min-w-0 items-center gap-2.5 sm:gap-3">
                    <span className="grid h-8 w-8 sm:h-9 sm:w-9 shrink-0 place-items-center rounded-xl bg-orange-100 font-heading text-xs sm:text-sm font-bold text-primary">
                      {(s.full_name ?? "U").trim().charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span translate="no" className="block truncate font-heading text-sm sm:text-base font-semibold">{s.full_name ?? t("unnamedStudent")}</span>
                      {s.matric_no && (
                        <span className="font-mono text-[11px] sm:text-xs font-bold text-muted-foreground">{s.matric_no}</span>
                      )}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] sm:text-xs font-bold text-muted-foreground">
                    {t("joinedOn", { date: formatDate(s.enrolled_at) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>



      {/* ── Mobile Quiz Creator Drawer/Modal ── */}
      {!cls.archived_at && (
        <ResponsiveModal
          open={createQuizModalOpen}
          onOpenChange={(open) => {
            if (!open && creating) return;
            setCreateQuizModalOpen(open);
          }}
        >
          <ResponsiveModalContent
            className="max-w-lg"
            footer={
              /* Pinned drawer footer (mobile): Create stays reachable while
                 the body scrolls; submits via form="quiz-create-form". */
              <div className="flex items-center justify-end gap-2 pb-[max(0.25rem,var(--safe-bottom))]">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={creating}
                  onClick={() => setCreateQuizModalOpen(false)}
                  className="font-extrabold"
                >
                  {tCommon("cancel")}
                </Button>
                <Button
                  type="submit"
                  form="quiz-create-form"
                  disabled={creating || !title.trim()}
                  className="flex-1 font-extrabold sm:flex-none"
                >
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
            }
          >
            <ResponsiveModalHeader>
              <ResponsiveModalTitle className="font-heading text-xl font-bold">{t("createQuizTitle")}</ResponsiveModalTitle>
              <ResponsiveModalDescription>
                {t("createQuizCardSubtitle")}
              </ResponsiveModalDescription>
            </ResponsiveModalHeader>
            <div className="pt-2">
              {createQuizModalOpen && renderQuizForm(true)}
            </div>
            {/* Desktop dialog footer (≥640px): the pinned `footer` prop above
                is drawer-only, so dialog mode submits from here instead.
                Hidden on mobile where the pinned drawer footer takes over. */}
            <ResponsiveModalFooter className="max-sm:hidden mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="ghost"
                disabled={creating}
                onClick={() => setCreateQuizModalOpen(false)}
                className="font-extrabold"
              >
                {tCommon("cancel")}
              </Button>
              <Button
                type="submit"
                form="quiz-create-form"
                disabled={creating || !title.trim()}
                className="font-extrabold"
              >
                {creating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                    {t("creatingQuizBtn")}
                  </>
                ) : (
                  t("createQuizBtn")
                )}
              </Button>
            </ResponsiveModalFooter>
          </ResponsiveModalContent>
        </ResponsiveModal>
      )}

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
