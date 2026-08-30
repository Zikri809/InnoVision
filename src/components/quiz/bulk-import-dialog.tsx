"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FileUp, ListPlus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  parseImportText,
  type ImportProblem,
  type ParsedImportRow,
} from "@/lib/quizzes/import-parser";

/**
 * AP-1 bulk-import dialog (PLAN_R_AUTHORING_PRODUCTIVITY).
 *
 * Pipe-separated text is parsed CLIENT-side into a live preview; the whole
 * batch is rejected atomically while any row has a problem (nothing POSTs
 * until every row is valid). Commit hands the parsed rows to
 * POST /api/quizzes/[id]/import-questions, which re-validates and appends
 * through the existing save_quiz_questions RPC. Success follows the
 * GenerateFromFileDialog pattern: toast → router.refresh() → close → reset.
 */

const QUIZ_QUESTION_CAP = 30;

type ProblemT = (key: string, params?: Record<string, number | string>) => string;

/** Closed-enum problem renderer — LITERAL t() calls only (check:i18n scans literal call sites; dynamic keys would also throw at runtime under next-intl). */
function problemMessage(t: ProblemT, p: ImportProblem): string {
  const line = p.line;
  const max = p.params?.max ?? 0;
  switch (p.code) {
    case "tooManyRows":
      return t("problemTooManyRows", { line, max });
    case "tooFewOptions":
      return t("problemTooFewOptions", { line });
    case "tooManyCells":
      return t("problemTooManyCells", { line });
    case "emptyCell":
      return t("problemEmptyCell", { line });
    case "emptyPrompt":
      return t("problemEmptyPrompt", { line });
    case "promptTooLong":
      return t("problemPromptTooLong", { line, max });
    case "optionTooLong":
      return t("problemOptionTooLong", { line, max });
    case "duplicateOptions":
      return t("problemDuplicateOptions", { line });
    case "missingAnswer":
      return t("problemMissingAnswer", { line });
    case "badAnswerMark":
      return t("problemBadAnswerMark", { line });
    case "answerOutOfRange":
      return t("problemAnswerOutOfRange", { line });
    case "multiTooManyOptions":
      return t("problemMultiTooManyOptions", { line, max });
    case "doubleMark":
      return t("problemDoubleMark", { line });
  }
}

