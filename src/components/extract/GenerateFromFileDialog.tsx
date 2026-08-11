"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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

const CLIENT_TIMEOUT_MS = 65_000;

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
          ? "Text extracted from the file (no OCR needed)."
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Generate quiz from file</DialogTitle>
          <DialogDescription>
            Upload a chapter PDF, slides, or document. We&apos;ll extract the text,
            then AI-generate questions you can review and edit.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!extractedText && (
            <>
              <UploadDropzone
                userId={userId}
                quizId={quizId}
                onUploaded={(path, f) => {
                  setStoragePath(path);
                  setFile(f);
                }}
                onError={setError}
              />
              <EnginePicker config={config} value={engine} onChange={setEngine} />
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
                          ? "Cloud vision OCR…"
                          : "Tesseract OCR…"
                  }
                />
              )}
              <Button
                type="button"
                onClick={handleExtract}
                disabled={!file || busy}
                className="w-full"
              >
                {busy && !extractedText ? "Extracting…" : "Extract text"}
              </Button>
            </>
          )}

          {extractedText && (
            <>
              <div className="rounded-lg border p-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  Extracted text ({extractedText.length.toLocaleString()} chars)
                  — engine: {extractEngine}
                </p>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                  {extractedText.slice(0, 2000)}
                  {extractedText.length > 2000 ? "\n…" : ""}
                </pre>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2"
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

              <div className="space-y-1">
                <Label htmlFor="question-count">Number of questions</Label>
                <Input
                  id="question-count"
                  type="number"
                  min={3}
                  max={30}
                  value={questionCount}
                  onChange={(e) => setQuestionCount(Number(e.target.value) || 10)}
                />
                <p className="text-xs text-muted-foreground">Between 3 and 30.</p>
              </div>

              {hasQuestions && (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={confirmReplace}
                    onChange={(e) => setConfirmReplace(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    This quiz already has {hasQuestions ? "questions" : ""}. Generating will
                    replace them.
                  </span>
                </label>
              )}

              {notice && (
                <p className="text-sm text-emerald-600" role="status">
                  {notice}
                </p>
              )}
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button type="button" onClick={handleGenerate} disabled={!canGenerate}>
                  {busy ? "Generating…" : "Generate quiz"}
                </Button>
              </DialogFooter>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
