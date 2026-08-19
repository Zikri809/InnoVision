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
              disabled={saving}
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
              disabled={saving}
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
          <fieldset className="space-y-2.5" disabled={isPractice || saving}>
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
