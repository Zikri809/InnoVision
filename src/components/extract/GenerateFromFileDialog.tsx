"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
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

// Local-only deployment: a 30-question generation on a large deck can take a
// couple of minutes. The client waits LONGER than any realistic server
// budget (was 65s for the old 60s Vercel cap). On timeout it refreshes and
// tells the lecturer to check — it never auto-retries (which could
// double-spend on a slow-but-successful generation).
const CLIENT_TIMEOUT_MS = 20 * 60_000;

/**
 * "Generate from file" dialog. Orchestrates the PLAN §3.2 cascade:
 *  upload → native/OCR extraction → extracted-text preview → question count →
 *  POST /api/ai/generate-quiz → render the response (no DB refetch) → refresh.
 *
 * Timeout behavior (R2): the client waits LONGER than the server budget (65s vs
 * 60s) and, on timeout, refreshes + tells the lecturer to check — it never
 * auto-retries (which could double-spend on a slow-but-successful generation).
 */
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
  const [file, setFile] = useState<File | null>(null);
  const [storagePath, setStoragePath] = useState<string | null>(null);
  const [engine, setEngine] = useState<ExtractEngine>(() => {
    // Restore the lecturer's last-chosen engine from localStorage if it's a
    // valid value, otherwise fall back to the server-configured default.
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
          ? "Text extracted directly from the file (native, no OCR needed) — the chosen OCR engine was skipped because the file has a text layer."
          : `OCR complete (${result.engine}). You can review the text below.`,
      );
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      setError(
        aborted
          ? "Extraction is taking too long. Try a smaller file or a different engine."
          : err instanceof Error
            ? err.message
            : "Extraction failed.",
      );
    } finally {
      clearTimeout(timer);
      setBusy(false);
      setProgress(null);
    }
  }

  async function handleGenerate() {
    if (submitLock.current) return;
    if (!extractedText && !storagePath) {
      setError("Extract text first, or upload a file to use as the source.");
      return;
    }
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
          ...(extractedText ? { extractedText } : { sourcePath: storagePath }),
          questionCount,
        }),
        signal: controller.signal,
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? "Generation failed.");
        return;
      }
      // Render the response directly (no DB refetch — E2E determinism), then
      // refresh the server component so the new questions persist server-side.
      setNotice("Quiz generated. Review the questions below, then publish when ready.");
      reset();
      router.refresh();
      onOpenChange(false);
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted) {
        // R2: never auto-retry; show current state and let the lecturer check.
        setError(
          "Generation is taking longer than expected. It may still complete — refresh the page to check your questions.",
        );
        router.refresh();
        onOpenChange(false);
      } else {
        setError("Network error generating the quiz.");
      }
    } finally {
      clearTimeout(timer);
      submitLock.current = false;
      setBusy(false);
    }
  }

  const canGenerate =
    Boolean(extractedText || storagePath) && !busy && (!hasQuestions || confirmReplace);

  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (!o) reset();
      onOpenChange(o);
    }}>
      <DialogContent className="max-h-[88vh] flex flex-col sm:max-w-xl p-6 overflow-hidden gap-0">
        <DialogHeader className="shrink-0 pb-3 border-b-2 border-border/30">
          <DialogTitle>Generate quiz from file</DialogTitle>
          <DialogDescription>
            Upload a chapter PDF, slides, or document. We&apos;ll extract the text,
            then AI-generate questions you can review and edit.
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
                  label={
                    progress.stage === "native"
                      ? "Parsing file…"
                      : progress.engine === "glm"
                        ? "GLM-OCR…"
                        : progress.engine === "vision"
                          ? "Cloud Vision OCR…"
                          : "Tesseract OCR…"
                  }
                />
              )}
            </>
          )}

          {extractedText && (
            <>
              <div className="rounded-2xl border-[3px] border-border bg-card p-4 shadow-[var(--shadow-clay-sm)]">
                <p className="mb-2 text-xs font-bold text-muted-foreground">
                  Extracted text ({extractedText.length.toLocaleString()} chars)
                  — engine: {extractEngine === "glm" ? "GLM-OCR" : extractEngine === "vision" ? "Cloud Vision" : extractEngine === "tesseract" ? "Tesseract" : "Native"}
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
                    // Also clear the previously-uploaded storage path so the
                    // Generate button doesn't silently re-target the OLD file.
                    setStoragePath(null);
                  }}
                >
                  Choose a different file
                </Button>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="question-count" className="font-extrabold">Number of questions</Label>
                <Input
                  id="question-count"
                  type="number"
                  min={3}
                  max={30}
                  value={questionCount}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setQuestionCount(Number(e.target.value) || 10)}
                />
                <p className="text-xs font-semibold text-muted-foreground">Between 3 and 30 questions.</p>
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
                    This quiz already has questions. Generating will replace them.
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
            Cancel
          </Button>
          {!extractedText ? (
            <Button
              type="button"
              onClick={handleExtract}
              disabled={!file || busy}
            >
              {busy ? "Extracting…" : "Extract text"}
            </Button>
          ) : (
            <Button type="button" onClick={handleGenerate} disabled={!canGenerate}>
              {busy ? "Generating…" : "Generate quiz"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
