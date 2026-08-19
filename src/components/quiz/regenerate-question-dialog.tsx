"use client";

import { useState } from "react";
import { RefreshCw, Wand2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { QuestionRow } from "@/app/(lecturer)/lecturer/quizzes/[id]/builder/quiz-builder-client";

export interface RegenerateQuestionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  question: QuestionRow | null;
  questionIndex?: number;
  onSuccess?: () => void;
}

function RegenerateQuestionForm({
  question,
  questionIndex,
  onClose,
  onSuccess,
}: {
  question: QuestionRow;
  questionIndex?: number;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const t = useTranslations("lecturer.dialogs");
  const tCommon = useTranslations("common");

  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRegenerate(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/ai/regenerate-question", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          questionId: question.id,
          ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
        }),
      });
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
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader className="shrink-0 pb-3 border-b-2 border-border/30">
        <DialogTitle className="flex items-center gap-2 text-xl font-bold font-heading">
          <Wand2 className="size-5 text-primary" />
          {t("regenQuestionTitle", { number: questionIndex != null ? questionIndex + 1 : 1 })}
        </DialogTitle>
        <DialogDescription className="text-xs font-semibold text-muted-foreground mt-0.5">
          {t("regenQuestionSubtitle")}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleRegenerate} className="flex flex-col gap-4 pt-4">
        {/* Current question preview */}
        <div className="rounded-xl border-[2px] border-border bg-muted/40 p-3 space-y-1">
          <p className="text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">
            {t("currentQuestion")}
          </p>
          <p className="text-xs font-semibold text-foreground italic line-clamp-3">
            &ldquo;{question.prompt}&rdquo;
          </p>
        </div>

        {/* AI Steering prompt */}
        <div className="space-y-1.5">
          <Label htmlFor="regen-instruction" className="text-xs font-extrabold text-foreground">
            {t("steeringPrompt")}
          </Label>
          <Textarea
            id="regen-instruction"
            aria-label={t("steeringPrompt")}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={t("steeringPlaceholder")}
            rows={3}
            maxLength={500}
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

        <DialogFooter className="pt-3 border-t-2 border-border/40 mt-1 flex items-center justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={busy}
          >
            {tCommon("cancel")}
          </Button>
          <Button
            type="submit"
            disabled={busy}
            aria-label={t("regenBtn")}
          >
            <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
            {busy ? tCommon("loading") : t("regenBtn")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

export function RegenerateQuestionDialog({
  open,
  onOpenChange,
  question,
  questionIndex,
  onSuccess,
}: RegenerateQuestionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {question && (
        <DialogContent className="max-h-[85vh] flex flex-col sm:max-w-lg p-6 sm:p-7 overflow-hidden gap-0">
          <RegenerateQuestionForm
            key={question.id}
            question={question}
            questionIndex={questionIndex}
            onClose={() => onOpenChange(false)}
            onSuccess={onSuccess}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}
