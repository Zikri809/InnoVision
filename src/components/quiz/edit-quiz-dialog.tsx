"use client";

import { useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
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
import { MODE_LABEL } from "@/lib/quizzes/labels";
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
    const val = e.target.value;
    setTimeTouched(true);
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
    const val = e.target.value;
    setTimeTouched(true);
    if (val === "") {
      setMinutes("");
      return;
    }
    const num = Number(val);
    if (Number.isNaN(num)) return;
    const clamped = Math.max(0, Math.min(MINUTES_MAX, Math.trunc(num)));
    setMinutes(String(clamped));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (saving || submitLock.current) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Quiz title is required.");
      return;
    }
    if (trimmedTitle.length > TITLE_MAX) {
      setError(`Quiz title must be at most ${TITLE_MAX} characters.`);
      return;
    }

    const patch: QuizMetadataPatch = {};
    if (trimmedTitle !== quiz.title) {
      patch.title = trimmedTitle;
    }
    if (mode !== quiz.mode) {
      patch.mode = mode;
    }

    if (mode === "assessment") {
      const isBlank = hours.trim() === "" && minutes.trim() === "";
      const effectiveSec = isBlank
        ? null
        : hmToSeconds(Number(hours) || 0, Number(minutes) || 0);

      if (mode !== quiz.mode || (timeTouched && effectiveSec !== quiz.time_limit_sec)) {
        patch.timeLimitSec = effectiveSec;
      }
    }

    if (Object.keys(patch).length === 0) {
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
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 409) {
          onClose();
          onError?.(409, body.message ?? "Quiz is no longer in draft status.");
          return;
        }
        if (res.status === 404) {
          onClose();
          onError?.(404, body.message ?? "Quiz not found.");
          return;
        }
        setError(body.message ?? body.error ?? "Could not update quiz settings.");
        return;
      }

      onClose();
      onSuccess?.();
    } catch {
      setError("Network error updating quiz settings.");
    } finally {
      submitLock.current = false;
      setSaving(false);
    }
  }

  const isHoursMax = Number(hours) === HOURS_MAX && hours !== "";
  const isPractice = mode === "practice";

  return (
    <>
      <DialogHeader className="shrink-0 pb-3 pr-8 border-b-[3px] border-border">
        <DialogTitle className="text-xl font-semibold font-heading">
          Quiz settings
        </DialogTitle>
        <DialogDescription className="text-xs font-semibold text-muted-foreground mt-0.5">
          Edit title, mode, and time limit. Draft quizzes only.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSave} className="flex flex-col flex-1 min-h-0 pt-4">
        <div className="flex-1 overflow-y-auto space-y-5 pr-1 py-1">
          {/* Title Field */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-quiz-title" className="text-xs font-extrabold text-foreground">
                Quiz Title
              </Label>
              <span
                aria-hidden="true"
                className="text-[11px] font-bold text-muted-foreground tabular-nums"
              >
                {title.length}/{TITLE_MAX}
              </span>
            </div>
            <Input
              id="edit-quiz-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={TITLE_MAX}
              disabled={saving}
              placeholder="e.g. Chapter 1 Quiz"
              aria-required="true"
              aria-invalid={Boolean(error)}
              aria-errormessage={error ? "edit-quiz-dialog-error" : undefined}
            />
          </div>

          {/* Mode Selector */}
          <div className="space-y-1.5">
            <Label htmlFor="edit-quiz-mode" className="text-xs font-extrabold text-foreground">
              Quiz Mode
            </Label>
            <Select
              value={mode}
              onValueChange={(v) => handleModeChange(v as QuizMode)}
              disabled={saving}
            >
              <SelectTrigger id="edit-quiz-mode" className="w-full">
                <SelectValue placeholder="Select mode">
                  {(v) => MODE_LABEL[v as QuizMode] ?? v}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="practice">Practice</SelectItem>
                <SelectItem value="assessment">Assessment</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Time Limit Section */}
          <fieldset className="space-y-2.5" disabled={isPractice || saving}>
            <legend className="w-full">
              <div className="flex items-center justify-between">
                <span className="text-xs font-extrabold text-foreground">
                  Time Limit {!isPractice && <span className="text-muted-foreground font-normal">(Optional)</span>}
                </span>
                {isPractice && (
                  <span className="text-xs font-extrabold text-emerald-800 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-950/60 border-[3px] border-emerald-300 dark:border-emerald-700/50 rounded-full px-3 py-0.5">
                    Untimed in practice mode
                  </span>
                )}
              </div>
            </legend>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="edit-quiz-hours" className="sr-only">
                  Hours
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
                  aria-describedby="time-limit-helper"
                  className="w-20 text-center font-bold [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span aria-hidden="true" className="text-xs font-extrabold text-muted-foreground">
                  hours
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <Label htmlFor="edit-quiz-minutes" className="sr-only">
                  Minutes
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
                  aria-describedby="time-limit-helper"
                  className="w-20 text-center font-bold [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span aria-hidden="true" className="text-xs font-extrabold text-muted-foreground">
                  min
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <p id="time-limit-helper" className="text-xs font-semibold text-muted-foreground">
                {isPractice
                  ? "Practice quizzes are untimed."
                  : isHoursMax
                    ? "Maximum time limit reached (2 hours). Minutes are set to 0."
                    : "Leave blank for an untimed quiz (maximum 2 hours)."}
              </p>
              {isSubMinuteInitial && !timeTouched && (
                <div
                  role="status"
                  className="flex items-start gap-2 rounded-2xl border-[3px] border-amber-400/50 bg-amber-100/70 p-3 text-xs font-bold text-amber-950 dark:border-amber-600/40 dark:bg-amber-950/40 dark:text-amber-200 shadow-xs"
                >
                  <AlertCircle className="size-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" aria-hidden="true" />
                  <div>
                    <p className="font-extrabold">Sub-minute time limit ({quiz.time_limit_sec}s)</p>
                    <p className="font-semibold text-amber-900/90 dark:text-amber-300/90">
                      The dialog edits in whole minutes. Modifying time settings will round the limit.
                    </p>
                  </div>
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

        <DialogFooter className="shrink-0 pt-4 border-t-[3px] border-border mt-3 flex items-center justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={saving || !title.trim()}
          >
            {saving ? "Saving…" : "Save settings"}
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
      <DialogContent className="max-h-[88vh] flex flex-col sm:max-w-xl p-6 sm:p-7 overflow-hidden gap-0">
        {open && quiz && (
          <EditQuizForm
            key={`${quiz.id}-${open}`}
            quiz={quiz}
            onClose={() => onOpenChange(false)}
            onSuccess={onSuccess}
            onError={onError}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
