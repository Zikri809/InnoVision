"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { cn } from "@/lib/utils";
import {
  applyOptionDraftOp,
  type OptionDraftOp,
} from "@/lib/quizzes/question-draft";
import { QuestionImageField } from "@/components/media/question-image-field";
import type { QuestionRow } from "@/app/(lecturer)/lecturer/quizzes/[id]/builder/quiz-builder-client";

type QuestionDraft = {
  type: "mcq" | "true_false" | "multi_select";
  prompt: string;
  options: string[];
  /** Single-answer key (mcq / true_false). Absent on multi drafts. */
  correctIndex?: number;
  /** QT-1: sorted+distinct multi answer key. Absent on single-answer drafts. */
  correctIndices?: number[];
  explanation: string;
};

export interface EditQuestionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quizId: string;
  question: QuestionRow | null;
  questionIndex?: number;
  onSuccess?: () => void;
  /**
   * Live has-image state from the owner's flags overlay. question.image_path
   * is the row captured at edit-start and goes stale after in-dialog image
   * ops (attach → close → reopen would otherwise seed the field wrong).
   */
  hasImageOverride?: boolean;
  /**
   * Fires after each COMMITTED image op (attach/replace/remove) so the owning
   * list can keep its has-image badge honest without a router refresh — image
   * ops are independent of the text PATCH (same as the old attach buttons).
   */
  onImageChanged?: (hasImage: boolean) => void;
}

