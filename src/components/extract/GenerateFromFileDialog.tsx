"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UploadDropzone } from "./UploadDropzone";
import { EnginePicker } from "./EnginePicker";
import { OcrProgress } from "./OcrProgress";
import { runExtractionPipeline, type PipelineProgress } from "@/lib/extract/pipeline";
import type { ExtractEngine, OcrConfig } from "@/lib/extract/types";

const CLIENT_TIMEOUT_MS = 20 * 60_000;

export function GenerateFromFileDialog({
  quizId,
  userId,
  config,
  open,
  onOpenChange,
  hasQuestions,
}: {
  quizId: string;
  userId: string;
  config: OcrConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasQuestions: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("extract");
  const tCommon = useTranslations("common");

  const [file, setFile] = useState<File | null>(null);
  const [storagePath, setStoragePath] = useState<string | null>(null);
  const [engine, setEngine] = useState<ExtractEngine>(() => {
    try {
      const stored = localStorage.getItem("innovision.ocrEngine");
      if (stored === "tesseract" || stored === "glm" || stored === "vision") {
        return stored;
      }
    } catch {
      /* ignore storage errors */
    }
    return config.defaultEngine;
  });
  const [extractedText, setExtractedText] = useState<string | null>(null);
  const [extractEngine, setExtractEngine] = useState<ExtractEngine | null>(null);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [questionCount, setQuestionCount] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const submitLock = useRef(false);

  function reset() {
    setFile(null);
    setStoragePath(null);
    setExtractedText(null);
    setExtractEngine(null);
    setProgress(null);
    setError(null);
    setNotice(null);
    setConfirmReplace(false);
  }

  async function handleExtract() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    try {
      const result = await runExtractionPipeline({
        file,
        engine,
        config,
        onProgress: (p) => setProgress(p),
        signal: controller.signal,
      });
      setExtractedText(result.text);
      setExtractEngine(result.engine);
      setNotice(
        result.engine === "native"
          ? "Text extracted directly from file (native)."
          : `OCR complete (${result.engine}).`,
      );
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      setError(
        aborted
          ? t("timeout")
          : err instanceof Error
            ? err.message
            : tCommon("errorGeneric"),
      );
    } finally {

      clearTimeout(timer);
      setBusy(false);
      setProgress(null);
    }
  }

  async function handleGenerate() {
    if (!extractedText || submitLock.current || busy) return;
    submitLock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

    try {
      const res = await fetch("/api/ai/generate-quiz", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          quizId,
          extractedText,
          questionCount,
          sourcePath: storagePath ?? undefined,
        }),
        signal: controller.signal,
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }

      setNotice(t("generateBtn"));
      router.refresh();
      onOpenChange(false);
      reset();
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted) {
        setError(t("generationDelayed"));
        router.refresh();
      } else {
        setError(tCommon("errorGeneric"));
      }
    } finally {
      clearTimeout(timer);
      submitLock.current = false;
      setBusy(false);
    }

  }

  const canGenerate =
    Boolean(extractedText) &&
    !busy &&
    (!hasQuestions || confirmReplace);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] flex flex-col sm:max-w-2xl overflow-hidden p-6 sm:p-7 gap-0">
        <DialogHeader className="shrink-0 pb-3 border-b-2 border-border/30">
          <DialogTitle className="text-xl font-bold font-heading">
            {t("dialogTitle")}
          </DialogTitle>
          <DialogDescription className="text-xs font-semibold text-muted-foreground mt-0.5">
            {t("dialogSubtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-4 pr-1">
          {!extractedText && (
            <>
              <UploadDropzone
                userId={userId}
                quizId={quizId}
                fileName={file?.name}
                onUploaded={(path, f) => {
                  setStoragePath(path);
                  setFile(f);
                }}
                onError={setError}
              />
              <EnginePicker config={config} value={engine} onChange={setEngine} />
              {error && (
                <p className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive" role="alert">
                  {error}
                </p>
              )}
              {progress && (
                <OcrProgress
                  page={progress.page}
                  total={progress.total}
                  label={t("ocrProgressLabel")}
                />
              )}
            </>
          )}

          {extractedText && (
            <>
              <div className="rounded-2xl border-[3px] border-border bg-card p-4 shadow-[var(--shadow-clay-sm)]">
                <p className="mb-2 text-xs font-bold text-muted-foreground">
                  {t("previewTitle")} ({t("chars", { count: extractedText.length.toLocaleString() })})
                  — {extractEngine === "glm" ? "GLM-OCR" : extractEngine === "vision" ? "Cloud Vision" : extractEngine === "tesseract" ? "Tesseract" : "Native"}
                </p>

                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-muted/60 p-3 text-xs font-mono font-medium">
                  {extractedText}
                </pre>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2 font-bold"
                  onClick={() => {
                    setExtractedText(null);
                    setFile(null);
                    setStoragePath(null);
                  }}
                >
                  {t("dropzoneReady")}
                </Button>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="question-count" className="font-extrabold">{t("questionCountLabel")}</Label>
                <Input
                  id="question-count"
                  type="number"
                  min={3}
                  max={30}
                  value={questionCount}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setQuestionCount(Number(e.target.value) || 10)}
                />
              </div>

              {hasQuestions && (
                <div className="flex items-start gap-2.5 rounded-xl border-[3px] border-amber-300/80 bg-amber-50/60 p-3">
                  <Checkbox
                    id="confirm-replace"
                    checked={confirmReplace}
                    onCheckedChange={(c) => setConfirmReplace(Boolean(c))}
                    className="mt-0.5"
                  />
                  <Label htmlFor="confirm-replace" className="text-xs font-semibold text-amber-900 cursor-pointer">
                    {t("warningReplace")}
                  </Label>
                </div>
              )}

              {notice && (
                <p className="rounded-xl border-[3px] border-emerald-300 bg-emerald-100 dark:bg-emerald-950/40 px-4 py-2.5 text-sm font-bold text-emerald-800 dark:text-emerald-300" role="status">
                  {notice}
                </p>
              )}
              {error && (
                <p className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        <DialogFooter className="shrink-0 pt-3 border-t-2 border-border/40 flex items-center justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {tCommon("cancel")}
          </Button>
          {!extractedText ? (
            <Button
              type="button"
              onClick={handleExtract}
              disabled={!file || busy}
            >
              {busy ? tCommon("loading") : t("generateBtn")}
            </Button>
          ) : (
            <Button type="button" onClick={handleGenerate} disabled={!canGenerate}>
              {busy ? t("generatingBtn") : t("generateBtn")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
