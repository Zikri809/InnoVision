"use client";

import { useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TITLE_MAX } from "@/lib/quizzes/validation";
import { HOURS_MAX, MINUTES_MAX, hmToSeconds, secondsToHm } from "@/lib/quizzes/time-limit";
import {
  windowIsoToLocalInput,
  windowLocalInputToIso,
} from "@/lib/format/window";
import { getModeLabel } from "@/lib/quizzes/labels";
import type { QuizInfo } from "@/app/(lecturer)/lecturer/quizzes/[id]/builder/quiz-builder-client";
import type { QuizMode } from "@/lib/types/aliases";
import type { QuizMetadataPatch } from "@/lib/quizzes/updates";

export interface EditQuizDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quiz: QuizInfo;
  onSuccess?: () => void;
  onError?: (status: number, message: string) => void;
}

function EditQuizForm({
  quiz,
  onClose,
  onSuccess,
  onError,
}: {
  quiz: QuizInfo;
  onClose: () => void;
  onSuccess?: () => void;
  onError?: (status: number, message: string) => void;
}) {
  const locale = useLocale();
  const t = useTranslations("lecturer.dialogs");
  const tDetail = useTranslations("lecturer.classDetail");
  const tCommon = useTranslations("common");

  const [title, setTitle] = useState(quiz.title);
  const [mode, setMode] = useState<QuizMode>(quiz.mode);

  const initialHm = secondsToHm(quiz.time_limit_sec);
  const [hours, setHours] = useState<string>(() =>
    quiz.time_limit_sec != null ? String(initialHm.hours) : ""
  );
  const [minutes, setMinutes] = useState<string>(() => {
    if (quiz.time_limit_sec == null) return "";
    if (initialHm.hours >= HOURS_MAX) return "";
    if (quiz.time_limit_sec > 0 && quiz.time_limit_sec < 60) return "1";
    return String(initialHm.minutes);
  });

  const [timeTouched, setTimeTouched] = useState(false);
  const lastAssessmentHm = useRef<{ hours: string; minutes: string } | null>(null);

  // Availability-window inputs (QC-3). datetime-local strings at the edit
  // surface; converted once at the client boundary by lib/format/window.
  const [opensAt, setOpensAt] = useState<string>(() => windowIsoToLocalInput(quiz.opens_at));
  const [closesAt, setClosesAt] = useState<string>(() => windowIsoToLocalInput(quiz.closes_at));

  // Retake config (QC-4). Assessment-only concept; live-editable like
  // windows (outside the DB edit-freeze).
  const [allowRetake, setAllowRetake] = useState<boolean>(quiz.allow_retake ?? false);
  const [maxAttempts, setMaxAttempts] = useState<string>(
    () => String(quiz.max_attempts ?? 1),
  );

  // Per-student shuffling (QT-3). FROZEN metadata like title/mode/time limit
  // — draft-only, hence the metadataLocked disable below.
  const [shuffleQuestions, setShuffleQuestions] = useState<boolean>(quiz.shuffle_questions ?? false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(false);

  const isSubMinuteInitial =
    quiz.time_limit_sec != null &&
    quiz.time_limit_sec > 0 &&
    quiz.time_limit_sec < 60;

  function blockNonNumeric(e: React.KeyboardEvent<HTMLInputElement>) {
    if (["e", "E", "+", "-", "."].includes(e.key)) {
      e.preventDefault();
    }
  }

  function handleModeChange(newMode: QuizMode) {
    if (newMode === mode) return;
    if (newMode === "practice") {
      lastAssessmentHm.current = { hours, minutes };
      setMode("practice");
    } else {
      if (lastAssessmentHm.current !== null) {
        setHours(lastAssessmentHm.current.hours);
        setMinutes(lastAssessmentHm.current.minutes);
      } else if (quiz.time_limit_sec != null) {
        const hm = secondsToHm(quiz.time_limit_sec);
        setHours(String(hm.hours));
        setMinutes(hm.hours >= HOURS_MAX ? "" : String(hm.minutes));
      } else {
        setHours("");
        setMinutes("");
      }
      setMode("assessment");
    }
  }

  function handleHoursChange(e: React.ChangeEvent<HTMLInputElement>) {
    setTimeTouched(true);
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
  }

  function handleMinutesChange(e: React.ChangeEvent<HTMLInputElement>) {
    setTimeTouched(true);
    const val = e.target.value;
    if (val === "") {
      setMinutes("");
      return;
    }
    const num = Number(val);
    if (Number.isNaN(num)) return;
    const clamped = Math.max(0, Math.min(MINUTES_MAX, Math.trunc(num)));
    setMinutes(String(clamped));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitLock.current || saving) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Title is required.");
      return;
    }

    const payload: QuizMetadataPatch = {};
    if (trimmedTitle !== quiz.title) payload.title = trimmedTitle;
    if (mode !== quiz.mode) payload.mode = mode;

    const newTimeLimitSec: number | null =
      mode === "practice"
        ? null
        : hours === "" && minutes === ""
          ? null
          : hmToSeconds(Number(hours) || 0, Number(minutes) || 0);

    if (newTimeLimitSec !== quiz.time_limit_sec) {
      payload.timeLimitSec = newTimeLimitSec;
    }

    // Window diff: only include when changed. Compare INSTANTS (Date.parse)
    // — PostgREST returns "+00:00"-suffixed instants while the parser emits
    // ".000Z", and raw string comparison would flag identical instants as
    // dirty, re-sending windows on every save.
    const newOpens = windowLocalInputToIso(opensAt);
    const newCloses = windowLocalInputToIso(closesAt);
    const opensDirty =
      (newOpens === null) !== (quiz.opens_at == null) ||
      (newOpens !== null && quiz.opens_at != null &&
        Date.parse(newOpens) !== Date.parse(quiz.opens_at));
    const closesDirty =
      (newCloses === null) !== (quiz.closes_at == null) ||
      (newCloses !== null && quiz.closes_at != null &&
        Date.parse(newCloses) !== Date.parse(quiz.closes_at));
    if (opensDirty) payload.opensAt = newOpens;
    if (closesDirty) payload.closesAt = newCloses;
    if (newOpens !== null && newCloses !== null && !(new Date(newCloses) > new Date(newOpens))) {
      setError(t("windowOrderError"));
      return;
    }

    // Retake diff (QC-4): assessment-only; only sent when changed.
    const newMaxAttempts = Math.trunc(Number(maxAttempts)) || 1;
    if (mode === "assessment") {
      if (allowRetake !== (quiz.allow_retake ?? false)) payload.allowRetake = allowRetake;
      if (newMaxAttempts !== (quiz.max_attempts ?? 1)) payload.maxAttempts = newMaxAttempts;
    }

    // Shuffle diff (QT-3): draft-only (frozen metadata); only sent when changed.
    if (shuffleQuestions !== (quiz.shuffle_questions ?? false)) {
      payload.shuffleQuestions = shuffleQuestions;
    }

    if (Object.keys(payload).length === 0) {
      onClose();
      return;
    }

    submitLock.current = true;
    setSaving(true);
    setError(null);

    try {
      const res = await fetch(`/api/quizzes/${quiz.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg = body.message ?? body.error ?? tCommon("errorGeneric");
        setError(msg);
        onError?.(res.status, msg);
        return;
      }

      onClose();
      onSuccess?.();
    } catch {
      const netMsg = tCommon("errorGeneric");
      setError(netMsg);
      onError?.(0, netMsg);
    } finally {
      submitLock.current = false;
      setSaving(false);
    }
  }

  const isPractice = mode === "practice";
  const isHoursMax = Number(hours) === HOURS_MAX;
  // Metadata (title/mode/time limit) is DRAFT-ONLY server-side (the DB
  // edit-freeze + route's notDraft()); availability windows are live-quiz
  // management (QC-3) and stay editable on ANY status.
  const metadataLocked = quiz.status !== "draft";

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-heading text-xl font-bold">
          {t("editQuizTitle")}
        </DialogTitle>
        <DialogDescription>
          {t("editQuizSubtitle")}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4 pt-2">
        <div className="space-y-3.5">
          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="edit-quiz-title" className="text-xs font-extrabold text-foreground">
              {t("titleLabel")}
            </Label>
            <Input
              id="edit-quiz-title"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (error) setError(null);
              }}
              required
              maxLength={TITLE_MAX}
              disabled={saving || metadataLocked}
              placeholder={tDetail("quizTitlePlaceholder")}
            />
          </div>

          {/* Mode Selector */}
          <div className="space-y-1.5">
            <Label htmlFor="edit-quiz-mode" className="text-xs font-extrabold text-foreground">
              {tDetail("modeLabel")}
            </Label>
            <Select
              value={mode}
              onValueChange={(v) => handleModeChange(v as QuizMode)}
              disabled={saving || metadataLocked}
            >
              <SelectTrigger id="edit-quiz-mode" className="w-full">
                <SelectValue placeholder={tDetail("modeLabel")}>
                  {(v) => getModeLabel(v as QuizMode, locale)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="practice">{tCommon("practice")}</SelectItem>
                <SelectItem value="assessment">{tCommon("assessment")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Time Limit Section */}
          <fieldset className="space-y-2.5" disabled={isPractice || saving || metadataLocked}>
            <legend className="w-full">
              <div className="flex items-center justify-between">
                <span className="text-xs font-extrabold text-foreground">
                  {tDetail("timeLimitLabel")}
                </span>
                {isPractice && (
                  <span className="text-xs font-extrabold text-emerald-800 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-950/60 border-[3px] border-emerald-300 dark:border-emerald-700/50 rounded-full px-3 py-0.5">
                    {tDetail("noTimeLimit")}
                  </span>
                )}
              </div>
            </legend>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="edit-quiz-hours" className="sr-only">
                  {tDetail("hoursShort")}
                </Label>
                <Input
                  id="edit-quiz-hours"
                  type="number"
                  min={0}
                  max={HOURS_MAX}
                  step={1}
                  placeholder="0"
                  value={hours}
                  onChange={handleHoursChange}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={blockNonNumeric}
                  disabled={saving || isPractice}
                  className="w-20 text-center font-bold [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span aria-hidden="true" className="text-xs font-extrabold text-muted-foreground">
                  {tDetail("hoursShort")}
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <Label htmlFor="edit-quiz-minutes" className="sr-only">
                  {tDetail("minutesShort")}
                </Label>
                <Input
                  id="edit-quiz-minutes"
                  type="number"
                  min={0}
                  max={MINUTES_MAX}
                  step={1}
                  placeholder="0"
                  value={minutes}
                  onChange={handleMinutesChange}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={blockNonNumeric}
                  disabled={saving || isPractice || isHoursMax}
                  className="w-20 text-center font-bold [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span aria-hidden="true" className="text-xs font-extrabold text-muted-foreground">
                  {tDetail("minutesShort")}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <p id="time-limit-helper" className="text-xs font-semibold text-muted-foreground">
                {isPractice
                  ? tDetail("noTimeLimit")
                  : isHoursMax
                    ? "Maximum 2h."
                    : `${tDetail("timeLimitLabel")} ${tDetail("noTimeLimit")}`}
              </p>
              {isSubMinuteInitial && !timeTouched && (
                <div
                  role="status"
                  className="flex items-start gap-2 rounded-2xl border-[3px] border-amber-400/50 bg-amber-100/70 p-3 text-xs font-bold text-amber-950 dark:border-amber-600/40 dark:bg-amber-950/40 dark:text-amber-200 shadow-xs"
                >
                  <AlertCircle className="size-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" aria-hidden="true" />
                </div>
              )}
            </div>
          </fieldset>

          {/* Availability window (QC-3): editable on ANY status — scheduling
              is live-quiz management; the route bypasses the draft lock for
              window-only payloads. */}
          <fieldset className="space-y-2.5" disabled={saving}>
            <legend className="w-full">
              <span className="text-xs font-extrabold text-foreground">
                {t("windowOpensLabel")} / {t("windowClosesLabel")}
              </span>
            </legend>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="edit-quiz-opens-at" className="sr-only">
                  {t("windowOpensLabel")}
                </Label>
                <Input
                  id="edit-quiz-opens-at"
                  type="datetime-local"
                  value={opensAt}
                  onChange={(e) => setOpensAt(e.target.value)}
                  disabled={saving}
                  className="w-56"
                />
              </div>
              <span aria-hidden="true" className="text-xs font-extrabold text-muted-foreground">
                –
              </span>
              <div className="flex items-center gap-1.5">
                <Label htmlFor="edit-quiz-closes-at" className="sr-only">
                  {t("windowClosesLabel")}
                </Label>
                <Input
                  id="edit-quiz-closes-at"
                  type="datetime-local"
                  value={closesAt}
                  onChange={(e) => setClosesAt(e.target.value)}
                  disabled={saving}
                  className="w-56"
                />
              </div>
            </div>

            <p className="text-xs font-semibold text-muted-foreground">
              {opensAt || closesAt ? t("windowHelper") : t("windowHelperNone")}
            </p>
          </fieldset>

          {/* Retake config (QC-4): assessment-only, editable on ANY status
              — retake config is live-quiz management; the route bypasses the
              draft lock for retake-only payloads. */}
          {mode === "assessment" && (
            <fieldset className="space-y-2.5" disabled={saving}>
              <legend className="w-full">
                <span className="text-xs font-extrabold text-foreground">
                  {t("retakeLabel")}
                </span>
              </legend>

              <label className="flex items-center gap-2.5 text-sm font-semibold text-foreground">
                <input
                  id="edit-quiz-allow-retake"
                  type="checkbox"
                  checked={allowRetake}
                  onChange={(e) => setAllowRetake(e.target.checked)}
                  disabled={saving}
                  className="size-4 accent-[var(--primary)]"
                />
                {t("retakeAllow")}
              </label>

              {allowRetake && (
                <div className="flex items-center gap-3">
                  <Label htmlFor="edit-quiz-max-attempts" className="text-xs font-extrabold text-foreground">
                    {t("retakeMaxAttempts")}
                  </Label>
                  <Input
                    id="edit-quiz-max-attempts"
                    type="number"
                    min={1}
                    max={3}
                    step={1}
                    value={maxAttempts}
                    onChange={(e) => {
                      const num = Number(e.target.value);
                      if (Number.isNaN(num)) return;
                      setMaxAttempts(String(Math.max(1, Math.min(3, Math.trunc(num)))));
                    }}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={blockNonNumeric}
                    disabled={saving}
                    className="w-16 text-center font-bold [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </div>
              )}

              <p className="text-xs font-semibold text-muted-foreground">
                {allowRetake
                  ? t("retakeHelperOn", { count: Math.max(1, Math.min(3, Math.trunc(Number(maxAttempts)) || 1)) })
                  : t("retakeHelperOff")}
              </p>
            </fieldset>
          )}

          {/* Shuffling (QT-3): FROZEN metadata like title/mode — draft-only,
              so the checkbox locks with metadataLocked (the route 409s and
              the DB trigger backstops it anyway). */}
          <fieldset className="space-y-2" disabled={saving}>
            <label className="flex items-center gap-2.5 text-sm font-semibold text-foreground">
              <input
                id="edit-quiz-shuffle"
                type="checkbox"
                checked={shuffleQuestions}
                onChange={(e) => setShuffleQuestions(e.target.checked)}
                disabled={saving || metadataLocked}
                className="size-4 accent-[var(--primary)]"
              />
              {t("shuffleQuestions")}
            </label>
            <p className="text-xs font-semibold text-muted-foreground">{t("shuffleQuestionsHelper")}</p>
          </fieldset>

          {error && (
            <p
              id="edit-quiz-dialog-error"
              className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={saving}
          >
            {tCommon("cancel")}
          </Button>
          <Button type="submit" disabled={saving || !title.trim()}>
            {saving ? tCommon("saving") : t("saveChanges")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

export function EditQuizDialog({
  open,
  onOpenChange,
  quiz,
  onSuccess,
  onError,
}: EditQuizDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <EditQuizForm
          quiz={quiz}
          onClose={() => onOpenChange(false)}
          onSuccess={onSuccess}
          onError={onError}
        />
      </DialogContent>
    </Dialog>
  );
}