function EditQuestionForm({
  quizId,
  question,
  questionIndex,
  onClose,
  onSuccess,
  hasImageOverride,
  onImageChanged,
}: {
  quizId: string;
  question: QuestionRow;
  questionIndex?: number;
  onClose: () => void;
  onSuccess?: () => void;
  hasImageOverride?: boolean;
  onImageChanged?: (hasImage: boolean) => void;
}) {
  const locale = useLocale();
  const t = useTranslations("lecturer.dialogs");
  const tBuilder = useTranslations("lecturer.builder");
  const tCommon = useTranslations("common");
  const tMedia = useTranslations("media");

  const [draft, setDraft] = useState<QuestionDraft>(() => ({
    type: question.type,
    prompt: question.prompt,
    options: [...question.options],
    // QT-1: multi rows seed the set; singles the scalar (strictly one-of).
    ...(question.type === "multi_select"
      ? { correctIndices: [...(question.correct_indices ?? [])] }
      : { correctIndex: question.correct_index ?? 0 }),
    explanation: question.explanation ?? "",
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Image ops commit immediately (endpoint parity with the old attach row);
  // failures surface inline AND via toast — the toast survives a mid-upload
  // dialog close, the inline text does not.
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  async function runImageOp(
    op: () => Promise<Response>,
    nextHasImage: boolean,
    failureKey: string,
  ) {
    if (imageBusy) return;
    setImageBusy(true);
    setImageError(null);
    let ok = false;
    try {
      const res = await op();
      if (res.ok) {
        ok = true;
        onImageChanged?.(nextHasImage);
      }
    } catch {
      // Network-level throw — surfaced like an HTTP failure below.
    }
    setImageBusy(false);
    if (!ok) {
      // Inline AND toast: the toast survives a mid-upload dialog close, the
      // inline text does not. Localized copy only (server messages are
      // English-only and would leak under the ms locale).
      const message = tMedia(failureKey);
      setImageError(message);
      toast.error(message);
      // Rejection contract for the field's await: resolve only on success.
      throw new Error("image_op_failed");
    }
  }

  function uploadImage(file: File) {
    const form = new FormData();
    form.append("image", file, file.name);
    return runImageOp(
      () =>
        fetch(`/api/quizzes/${quizId}/questions/${question.id}/image`, {
          method: "POST",
          body: form,
        }),
      true,
      "uploadFailed",
    );
  }

  function removeImage() {
    return runImageOp(
      () =>
        fetch(`/api/quizzes/${quizId}/questions/${question.id}/image`, {
          method: "DELETE",
        }),
      false,
      "removeFailed",
    );
  }

  // Shared pure reducers (see quiz-builder-client) — the answer key follows
  // its option on remove/move; no drifted inline copies.
  function applyOptions(draft: QuestionDraft, op: OptionDraftOp): QuestionDraft {
    const next = applyOptionDraftOp(
      {
        options: draft.options,
        correctIndex: draft.correctIndex,
        correctIndices: draft.correctIndices,
      },
      op,
    );
    return { ...draft, ...next };
  }

  function setOption(index: number, value: string) {
    setDraft((d) => applyOptions(d, { kind: "set", index, value }));
  }

  function addOption() {
    setDraft((d) => applyOptions(d, { kind: "add" }));
  }

  function removeOption(index: number) {
    setDraft((d) => applyOptions(d, { kind: "remove", index }));
  }

  function moveOption(index: number, direction: "up" | "down") {
    setDraft((d) =>
      applyOptions(d, {
        kind: "move",
        from: index,
        to: direction === "up" ? index - 1 : index + 1,
      }),
    );
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);

    const payload = {
      type: draft.type,
      prompt: draft.prompt,
      options: draft.options,
      // QT-1: strictly one-of by type — multi carries the sorted set and no
      // scalar, singles the reverse (QuestionInputSchema enforces both ways).
      correctIndex: draft.type === "multi_select" ? undefined : draft.correctIndex,
      correctIndices: draft.type === "multi_select" ? draft.correctIndices : undefined,
      explanation: draft.explanation,
    };

    try {
      const res = await fetch(
        `/api/quizzes/${quizId}/questions/${question.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      onClose();
      onSuccess?.();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      setSaving(false);
    }
  }

  const defaultTrueFalseOptions = locale === "ms" ? ["Betul", "Salah"] : ["True", "False"];

  return (
    <>
      <DialogHeader className="shrink-0 pb-3 border-b-2 border-border/30">
        <DialogTitle className="text-xl font-bold font-heading">
          {t("editQuestionTitle", { number: questionIndex != null ? questionIndex + 1 : 1 })}
        </DialogTitle>
        <DialogDescription className="text-xs font-semibold text-muted-foreground mt-0.5">
          {t("editQuestionSubtitle")}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSave} className="flex flex-col flex-1 min-h-0 pt-4">
        <div className="flex-1 overflow-y-auto space-y-5 pr-2 -mr-1 py-1">
          {/* Type and Correct Answer */}
          <div className="flex flex-wrap items-center gap-4 sm:gap-6">
            <div className="space-y-1.5">
              <Label htmlFor="edit-q-type" className="text-xs font-extrabold text-foreground">
                {tBuilder("questionTypeLabel")}
              </Label>
              <Select
                value={draft.type}
                onValueChange={(v) => {
                  const type = v as "mcq" | "true_false" | "multi_select";
                  setDraft((d) => {
                    if (type === "true_false") {
                      return {
                        ...d,
                        type,
                        options: defaultTrueFalseOptions,
                        correctIndex: 0,
                        correctIndices: undefined,
                      };
                    }
                    if (type === "multi_select") {
                      // QT-1 gesture amendment: multi questions cap at 4
                      // options (palm-commit reserves five fingers) — a
                      // 5-option draft cannot switch; ask the lecturer to
                      // remove one option first.
                      if (d.options.length > 4) {
                        setError(tBuilder("multiOptionCap"));
                        return d;
                      }
                      // Seed the set from the current single mark.
                      const seed = d.correctIndex ?? 0;
                      return {
                        ...d,
                        type,
                        options: d.options.length >= 2 ? d.options : ["", ""],
                        correctIndex: undefined,
                        correctIndices: [Math.min(seed, Math.max(d.options.length - 1, 0))],
                      };
                    }
                    return {
                      ...d,
                      type,
                      options: d.options.length >= 2 ? d.options : ["", ""],
                      correctIndex: d.correctIndices?.[0] ?? 0,
                      correctIndices: undefined,
                    };
                  });
                }}
              >
                <SelectTrigger id="edit-q-type" className="w-full sm:w-auto sm:min-w-[12.5rem]">

                  <SelectValue placeholder={tBuilder("questionTypeLabel")}>
                    {(v) =>
                      v === "true_false"
                        ? tCommon("trueFalse")
                        : v === "multi_select"
                          ? tCommon("multiSelect")
                          : tCommon("mcq")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mcq">{tCommon("mcq")}</SelectItem>
                  <SelectItem value="true_false">{tCommon("trueFalse")}</SelectItem>
                  <SelectItem value="multi_select">{tCommon("multiSelect")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {draft.type === "multi_select" ? (
              // QT-1: a dropdown cannot multi-select — correct ANSWERS are a
              // toggle-button group (aria-pressed per option).
              <div className="space-y-1.5" role="group" aria-label={tBuilder("correctAnswersLabel")}>
                <Label className="text-xs font-extrabold text-foreground">
                  {tBuilder("correctAnswersLabel")}
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {draft.options.map((_, i) => {
                    const on = draft.correctIndices?.includes(i) ?? false;
                    return (
                      <button
                        key={i}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setDraft((d) => {
                            const cur = d.correctIndices ?? [];
                            const next = cur.includes(i)
                              ? cur.filter((x) => x !== i)
                              : [...cur, i].sort((a, b) => a - b);
                            return { ...d, correctIndices: next };
                          })
                        }
                        className={cn(
                          "rounded-full border-[2px] px-3 py-1 text-xs font-extrabold transition-colors",
                          on
                            ? "border-emerald-500 bg-emerald-100 text-emerald-900"
                            : "border-border bg-muted/60 text-muted-foreground hover:border-emerald-300"
                        )}
                      >
                        {tBuilder("optionLabel", { index: i + 1 })}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="edit-q-correct" className="text-xs font-extrabold text-foreground">
                  {tBuilder("correctAnswerLabel")}
                </Label>
                <Select
                  value={String((draft.correctIndex ?? 0) + 1)}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, correctIndex: Number(v) - 1 }))
                  }
                >
                  <SelectTrigger id="edit-q-correct" className="w-full sm:w-auto sm:min-w-[10rem]">
                    <SelectValue placeholder={tBuilder("correctAnswerLabel")}>
                      {(v) => (v ? `${tBuilder("optionLabel", { index: v })}` : tBuilder("correctAnswerLabel"))}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {draft.options.map((_, i) => (
                      <SelectItem key={i} value={String(i + 1)}>
                        {tBuilder("optionLabel", { index: i + 1 })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Question Prompt */}
          <div className="space-y-1.5">
            <Label htmlFor="edit-q-prompt" className="text-xs font-extrabold text-foreground">
              {tBuilder("promptLabel")}
            </Label>
            <Textarea
              id="edit-q-prompt"
              aria-label={tBuilder("promptLabel")}
              value={draft.prompt}
              onChange={(e) =>
                setDraft((d) => ({ ...d, prompt: e.target.value }))
              }
              rows={3}
              maxLength={2000}
              required
              placeholder={tBuilder("promptPlaceholder")}
              className="resize-y"
            />
          </div>

          {/* Image sits between prompt and options — same order as the
              add-question form and the player (WYSIWYG authoring). Commits
              immediately — independent of Save below. */}
          <QuestionImageField
            variant="committed"
            questionId={question.id}
            hasImage={hasImageOverride ?? Boolean(question.image_path)}
            altPrompt={draft.prompt}
            busy={imageBusy}
            errorText={imageError}
            disabled={saving}
            onFile={(file) => uploadImage(file)}
            onRemove={() => removeImage()}
          />

          {/* Options */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-extrabold text-foreground">{tBuilder("correctAnswerLabel")}</Label>
              <span className="text-xs font-bold text-emerald-800 bg-emerald-100/80 border border-emerald-300/60 rounded-full px-2.5 py-0.5">
                {draft.type === "multi_select"
                  ? `${tBuilder("correctAnswersLabel")}: ${(draft.correctIndices ?? []).map((i) => tBuilder("optionLabel", { index: i + 1 })).join(", ") || "—"}`
                  : `${tBuilder("correctAnswerLabel")}: ${tBuilder("optionLabel", { index: (draft.correctIndex ?? 0) + 1 })}`}
              </span>
            </div>
            <div className="space-y-2.5">
              {draft.options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2.5">
                  <span
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl font-heading text-xs font-extrabold transition-colors shadow-xs",
                      (draft.type === "multi_select"
                        ? (draft.correctIndices?.includes(i) ?? false)
                        : draft.correctIndex === i)
                        ? "border-[2px] border-emerald-500 bg-emerald-100 text-emerald-900 shadow-emerald-200/50"
                        : "border-[2px] border-border bg-muted/60 text-muted-foreground"
                    )}
                    title={
                      (draft.type === "multi_select"
                        ? (draft.correctIndices?.includes(i) ?? false)
                        : draft.correctIndex === i)
                        ? tBuilder("correctAnswerLabel")
                        : tBuilder("optionLabel", { index: i + 1 })
                    }
                  >
                    {i + 1}
                  </span>
                  <Input
                    value={opt}
                    onChange={(e) => setOption(i, e.target.value)}
                    maxLength={500}
                    placeholder={tBuilder("optionLabel", { index: i + 1 })}
                    aria-label={tBuilder("optionLabel", { index: i + 1 })}
                    disabled={draft.type === "true_false"}
                    className={cn(
                      "flex-1",
                      (draft.type === "multi_select"
                        ? (draft.correctIndices?.includes(i) ?? false)
                        : draft.correctIndex === i) && "border-emerald-400/80 bg-emerald-50/20"
                    )}
                  />
                  {draft.type !== "true_false" && (
                    <div className="flex shrink-0 items-center gap-1">
                      {draft.options.length > 1 && (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="size-8 rounded-lg"
                            onClick={() => moveOption(i, "up")}
                            disabled={i === 0}
                            aria-label={`${tBuilder("moveUp")} ${i + 1}`}
                          >
                            <ArrowUp className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="size-8 rounded-lg"
                            onClick={() => moveOption(i, "down")}
                            disabled={i === draft.options.length - 1}
                            aria-label={`${tBuilder("moveDown")} ${i + 1}`}
                          >
                            <ArrowDown className="size-4" />
                          </Button>
                        </>
                      )}
                      {draft.options.length > 2 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="size-8 rounded-lg text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => removeOption(i)}
                          aria-label={`${tBuilder("deleteBtn")} ${i + 1}`}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {draft.type === "mcq" && draft.options.length < 5 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addOption}
                className="mt-1"
              >
                {tBuilder("addOptionBtn")}
              </Button>
            )}
            {draft.type === "multi_select" && draft.options.length < 4 && (
              // QT-1 gesture amendment: multi questions cap at 4 options
              // (palm-commit reserves five fingers).
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addOption}
                className="mt-1"
              >
                {tBuilder("addOptionBtn")}
              </Button>
            )}
          </div>

          {/* Explanation */}
          <div className="space-y-1.5">
            <Label htmlFor="edit-q-explanation" className="text-xs font-extrabold text-foreground">
              {tBuilder("explanationLabel")}
            </Label>
            <Textarea
              id="edit-q-explanation"
              value={draft.explanation}
              onChange={(e) =>
                setDraft((d) => ({ ...d, explanation: e.target.value }))
              }
              rows={2}
              maxLength={2000}
              placeholder={tBuilder("explanationPlaceholder")}
              className="resize-y"
            />
          </div>

          {error && (
            <p
              className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="shrink-0 pt-4 border-t-2 border-border/40 mt-3 flex items-center justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={saving}
          >
            {tCommon("cancel")}
          </Button>
          <Button
            type="submit"
            disabled={saving || !draft.prompt.trim()}
          >
            {saving ? tCommon("saving") : t("saveChanges")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

export function EditQuestionDialog({
  open,
  onOpenChange,
  quizId,
  question,
  questionIndex,
  onSuccess,
  hasImageOverride,
  onImageChanged,
}: EditQuestionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {question && (
        <DialogContent className="max-h-[88vh] flex flex-col sm:max-w-2xl p-6 sm:p-7 overflow-hidden gap-0">
          <EditQuestionForm
            key={question.id}
            quizId={quizId}
            question={question}
            questionIndex={questionIndex}
            onClose={() => onOpenChange(false)}
            onSuccess={onSuccess}
            hasImageOverride={hasImageOverride}
            onImageChanged={onImageChanged}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}