export function BulkImportDialog({
  quizId,
  open,
  onOpenChange,
  questionCount,
}: {
  quizId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Server-truth question count (builder props) — the capacity basis. */
  questionCount: number;
}) {
  const router = useRouter();
  const t = useTranslations("lecturer.builder.import");
  const tCommon = useTranslations("common");

  const [rawText, setRawText] = useState("");
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submitLock = useRef(false);

  const remaining = Math.max(0, QUIZ_QUESTION_CAP - questionCount);
  const overCap = rawText.trim() !== "" && remaining === 0;

  const parsed = useMemo(
    () => (overCap ? { rows: [], problems: [] } : parseImportText(rawText, remaining)),
    [rawText, overCap, remaining],
  );

  const canCommit =
    !committing && parsed.rows.length > 0 && parsed.problems.length === 0;

  function reset() {
    setRawText("");
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Guard before reading: the route's 512 KB body cap would reject it
    // anyway, but reading a multi-MB file into the textarea first is waste.
    if (file.size > 512 * 1024) {
      setError(t("fileTooLarge"));
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    try {
      const text = await file.text();
      setRawText(text);
      setError(null);
    } catch {
      setError(tCommon("errorGeneric"));
    }
  }

  async function handleCommit() {
    if (!canCommit || submitLock.current) return;
    submitLock.current = true;
    setCommitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/quizzes/${quizId}/import-questions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          questions: parsed.rows.map((row) => ({
            type: row.type,
            prompt: row.prompt,
            options: row.options,
            correctIndex: row.correctIndex,
            // QT-1: multi-select rows carry the sorted correct set instead of
            // the scalar (undefined keys are dropped by JSON.stringify, so
            // single-answer rows keep the exact historical payload shape).
            correctIndices: row.correctIndices,
          })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const codeMap: Record<string, string> = {
          quiz_question_limit_exceeded: t("errCap"),
          rate_limited: t("errRateLimited"),
        };
        setError(codeMap[body.error as string] ?? body.message ?? tCommon("errorGeneric"));
        return;
      }
      toast.success(t("importedToast", { count: (body as { added?: number }).added ?? 0 }));
      router.refresh();
      onOpenChange(false);
      reset();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      submitLock.current = false;
      setCommitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[94vh] flex flex-col sm:max-w-3xl overflow-hidden p-6 sm:p-7 gap-0">
        <DialogHeader className="shrink-0 pb-3 border-b-[3px] border-border/40">
          <DialogTitle className="text-xl font-bold font-heading flex items-center gap-2">
            <ListPlus className="size-5 text-primary" aria-hidden="true" />
            {t("dialogTitle")}
          </DialogTitle>
          <DialogDescription className="text-xs font-semibold text-muted-foreground mt-0.5">
            {t("dialogSubtitle", { remaining })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-4 pr-1">
          <div aria-live="polite">
            {error && (
              <p
                className="rounded-xl border-[3px] border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs font-bold text-destructive"
                role="alert"
              >
                {error}
              </p>
            )}
          </div>

          <div className="space-y-2 rounded-2xl border-[3px] border-border bg-card p-3.5 shadow-[var(--shadow-clay-sm)]">
            <Label htmlFor="bulk-import-text" className="text-xs font-extrabold text-foreground">
              {t("pasteLabel")}
            </Label>
            <Textarea
              id="bulk-import-text"
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder={t("pastePlaceholder")}
              rows={6}
              maxLength={400000}
              disabled={committing}
              className="resize-y font-mono text-xs font-medium rounded-xl border-[3px] border-border bg-background/50 focus:bg-background focus:border-primary transition-colors"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Input
                  ref={fileInputRef}
                  id="bulk-import-file"
                  type="file"
                  data-testid="bulk-import-file-input"
                  accept=".txt,.csv,text/plain,text/csv"
                  onChange={handleFileChange}
                  disabled={committing}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={committing}
                >
                  <FileUp className="mr-1.5 size-4" aria-hidden="true" />
                  {t("fileBtn")}
                </Button>
                <span className="text-[11px] font-semibold text-muted-foreground">
                  {t("fileHint")}
                </span>
              </div>
              <span className="text-[11px] font-bold text-muted-foreground">
                {t("remainingChip", { remaining })}
              </span>
            </div>
          </div>

          {overCap && (
            <p
              className="rounded-xl border-[3px] border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs font-bold text-destructive"
              role="alert"
            >
              {t("quizFull")}
            </p>
          )}

          {rawText.trim() !== "" && !overCap && (
            <div className="space-y-2">
              <p className="text-xs font-extrabold text-foreground">
                {t("previewTitle", { count: parsed.rows.length })}
              </p>

              {parsed.problems.length > 0 && (
                <ul
                  className="space-y-1 rounded-xl border-[3px] border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs font-bold text-destructive"
                  aria-live="polite"
                  role="alert"
                >
                  {parsed.problems.map((p, i) => (
                    <li key={`${p.line}-${p.code}-${i}`}>{problemMessage(t, p)}</li>
                  ))}
                </ul>
              )}

              {parsed.problems.length === 0 && parsed.rows.length === 0 && (
                <p className="rounded-xl border-[3px] border-border bg-muted px-4 py-2.5 text-xs font-semibold text-muted-foreground">
                  {t("noRowsYet")}
                </p>
              )}

              <ul className="space-y-2">
                {parsed.rows.map((row) => (
                  <PreviewRow key={row.line} row={row} typeLabel={row.type === "true_false" ? tCommon("trueFalse") : row.type === "multi_select" ? tCommon("multiSelect") : tCommon("mcq")} />
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 pt-3 border-t-[3px] border-border/40">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            disabled={committing}
          >
            {tCommon("cancel")}
          </Button>
          <Button type="button" onClick={handleCommit} disabled={!canCommit}>
            <Upload className="mr-1.5 size-4" aria-hidden="true" />
            {committing
              ? t("committingBtn")
              : t("commitBtn", { count: parsed.rows.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewRow({
  row,
  typeLabel,
}: {
  row: ParsedImportRow;
  typeLabel: string;
}) {
  return (
    <li className="flex flex-col gap-1.5 rounded-2xl border-[3px] border-border bg-card p-3 shadow-[var(--shadow-clay-sm)] sm:flex-row sm:items-start sm:gap-3">
      <span className="shrink-0 text-[11px] font-bold text-muted-foreground sm:w-14">
        {`#${row.line}`}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-bold text-foreground break-words">{row.prompt}</p>
        <p className="text-xs font-semibold text-muted-foreground break-words">
          {row.options.join(" · ")}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 min-w-0">
        <span className="rounded-full border-2 border-border bg-muted px-2 py-0.5 text-[10px] font-extrabold text-muted-foreground">
          {typeLabel}
        </span>
        <span className="rounded-full border-2 border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-extrabold text-primary min-w-0 max-w-full [overflow-wrap:anywhere]">
          {row.type === "multi_select" && row.correctIndices
            ? row.correctIndices.map((i) => row.options[i]).join(" / ")
            : row.options[row.correctIndex ?? 0]}
        </span>
      </div>
    </li>
  );
}
