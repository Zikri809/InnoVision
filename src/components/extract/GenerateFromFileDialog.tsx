"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  Minus,
  Plus,
  PlusCircle,
  RefreshCw,
  Sparkles,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UploadDropzone, type UploadedFileItem } from "./UploadDropzone";
import { EnginePicker } from "./EnginePicker";
import { OcrProgress } from "./OcrProgress";
import { BotAvatar } from "@/components/bot/bot-avatar";
import { runExtractionPipeline, type PipelineProgress } from "@/lib/extract/pipeline";
import type { ExtractEngine, OcrConfig } from "@/lib/extract/types";
import type {
  QuizDifficulty,
  QuestionFormatDistribution,
  QuizGenerationMode,
} from "@/lib/ai/validation";

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

  const [step, setStep] = useState<1 | 2>(1);
  const stepContainerRef = useRef<HTMLDivElement>(null);

  const [files, setFiles] = useState<UploadedFileItem[]>([]);
  // Lazy localStorage read is hydration-safe here: the dialog body (and this
  // state consumer) only mounts client-side when `open` flips true — it never
  // renders during SSR or the hydration pass.
  const [engine, setEngine] = useState<ExtractEngine>(() => {
    try {
      const stored = localStorage.getItem("innovision.ocrEngine");
      if (stored === "tesseract" || stored === "glm" || stored === "native") {
        return stored;
      }
    } catch {
      /* ignore storage errors */
    }
    return config.defaultEngine;
  });
  const [extractedText, setExtractedText] = useState<string | null>(null);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [currentExtractingFile, setCurrentExtractingFile] = useState<string | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(false);

  const [questionCount, setQuestionCount] = useState(10);
  const [questionCountInput, setQuestionCountInput] = useState("10");
  const [difficulty, setDifficulty] = useState<QuizDifficulty>("mixed");
  const [formatDistribution, setFormatDistribution] = useState<QuestionFormatDistribution>("mixed");
  const [generationMode, setGenerationMode] = useState<QuizGenerationMode>("replace");
  const [steeringPrompt, setSteeringPrompt] = useState("");
  const [language, setLanguage] = useState<"auto" | "en" | "ms">("auto");
  const [isLowDensity, setIsLowDensity] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const submitLock = useRef(false);
  const activeAbortRef = useRef<AbortController | null>(null);

  function reset() {
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
    setStep(1);
    setFiles([]);
    setExtractedText(null);
    setIsLowDensity(false);
    setProgress(null);
    setCurrentExtractingFile(null);
    setError(null);
    setNotice(null);
    setSteeringPrompt("");
    setDifficulty("mixed");
    setFormatDistribution("mixed");
    setGenerationMode("replace");
    setPreviewExpanded(false);
    setQuestionCount(10);
    setQuestionCountInput("10");
    submitLock.current = false;
    setBusy(false);
  }

  // Close-path reset happens in the Dialog's onOpenChange (reset() there);
  // this effect only aborts any in-flight generation on unmount.
  useEffect(() => {
    return () => {
      activeAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    stepContainerRef.current?.focus();
  }, [step]);

  function handleFilesChanged(newFiles: UploadedFileItem[]) {
    setFiles(newFiles);
    setExtractedText(null);
    setIsLowDensity(false);
  }

  async function handleExtractAll() {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    const controller = new AbortController();
    activeAbortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

    try {
      const texts: string[] = [];
      let totalPages = 0;
      let hasLowConfidence = false;
      let hasOfficeFiles = false;

      for (let i = 0; i < files.length; i++) {
        if (controller.signal.aborted) return;
        const item = files[i];
        const isOffice = /\.(pptx|docx)$/i.test(item.file.name);
        if (isOffice) hasOfficeFiles = true;

        setCurrentExtractingFile(`${item.file.name} (${i + 1}/${files.length})`);

        const result = await runExtractionPipeline({
          file: item.file,
          engine,
          config,
          onProgress: (p) => setProgress(p),
          signal: controller.signal,
        });

        totalPages += result.pages || 1;
        if (result.lowConfidence) {
          hasLowConfidence = true;
        }

        if (result.text?.trim()) {
          texts.push(
            files.length > 1
              ? `=== SOURCE [${i + 1}/${files.length}]: ${item.file.name} ===\n${result.text.trim()}`
              : result.text.trim(),
          );
        }
      }

      const combinedText = texts.join("\n\n");
      if (!combinedText.trim()) {
        throw new Error(t("emptyTextError"));
      }

      const words = combinedText.trim().split(/\s+/).filter(Boolean).length;
      const avgWordsPerPage = totalPages > 0 ? Math.round(words / totalPages) : 0;
      const avgCharsPerPage = totalPages > 0 ? Math.round(combinedText.length / totalPages) : 0;

      // Heuristic: Flag presentation/office decks where text density is suspiciously low (<12 words or <50 chars per page)
      const lowDensityDetected = hasOfficeFiles && (hasLowConfidence || avgWordsPerPage < 12 || avgCharsPerPage < 50);
      setIsLowDensity(lowDensityDetected);

      setExtractedText(combinedText);
      setStep(2);
    } catch (err) {
      if (controller.signal.aborted) return;
      const aborted = err instanceof Error && err.name === "AbortError";
      const msg = err instanceof Error ? err.message : "";
      if (aborted) {
        setError(t("timeout"));
      } else if (msg === "glm_error") {
        setError(t("glmError"));
      } else if (msg === "glm_timeout") {
        setError(t("glmTimeout"));
      } else if (msg === "glm_model_unavailable") {
        setError(t("glmUnavailable"));
      } else if (msg === "canvas_unavailable") {
        setError(t("canvasUnavailable"));
      } else if (msg === "unsupported_file_type") {
        setError(t("unsupportedType"));
      } else {
        setError(msg || tCommon("errorGeneric"));
      }
    } finally {
      clearTimeout(timer);
      activeAbortRef.current = null;
      setBusy(false);
      setProgress(null);
      setCurrentExtractingFile(null);
    }
  }

  async function handleGenerate() {
    if (!extractedText || submitLock.current || busy) return;
    submitLock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);

    const controller = new AbortController();
    activeAbortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

    try {
      const res = await fetch("/api/ai/generate-quiz", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          quizId,
          extractedText,
          questionCount,
          mode: generationMode,
          difficulty,
          formatDistribution,
          steeringPrompt: steeringPrompt.trim() || undefined,
          language,
          sourcePaths: files.map((f) => f.path),
        }),
        signal: controller.signal,
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }

      setNotice(t("questionsGenerated"));
      router.refresh();
      onOpenChange(false);
      reset();
    } catch (err) {
      if (controller.signal.aborted) return;
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted) {
        setError(t("generationDelayed"));
        router.refresh();
      } else {
        setError(tCommon("errorGeneric"));
      }
    } finally {
      clearTimeout(timer);
      activeAbortRef.current = null;
      submitLock.current = false;
      setBusy(false);
    }
  }

  function handleQuestionCountBlur() {
    const val = Number(questionCountInput);
    const clamped = isNaN(val) ? 10 : Math.max(3, Math.min(30, val));
    setQuestionCount(clamped);
    setQuestionCountInput(String(clamped));
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
          <div className="flex items-center justify-between gap-2 pr-6">
            <DialogTitle className="text-xl font-bold font-heading flex items-center gap-2">
              <Sparkles className="size-5 text-primary" />
              {t("dialogTitle")}
            </DialogTitle>
            <span className="rounded-full border-[2px] border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-extrabold text-primary">
              {t("stepIndicator", { step, total: 2 })}
            </span>
          </div>
          <DialogDescription className="text-xs font-semibold text-muted-foreground mt-0.5">
            {step === 1 ? t("dialogSubtitle") : t("step2Title")}
          </DialogDescription>
        </DialogHeader>

        <div
          ref={stepContainerRef}
          tabIndex={-1}
          className="flex-1 overflow-y-auto space-y-4 py-4 pr-1 outline-none"
        >
          <div aria-live="polite">
            {error && (
              <p
                className="rounded-xl border-[3px] border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs font-bold text-destructive"
                role="alert"
              >
                {error}
              </p>
            )}
            {notice && (
              <p
                className="rounded-xl border-[3px] border-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-4 py-2.5 text-xs font-bold text-emerald-800 dark:text-emerald-300"
                role="status"
              >
                {notice}
              </p>
            )}
          </div>

          {step === 1 && (
            <div className="space-y-4">
              <UploadDropzone
                userId={userId}
                quizId={quizId}
                files={files}
                onFilesChanged={handleFilesChanged}
                onError={setError}
                disabled={busy}
              />

              <EnginePicker
                value={engine}
                onChange={setEngine}
                files={files}
                disabled={busy}
              />

              {busy && (
                <div className="space-y-2 rounded-2xl border-[3px] border-border bg-card p-3.5 shadow-[var(--shadow-clay-sm)]">
                  {currentExtractingFile && (
                    <p className="text-xs font-bold text-foreground">
                      {t("extractingFile", { file: currentExtractingFile })}
                    </p>
                  )}
                  {progress ? (
                    <OcrProgress
                      page={progress.page}
                      total={progress.total}
                      label={t("ocrProgressLabel")}
                    />
                  ) : (
                    <div className="flex items-center gap-2 text-xs font-bold text-muted-foreground py-1">
                      <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                      <span>{t("ocrProgressLabel")}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 2 && extractedText && (
            <div className="space-y-4">
              {/* Extracted Sources Summary Collapsible */}
              <div className="rounded-2xl border-[3px] border-border bg-card p-3.5 shadow-[var(--shadow-clay-sm)] transition-all">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="rounded-xl bg-primary/10 p-2 text-primary shrink-0">
                      <FileText className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-foreground font-heading truncate">
                        {t("extractedSummary", {
                          count: files.length,
                          chars: extractedText.length.toLocaleString(),
                        })}
                      </p>
                      {files.length > 0 && (
                        <p className="text-[11px] font-semibold text-muted-foreground truncate">
                          {files.map((f) => f.file.name).join(" • ")}
                        </p>
                      )}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-expanded={previewExpanded}
                    aria-controls="source-text-preview"
                    className="h-8 text-xs font-bold gap-1 px-2.5 rounded-xl border-[2px] border-border/40 hover:bg-muted shrink-0"
                    onClick={() => setPreviewExpanded((prev) => !prev)}
                  >
                    {previewExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                    {previewExpanded ? t("hidePreview") : t("showPreview")}
                  </Button>
                </div>

                {previewExpanded && (
                  <pre
                    id="source-text-preview"
                    className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-muted/60 p-3 text-[11px] font-mono font-medium border-[2px] border-border/40"
                  >
                    {extractedText}
                  </pre>
                )}
              </div>

              {/* Low Density Heuristic Advisory Notice */}
              {isLowDensity && (
                <div className="flex items-start gap-3 rounded-2xl border-[3px] border-amber-500/30 bg-amber-500/10 p-3.5 shadow-[var(--shadow-clay-sm)]">
                  <div className="rounded-xl bg-amber-500/20 p-2 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5">
                    <AlertCircle className="size-4" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="text-xs font-bold font-heading text-amber-950 dark:text-amber-200">
                      {t("lowDensityTitle")}
                    </p>
                    <p className="text-[11px] font-semibold text-amber-900/90 dark:text-amber-300/90 leading-relaxed">
                      {t("lowDensityDesc")}
                    </p>
                  </div>
                </div>
              )}

              {/* Custom Steering Prompt */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="steering-prompt" className="text-xs font-extrabold text-foreground">
                    {t("steeringPromptLabel")}
                  </Label>
                  <span id="steering-prompt-hint" className="text-[11px] font-bold text-muted-foreground bg-muted/60 px-2 py-0.5 rounded-full border border-border/40">
                    {steeringPrompt.length}/500
                  </span>
                </div>
                <Textarea
                  id="steering-prompt"
                  aria-describedby="steering-prompt-hint"
                  value={steeringPrompt}
                  onChange={(e) => setSteeringPrompt(e.target.value)}
                  placeholder={t("steeringPromptPlaceholder")}
                  rows={2}
                  maxLength={500}
                  className="resize-y text-xs font-medium rounded-xl border-[3px] border-border bg-background/50 focus:bg-background focus:border-primary transition-colors"
                />
              </div>

              {/* Controls: Difficulty & Question Type Mix (Equal Height) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 items-stretch">
                {/* Difficulty Selector (Stretches to fill remaining space) */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs font-extrabold text-foreground">
                    {t("difficultyLabel")}
                  </Label>
                  <div role="radiogroup" aria-label={t("difficultyLabel")} className="grid grid-cols-2 gap-2 flex-1">
                    {(
                      [
                        { id: "mixed", label: t("difficultyMixed") },
                        { id: "easy", label: t("difficultyEasy") },
                        { id: "medium", label: t("difficultyMedium") },
                        { id: "hard", label: t("difficultyHard") },
                      ] as const
                    ).map((lvl) => (
                      <button
                        key={lvl.id}
                        type="button"
                        role="radio"
                        aria-checked={difficulty === lvl.id}
                        onClick={() => setDifficulty(lvl.id)}
                        className={`h-full min-h-[46px] rounded-xl border-[3px] py-2 px-2.5 text-[11px] font-extrabold transition-all duration-150 text-center flex items-center justify-center ${
                          difficulty === lvl.id
                            ? "border-primary bg-primary text-primary-foreground shadow-[0_3px_0_var(--primary-deep)]"
                            : "border-border bg-card hover:bg-muted text-foreground shadow-[0_3px_0_var(--border)] hover:-translate-y-0.5 active:translate-y-0"
                        }`}
                      >
                        {lvl.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Question Type Mix */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs font-extrabold text-foreground">
                    {t("typeMixLabel")}
                  </Label>
                  <div role="radiogroup" aria-label={t("typeMixLabel")} className="flex flex-col gap-2 flex-1 justify-between">
                    {(
                      [
                        { id: "mixed", label: t("typeMixBalanced") },
                        { id: "mcq_only", label: t("typeMixAllMcq") },
                        { id: "true_false_only", label: t("typeMixAllTf") },
                      ] as const
                    ).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        role="radio"
                        aria-checked={formatDistribution === m.id}
                        onClick={() => setFormatDistribution(m.id)}
                        className={`flex-1 min-h-[36px] rounded-xl border-[3px] py-1.5 px-3 text-[11px] font-extrabold transition-all duration-150 text-left flex items-center justify-between ${
                          formatDistribution === m.id
                            ? "border-primary bg-primary text-primary-foreground shadow-[0_3px_0_var(--primary-deep)]"
                            : "border-border bg-card hover:bg-muted text-foreground shadow-[0_3px_0_var(--border)] hover:-translate-y-0.5 active:translate-y-0"
                        }`}
                      >
                        <span>{m.label}</span>
                        {formatDistribution === m.id && <Check className="size-3.5 stroke-[3]" />}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Question Count & Language */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 items-end">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="question-count" className="text-xs font-extrabold text-foreground">
                      {t("questionCountLabel")}
                    </Label>
                    <span className="text-[11px] font-extrabold text-primary bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
                      3 – 30
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-label={t("decreaseCount")}
                      onClick={() => {
                        const next = Math.max(3, questionCount - 1);
                        setQuestionCount(next);
                        setQuestionCountInput(String(next));
                      }}
                      disabled={questionCount <= 3}
                      className="size-9 shrink-0 flex items-center justify-center rounded-xl border-[3px] border-border bg-card hover:bg-muted font-bold text-foreground disabled:opacity-40 transition-all shadow-[0_2px_0_var(--border)] active:translate-y-0.5"
                    >
                      <Minus className="size-4" />
                    </button>

                    <Input
                      id="question-count"
                      type="number"
                      min={3}
                      max={30}
                      value={questionCountInput}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setQuestionCountInput(e.target.value)}
                      onBlur={handleQuestionCountBlur}
                      className="rounded-xl border-[3px] font-extrabold text-center h-9 text-sm"
                    />

                    <button
                      type="button"
                      aria-label={t("increaseCount")}
                      onClick={() => {
                        const next = Math.min(30, questionCount + 1);
                        setQuestionCount(next);
                        setQuestionCountInput(String(next));
                      }}
                      disabled={questionCount >= 30}
                      className="size-9 shrink-0 flex items-center justify-center rounded-xl border-[3px] border-border bg-card hover:bg-muted font-bold text-foreground disabled:opacity-40 transition-all shadow-[0_2px_0_var(--border)] active:translate-y-0.5"
                    >
                      <Plus className="size-4" />
                    </button>

                    <div className="flex items-center gap-1 ml-auto">
                      {[5, 10, 20].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => {
                            setQuestionCount(preset);
                            setQuestionCountInput(String(preset));
                          }}
                          className={`px-2.5 py-1 text-[11px] font-extrabold rounded-xl border-[2px] transition-all ${
                            questionCount === preset
                              ? "border-primary bg-primary text-primary-foreground shadow-[0_2px_0_var(--primary-deep)]"
                              : "border-border bg-muted/40 hover:bg-muted text-foreground"
                          }`}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-extrabold text-foreground">
                    {t("langLabel")}
                  </Label>
                  <div role="radiogroup" aria-label={t("langLabel")} className="grid grid-cols-3 gap-1.5">
                    {(
                      [
                        { id: "auto", label: t("langAuto") },
                        { id: "en", label: t("langEn") },
                        { id: "ms", label: t("langMs") },
                      ] as const
                    ).map((lang) => (
                      <button
                        key={lang.id}
                        type="button"
                        role="radio"
                        aria-checked={language === lang.id}
                        onClick={() => setLanguage(lang.id)}
                        className={`h-9 rounded-xl border-[3px] px-1 text-xs font-extrabold transition-all duration-150 text-center flex items-center justify-center ${
                          language === lang.id
                            ? "border-primary bg-primary text-primary-foreground shadow-[0_3px_0_var(--primary-deep)]"
                            : "border-border bg-card hover:bg-muted text-foreground shadow-[0_3px_0_var(--border)] hover:-translate-y-0.5 active:translate-y-0"
                        }`}
                      >
                        {lang.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Append vs Replace Choice */}
              {hasQuestions && (
                <div className="space-y-2 rounded-2xl border-[3px] border-border bg-card p-3.5 shadow-[var(--shadow-clay-sm)]">
                  <Label className="text-xs font-extrabold text-foreground">
                    {t("modeLabel")}
                  </Label>
                  <div role="radiogroup" aria-label={t("modeLabel")} className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={generationMode === "append"}
                      onClick={() => setGenerationMode("append")}
                      className={`rounded-xl border-[3px] py-2.5 px-3.5 text-xs font-extrabold text-left transition-all duration-150 ${
                        generationMode === "append"
                          ? "border-emerald-500 bg-emerald-500/15 text-emerald-950 dark:text-emerald-200 shadow-[0_3px_0_#10b981]"
                          : "border-border bg-card hover:bg-muted/50 text-foreground shadow-[0_3px_0_var(--border)] hover:-translate-y-0.5 active:translate-y-0"
                      }`}
                    >
                      <div className="flex items-center gap-2 font-heading">
                        <PlusCircle className="size-4 text-emerald-600 dark:text-emerald-400" />
                        <span>{t("modeAppendTitle")}</span>
                      </div>
                      <p className="text-[11px] font-semibold text-muted-foreground mt-1">
                        {t("modeAppendDesc")}
                      </p>
                    </button>

                    <button
                      type="button"
                      role="radio"
                      aria-checked={generationMode === "replace"}
                      onClick={() => setGenerationMode("replace")}
                      className={`rounded-xl border-[3px] py-2.5 px-3.5 text-xs font-extrabold text-left transition-all duration-150 ${
                        generationMode === "replace"
                          ? "border-amber-500 bg-amber-500/15 text-amber-950 dark:text-amber-200 shadow-[0_3px_0_#f59e0b]"
                          : "border-border bg-card hover:bg-muted/50 text-foreground shadow-[0_3px_0_var(--border)] hover:-translate-y-0.5 active:translate-y-0"
                      }`}
                    >
                      <div className="flex items-center gap-2 font-heading">
                        <RefreshCw className="size-4 text-amber-600 dark:text-amber-400" />
                        <span>{t("modeReplaceTitle")}</span>
                      </div>
                      <p className="text-[11px] font-semibold text-muted-foreground mt-1">
                        {t("modeReplaceDesc")}
                      </p>
                    </button>
                  </div>

                  {generationMode === "replace" && (
                    <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-700 dark:text-amber-400 bg-amber-500/10 px-3 py-1.5 rounded-xl border border-amber-500/30">
                      <AlertTriangle className="size-3.5 shrink-0" />
                      <span>{t("modeReplaceWarning")}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {busy && step === 2 && (
          <div className="flex shrink-0 items-center justify-center gap-2.5 rounded-2xl border-[3px] border-primary/30 bg-primary/5 px-4 py-3">
            <BotAvatar state="thinking" size={32} />
            <span className="text-sm font-extrabold text-primary">
              {t("generatingBtn")}
            </span>
          </div>
        )}

        <DialogFooter className="shrink-0 pt-3 border-t-[3px] border-border/40 flex items-center justify-between sm:justify-between gap-3">
          {step === 1 ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={busy}
                className="font-bold rounded-xl"
              >
                {tCommon("cancel")}
              </Button>
              <Button
                type="button"
                onClick={handleExtractAll}
                disabled={files.length === 0 || busy}
                className="font-bold rounded-xl gap-2"
              >
                {busy ? tCommon("loading") : (
                  <>
                    <span>{t("extractAndContinue")}</span>
                    <ArrowRight className="size-4" />
                  </>
                )}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep(1)}
                disabled={busy}
                className="font-bold rounded-xl gap-1.5"
              >
                <ArrowLeft className="size-4" />
                <span>{t("backToFiles")}</span>
              </Button>
              <Button
                type="button"
                onClick={handleGenerate}
                disabled={busy}
                className="font-bold rounded-xl gap-2 bg-primary text-primary-foreground shadow-[var(--shadow-clay-sm)]"
              >
                {busy ? (
                  <>
                    <span className="size-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                    <span>{t("generatingBtn")}</span>
                  </>
                ) : (
                  <>
                    <Wand2 className="size-4" />
                    <span>{generationMode === "append" ? t("appendBtn") : t("generateBtn")}</span>
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
