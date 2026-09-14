"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  Globe,
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
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { UploadDropzone, type UploadedFileItem } from "./UploadDropzone";
import { EnginePicker } from "./EnginePicker";
import { OcrProgress } from "./OcrProgress";
import { GenerationProgress } from "./GenerationProgress";
import { BotAvatar } from "@/components/bot/bot-avatar";
import { runExtractionPipeline, type PipelineProgress } from "@/lib/extract/pipeline";
import { MAX_AGGREGATE_CHARS } from "@/lib/extract/types";
import type { ExtractEngine, OcrConfig } from "@/lib/extract/types";
import type {
  QuizDifficulty,
  QuestionFormatDistribution,
  QuizGenerationMode,
} from "@/lib/ai/validation";

const CLIENT_TIMEOUT_MS = 20 * 60_000;

/**
 * Per-file extraction outcome (audit-3 F-F5). The dialog previously rendered
 * "{files.length} files ready" using the UPLOADED count, so a scanned/empty
 * file that contributed nothing still counted as a source. Outcomes let the
 * summary report only files that actually produced text, name the ones that
 * were skipped and why, and re-run just the failed subset (F-F2).
 */
type FileOutcome = {
  path: string;
  name: string;
  /** 1-based position in the uploaded list — keeps SOURCE headers stable. */
  index: number;
  /** Trimmed extracted text ("" when the file contributed nothing). */
  text: string;
  /**
   * audit-3 F-F2: per-page text when the engine reports it (GLM). Lets a
   * retry re-OCR only the failed pages and splice them back into position.
   */
  pageTexts?: string[];
  /** Full page count of the file (the density denominator across retries). */
  totalPages: number;
  /** 1-based pages that produced nothing, as of the latest attempt. */
  failedPages: number[];
  /** audit-3 F-F2/F-F10: failed pages rejected by the OCR rate limit. */
  rateLimitedPages: number;
  /** Engine's own density/partial flag (feeds the low-density advisory). */
  lowConfidence: boolean;
  /** Why this file contributed no text at all (audit-3 F-F5). */
  skippedReason?: "empty";
};

/** The text an outcome contributes: per-page parts when available, else the
 * engine's combined text. */
function outcomeText(o: FileOutcome): string {
  if (o.pageTexts) return o.pageTexts.filter((t) => t.trim()).join("\n\n").trim();
  return o.text.trim();
}

/** Render the combined corpus from the outcomes that produced text. */
function combineOutcomes(outcomes: FileOutcome[], fileCount: number): string {
  return outcomes
    .map((o) => ({ o, text: outcomeText(o) }))
    .filter(({ text }) => text.length > 0)
    .map(({ o, text }) =>
      fileCount > 1 ? `=== SOURCE [${o.index}/${fileCount}]: ${o.name} ===\n${text}` : text,
    )
    .join("\n\n");
}

/**
 * AI generation from uploaded/pasted material. Two modes share this dialog:
 *  - "lecturer" (default): posts to /api/ai/generate-quiz with the full
 *    control set and refreshes the server components on success.
 *  - "student": posts to the practice-quiz endpoint passed via `endpoint`,
 *    HIDES steering/format-mix/mode controls (plan F1), and reports the
 *    generated questions through `onGenerated` so the editor can merge them
 *    locally (the practice editor owns its state; no router.refresh needed).
 */
export function GenerateFromFileDialog({
  quizId,
  userId,
  config,
  open,
  onOpenChange,
  hasQuestions,
  mode = "lecturer",
  endpoint,
  onGenerated,
  hasWebSearch = false,
}: {
  quizId: string;
  userId: string;
  config: OcrConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasQuestions: boolean;
  /** Which surface is generating — controls visibility + body shape. */
  mode?: "lecturer" | "student";
  /** Override of the POST target (student surface passes its own route). */
  endpoint?: string;
  /** Student mode only: receives `{questions}` rows on success (+ cap info). */
  onGenerated?: (questions: unknown[], info: { capped: boolean }) => void;
  /** TinyFish flag (server env) — gates the "Web topic" source mode. */
  hasWebSearch?: boolean;
}) {
  const isStudent = mode === "student";
  const target = endpoint ?? "/api/ai/generate-quiz";
  const router = useRouter();
  const t = useTranslations("extract");
  const tCommon = useTranslations("common");

  const [step, setStep] = useState<1 | 2>(1);
  const stepContainerRef = useRef<HTMLDivElement>(null);

  // Lecturer in-dialog generation (Phase 3 pattern adopted for lecturers):
  // submit flips step 2 into the generating view (status strip + Thinking
  // accordion) INSTEAD of navigating to the retired /generating console
  // route. `genRunId` keys the stream engine — bump it for "Try again".
  const [generating, setGenerating] = useState(false);
  const [genRunId, setGenRunId] = useState(0);

  // Source-mode chooser (grounded-search.md §6): "material" = the classic
  // upload/paste flow; "web" = grounded topic search (lecturer + flag only).
  // Material-mode augmentation: optionally add fresh web knowledge on top of
  // the uploaded/pasted material (`webFocusHint` steers the search queries;
  // empty → queries derive from the material text).
  const [webAugment, setWebAugment] = useState(false);
  const [webFocusHint, setWebFocusHint] = useState("");

  const [files, setFiles] = useState<UploadedFileItem[]>([]);
  const [pastedText, setPastedText] = useState("");
  const [inputMode, setInputMode] = useState<"file" | "text">("file");
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
  // audit-2 M-17: "N of M pages failed" advisory state (all file types).
  const [partialPages, setPartialPages] = useState<{ failed: number; attempted: number } | null>(null);
  // audit-3 F-F2: the rate-limited subset of the failures — names the cause
  // and drives the retry affordance.
  const [rateLimitedPages, setRateLimitedPages] = useState<number | null>(null);
  // audit-3 F-F5: which uploaded files actually contributed text, and why the
  // others were skipped. Drives an honest "{contributing} of {uploaded} files"
  // summary instead of counting uploads as sources.
  const [outcomes, setOutcomes] = useState<FileOutcome[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(false);
  const activeAbortRef = useRef<AbortController | null>(null);
  // audit-1 P1-10: stable per-RUN idempotency id. Created at the FIRST
  // submit of a run, REUSED across Try-again retries, cleared only when a
  // run definitively succeeds — so a retry after a post-commit abort
  // dedupes server-side instead of duplicating the append.
  const generationIdRef = useRef<string | null>(null);

  function reset() {
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
    setStep(1);
    setInputMode("file");
    setFiles([]);
    setPastedText("");
    setWebAugment(false);
    setWebFocusHint("");
    setExtractedText(null);
    setIsLowDensity(false);
    setProgress(null);
    setCurrentExtractingFile(null);
    setError(null);
    setSteeringPrompt("");
    setDifficulty("mixed");
    setFormatDistribution("mixed");
    setGenerationMode("replace");
    setPreviewExpanded(false);
    setQuestionCount(10);
    setQuestionCountInput("10");
    setGenerating(false);
    setGenRunId(0);
    submitLock.current = false;
    setBusy(false);
  }

  // Close-path reset happens in the ResponsiveModal's onOpenChange (reset() there);
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
    setOutcomes([]);
    setPartialPages(null);
    setRateLimitedPages(null);
  }

  /** Extract one uploaded file into a FileOutcome (never throws for a single
   * file's low-confidence result — that is reported, not fatal). */
  async function extractOne(
    item: UploadedFileItem,
    index: number,
    signal: AbortSignal,
    onProgress?: (p: PipelineProgress) => void,
    retry?: { pages: number[]; previous: FileOutcome },
  ): Promise<FileOutcome> {
    const result = await runExtractionPipeline({
      file: item.file,
      engine,
      config,
      onProgress,
      signal,
      ...(retry ? { pagesToRetry: retry.pages } : {}),
    });
    const attempted = result.pagesAttempted ?? (result.pages || 1);
    const text = result.text ?? "";
    const totalPages = result.totalPages ?? Math.max(attempted, 1);
    return {
      path: item.path,
      name: item.file.name,
      index,
      text,
      ...(result.pageTexts ? { pageTexts: result.pageTexts } : {}),
      totalPages,
      failedPages: result.failedPages ?? [],
      rateLimitedPages: result.rateLimitedPages?.length ?? 0,
      lowConfidence: result.lowConfidence === true,
      // A retry keeps the file's "contributed" status from its earlier
      // attempt — only the failed pages were re-run, so an all-failed retry
      // must not erase pages that succeeded before.
      ...(text.trim() || retry?.previous.text.trim() ? {} : { skippedReason: "empty" as const }),
    };
  }

  /**
   * Extract files and fold the outcomes into the dialog's derived state.
   * `onlyPaths` re-runs just the failed subset for the F-F2 retry affordance;
   * omitted, it runs every uploaded file.
   */
  async function handleExtractAll(onlyPaths?: string[]) {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setError(null);

    const controller = new AbortController();
    activeAbortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

    try {
      const priorOutcomes = outcomes;
      const retarget = onlyPaths && onlyPaths.length > 0;
      const priorByPath = new Map(priorOutcomes.map((o) => [o.path, o]));
      const targets = files
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => (retarget ? onlyPaths!.includes(item.path) : true));

      const produced: FileOutcome[] = [];
      // Density heuristic keys on the whole batch, not just the retried
      // subset (a retry of one failed PDF must not disable it).
      const hasOfficeFiles = files.some((f) => /\.(pptx|docx)$/i.test(f.file.name));
      for (const { item, index } of targets) {
        if (controller.signal.aborted) return;

        setCurrentExtractingFile(`${item.file.name} (${index + 1}/${files.length})`);
        const previous = priorByPath.get(item.path);
        const retryPages =
          retarget && previous && previous.failedPages.length > 0
            ? previous.failedPages
            : undefined;
        const fresh = await extractOne(
          item,
          index,
          controller.signal,
          (p) => setProgress(p),
          retryPages && previous ? { pages: retryPages, previous } : undefined,
        );
        // Splice retried pages back into the prior per-page corpus so the
        // recovered text lands in its original position (F-F2).
        if (retryPages && previous?.pageTexts) {
          const merged = [...previous.pageTexts];
          fresh.pageTexts?.forEach((t, i) => {
            if (t.trim()) merged[i] = t;
          });
          produced.push({
            ...fresh,
            pageTexts: merged,
            text: merged.filter((t) => t.trim()).join("\n\n").trim(),
            // Recovered pages drop out of the failure set.
            failedPages: fresh.failedPages.filter((p) => !retryPages.includes(p)),
          });
        } else {
          produced.push(fresh);
        }
      }

      // Merge: a retry replaces only the re-run files; everything else keeps
      // its prior outcome (F-F2 — the user retries the lost pages, not the
      // whole batch).
      const byPath = new Map(priorOutcomes.map((o) => [o.path, o]));
      for (const outcome of produced) byPath.set(outcome.path, outcome);
      const merged = retarget
        ? files
            .map((item) => byPath.get(item.path))
            .filter((o): o is FileOutcome => o !== undefined)
        : produced;
      const finalOutcomes = merged.length > 0 ? merged : produced;
      setOutcomes(finalOutcomes);

      const combinedText = combineOutcomes(finalOutcomes, files.length);
      if (!combinedText.trim()) {
        throw new Error(t("emptyTextError"));
      }

      const totalAttemptedPages = finalOutcomes.reduce((n, o) => n + o.totalPages, 0);
      const totalFailedPages = finalOutcomes.reduce((n, o) => n + o.failedPages.length, 0);
      const totalRateLimitedPages = finalOutcomes.reduce((n, o) => n + o.rateLimitedPages, 0);
      const hasLowConfidence = finalOutcomes.some((o) => o.lowConfidence);

      const words = combinedText.trim().split(/\s+/).filter(Boolean).length;
      const avgWordsPerPage = totalAttemptedPages > 0 ? Math.round(words / totalAttemptedPages) : 0;
      const avgCharsPerPage = totalAttemptedPages > 0 ? Math.round(combinedText.length / totalAttemptedPages) : 0;

      // Heuristic: Flag presentation/office decks where text density is suspiciously low (<12 words or <50 chars per page)
      const lowDensityDetected = hasOfficeFiles && (hasLowConfidence || avgWordsPerPage < 12 || avgCharsPerPage < 50);
      setIsLowDensity(lowDensityDetected);

      // audit-2 M-17: surface partial-OCR loss for ALL file types (the old
      // low-density advisory only ever fired for .pptx/.docx) — a 10-page
      // scan with one 504'd page read as success and shipped an incomplete
      // assessment. audit-3 F-F2: the rate-limited subset is broken out so
      // the advisory can name the cause and offer a retry.
      if (totalFailedPages > 0 && totalAttemptedPages > 0) {
        setPartialPages({ failed: totalFailedPages, attempted: totalAttemptedPages });
        setRateLimitedPages(totalRateLimitedPages > 0 ? totalRateLimitedPages : null);
      } else {
        setPartialPages(null);
        setRateLimitedPages(null);
      }

      setExtractedText(combinedText);
      setStep(2);
    } catch (err) {
      if (controller.signal.aborted) return;
      const aborted = err instanceof Error && err.name === "AbortError";
      const msg = err instanceof Error ? err.message : "";
      if (aborted) {
        setError(t("timeout"));
      } else if (msg === "glm_rate_limited") {
        setError(t("glmRateLimited"));
      } else if (msg === "glm_busy") {
        setError(t("glmBusy"));
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

  /** audit-3 F-F2: re-run only the files whose OCR pages failed (rate limit
   * or otherwise), then fold the fresh outcomes back into the corpus. */
  function handleRetryFailedFiles() {
    const failedPaths = outcomes
      .filter((o) => o.failedPages.length > 0 || o.skippedReason === "empty")
      .map((o) => o.path);
    if (failedPaths.length === 0) return;
    void handleExtractAll(failedPaths);
  }

  /** Files that produced no text at all (audit-3 F-F5). */
  const skippedFiles = outcomes.filter((o) => !outcomeText(o));
  /** Files that actually contributed to the corpus. */
  const contributingCount = outcomes.filter((o) => outcomeText(o)).length;
  /** Storage paths of the contributing files — the only honest provenance. */
  const contributingPaths = useMemo(
    () => outcomes.filter((o) => outcomeText(o)).map((o) => o.path),
    [outcomes],
  );

  async function handleGenerate() {
    if (!extractedText || submitLock.current || busy) return;
    submitLock.current = true;
    setBusy(true);
    setError(null);

    // Lecturer surface: step 2 morphs into the generating view IN PLACE —
    // the status strip + Thinking accordion own the POST, the event stream,
    // and the outcome (the /generating console route is retired). Closing
    // the dialog mid-run aborts the stream (truthful: nothing keeps running
    // hidden); a terminal error keeps the trace and offers Try again.
    // Web mode submits from step 1 (no extraction step) — advance to step 2
    // so the generating view's render gate (`step === 2`) fires.
    if (!isStudent) {
      setGenerating(true);
      setGenRunId((n) => n + 1);
      return;
    }

    const controller = new AbortController();
    activeAbortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

    if (!generationIdRef.current) generationIdRef.current = crypto.randomUUID();

    try {
      // Student-only legacy path: the lecturer surface returned above (its
      // body lives in generationBody for the NDJSON stream).
      const bodyPayload = {
        extractedText,
        questionCount,
        difficulty,
        language,
        // Omit when empty — an explicit [] would trip the schema's min(1).
        // audit-3 F-F5: provenance is the CONTRIBUTING subset only.
        ...(contributingPaths.length > 0 ? { sourcePaths: contributingPaths } : {}),
        // audit-1 P1-10: reused across retries; cleared on success below.
        generationId: generationIdRef.current,
      };

      const res = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        // Student surface: map known error CODES to localized strings (the
        // raw server messages are English-only); unknown codes fall back to
        // the server message, then the generic.
        const codeMap: Record<string, string> = {
          question_cap_reached: t("errQuestionCap"),
          rate_limited: t("errRateLimited"),
          invalid_ai_output: t("errInvalidAi"),
          ai_unavailable: t("errInvalidAi"),
        };
        setError(codeMap[body.error as string] ?? body.message ?? tCommon("errorGeneric"));
        return;
      }

      if (isStudent && onGenerated) {
        onGenerated(Array.isArray(body.questions) ? body.questions : [], {
          capped: Boolean(body.capped),
        });
      } else {
        toast.success(t("questionsGenerated"));
        router.refresh();
      }
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

  /** Body for the lecturer NDJSON stream — built at submit AND at retry, so
   * a "Try again" regenerates byte-identical request config from state.
   * extractedText is clamped to the 400k aggregate cap (the old sessionStorage
   * handoff's rule): the server schema REJECTS over-cap text, so five
   * text-heavy decks must be truncated client-side to keep the old
   * generate-from-first-400k outcome instead of a validation error.
   * Web mode OMITS extractedText/sourcePaths entirely (empty string ≠ absent
   * to the XOR validation — critique finding 6). */
  const generationBody = useMemo(
    () => ({
      quizId,
      extractedText: (extractedText ?? "").slice(0, MAX_AGGREGATE_CHARS),
      questionCount,
      mode: generationMode,
      difficulty,
      formatDistribution,
      steeringPrompt: steeringPrompt.trim() || undefined,
      language,
      // Web-augmentation pair: on, the focus hint (or the material text
      // itself, server-side) steers the web lookup. The route appends fresh
      // web pages to the material corpus and degrades to material-only when
      // the search finds nothing / is unconfigured.
      ...(webAugment
        ? {
            useWebSearch: true,
            topic:
              webFocusHint.trim().slice(0, 500) ||
              (extractedText ?? "").trim().slice(0, 120),
          }
        : {}),
      // Omit when empty — an explicit [] would trip the schema's min(1) on
      // the paste-only path. audit-3 F-F5/F-F11: only files that ACTUALLY
      // contributed text are forwarded as provenance, so a scanned/empty file
      // (or a stale upload from the other input mode) cannot mint a chip for
      // text the model never saw.
      ...(contributingPaths.length > 0 ? { sourcePaths: contributingPaths } : {}),
    }),
    [webAugment, webFocusHint, quizId, extractedText, questionCount, generationMode, difficulty, formatDistribution, steeringPrompt, language, contributingPaths],
  );

  /** Terminal outcomes from the in-dialog stream, reported at EVENT time:
   * done/saved_refresh_failed mean the save is already committed — refresh
   * the builder NOW (never at CTA click; the plan's merge-at-done rule) and
   * reset. error/cancelled keep the dialog open (trace + Try again). */
  function handleGenerationOutcome(kind: string) {
    if (kind === "done" || kind === "saved_refresh_failed") {
      // Success: retire the run's idempotency id — a deliberate NEXT
      // generation must mint a fresh one (intended appends stay intended).
      generationIdRef.current = null;
      toast.success(t("questionsGenerated"));
      router.refresh();
      submitLock.current = false;
      setBusy(false);
      return;
    }
    // error / cancelled: the strip keeps the trace + offers Try again
    // (already_running shows its distinct no-retry state). Release the
    // submit lock so a retry can fire; keep the dialog open.
    submitLock.current = false;
    setBusy(false);
  }

  function handleGenerationRetry() {
    setGenRunId((n) => n + 1);
    setBusy(true);
    submitLock.current = true;
  }

  function handleQuestionCountBlur() {
    const val = Number(questionCountInput);
    const clamped = isNaN(val) ? 10 : Math.max(3, Math.min(30, val));
    setQuestionCount(clamped);
    setQuestionCountInput(String(clamped));
  }

  return (
    <ResponsiveModal
      open={open}
      mobileSurface="sheet"
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <ResponsiveModalContent className="h-auto max-h-[92dvh] sm:max-h-[94vh] flex flex-col sm:max-w-3xl overflow-hidden p-4 sm:p-7 gap-0">
        <ResponsiveModalHeader className="shrink-0 pb-3 border-b-[3px] border-border/40">
          <div className="flex items-center justify-between gap-2 sm:pr-6">
            <ResponsiveModalTitle className="text-lg sm:text-xl font-bold font-heading flex items-center gap-2">
              <Sparkles className="size-5 text-primary shrink-0" />
              <span>{t("dialogTitle")}</span>
            </ResponsiveModalTitle>
            <span className="rounded-full border-[2px] border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-extrabold text-primary shrink-0">
              {generating ? t("generatingBtn") : t("stepIndicator", { step, total: 2 })}
            </span>
          </div>
          <ResponsiveModalDescription className="text-xs font-semibold text-muted-foreground mt-0.5">
            {step === 1 ? t("dialogSubtitle") : t("step2Title")}
          </ResponsiveModalDescription>
        </ResponsiveModalHeader>

        <div
          ref={stepContainerRef}
          tabIndex={-1}
          className="flex-1 overflow-y-auto space-y-4 py-4 pr-1 outline-none overscroll-contain"
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
          </div>

          {step === 1 && (
            <div className="space-y-3.5">
              {inputMode === "file" ? (
                <div className="space-y-3">
                  <UploadDropzone
                    userId={userId}
                    quizId={quizId}
                    files={files}
                    onFilesChanged={handleFilesChanged}
                    onError={setError}
                    disabled={busy}
                  />

                  {/* Subtle inline switch to paste notes instead */}
                  <div className="flex items-center justify-center gap-2 py-0.5">
                    <span className="h-[1px] w-12 bg-border/60" />
                    <span className="text-2xs font-bold text-muted-foreground uppercase tracking-wider">
                      {t("orDivider")}
                    </span>
                    <span className="h-[1px] w-12 bg-border/60" />
                    <button
                      type="button"
                      onClick={() => {
                        setInputMode("text");
                        // audit-3 F-F11: the file leg is not the source in
                        // paste mode. Keeping the uploads made the step-2
                        // provenance chips and the "{count} files ready"
                        // summary reference text that was never used — clear
                        // the stale file state so provenance cannot lie.
                        setFiles([]);
                        setOutcomes([]);
                        setExtractedText(null);
                        setPartialPages(null);
                        setRateLimitedPages(null);
                        setIsLowDensity(false);
                        setError(null);
                      }}
                      className="hit-slop inline-flex items-center gap-1.5 text-xs font-bold text-primary hover:underline hover:text-primary-deep transition-colors ml-1"
                    >
                      <FileText className="size-3.5" />
                      <span>{t("pasteNotesInstead")}</span>
                    </button>
                  </div>

                  <EnginePicker
                    value={engine}
                    onChange={setEngine}
                    files={files}
                    disabled={busy}
                  />
                </div>
              ) : (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => {
                        setInputMode("file");
                        setError(null);
                      }}
                      className="hit-slop inline-flex items-center gap-1.5 text-xs font-bold text-primary hover:underline"
                    >
                      <ArrowLeft className="size-3.5" />
                      <span>{t("backToFileUpload")}</span>
                    </button>
                    <span className="text-2xs font-bold text-muted-foreground">
                      {pastedText.length.toLocaleString()} / 400,000
                    </span>
                  </div>

                  <div className="space-y-2 rounded-2xl border-[3px] border-border bg-card p-3.5 shadow-[var(--shadow-clay-sm)]">
                    <Label htmlFor="paste-source" className="text-xs font-extrabold text-foreground font-heading">
                      {t("pasteLabel")}
                    </Label>
                    <Textarea
                      id="paste-source"
                      value={pastedText}
                      onChange={(e) => setPastedText(e.target.value)}
                      placeholder={t("pastePlaceholder")}
                      rows={6}
                      maxLength={400000}
                      disabled={busy}
                      className="resize-y text-xs font-medium rounded-xl border-[3px] border-border bg-background/50 focus:bg-background focus:border-primary transition-colors min-h-[150px]"
                    />
                    <p className="text-2xs font-semibold text-muted-foreground leading-relaxed">
                      {t("pasteHint")}
                    </p>
                  </div>
                </div>
              )}

              {/* Web-augmentation focus-hint card (replaces the removed
                  topic-only card): shown on step 1 when the toggle is on so
                  the lecturer can steer the lookup BEFORE extraction. */}
              {!isStudent && hasWebSearch && webAugment && (
                <div className="space-y-2 rounded-2xl border-[3px] border-border bg-card p-3.5 shadow-[var(--shadow-clay-sm)]">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="web-focus-hint-step1" className="text-xs font-extrabold text-foreground">
                      {t("webFocusHintLabel")}
                    </Label>
                  </div>
                  <Input
                    id="web-focus-hint-step1"
                    value={webFocusHint}
                    onChange={(e) => setWebFocusHint(e.target.value)}
                    placeholder={t("webFocusHintPlaceholder")}
                    maxLength={500}
                    disabled={busy}
                    data-testid="web-focus-hint"
                    className="rounded-xl border-[3px] border-border bg-background/50 focus:bg-background focus:border-primary transition-colors text-sm font-semibold"
                  />
                  <div className="flex items-start gap-2 rounded-xl border border-border/40 bg-muted/40 px-3 py-2">
                    <Globe className="size-3.5 shrink-0 text-primary mt-0.5" aria-hidden="true" />
                    <p className="text-2xs font-semibold text-muted-foreground leading-relaxed">
                      {t("webAugmentNote")}
                    </p>
                  </div>
                </div>
              )}

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

          {step === 2 && extractedText && generating && (
            <GenerationProgress
              key={genRunId}
              endpoint="/api/ai/generate-quiz"
              body={generationBody}
              onOutcome={handleGenerationOutcome}
              onRetry={handleGenerationRetry}
              onReview={() => {
                // Terminal success path already refreshed + reset via
                // handleGenerationOutcome; this closes the dialog shell.
                onOpenChange(false);
              }}
            />
          )}

          {step === 2 && extractedText && !generating && (
            <div className="space-y-4">
              {/* Web mode has no extracted-text summary card — the topic is
                  the source; everything below applies to both modes. */}
              {extractedText && (
              <div className="rounded-2xl border-[3px] border-border bg-card p-3.5 shadow-[var(--shadow-clay-sm)] transition-[border-color,background-color,box-shadow]">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="rounded-xl bg-primary/10 p-2 text-primary shrink-0">
                      <FileText className="size-4" />
                    </div>
                    <div className="min-w-0">
                      {/* audit-3 F-F5: report files that CONTRIBUTED, not files
                          that were uploaded. A scanned/empty upload contributes
                          no text and must not be counted as a source. */}
                      <p className="text-xs font-bold text-foreground font-heading truncate">
                        {contributingCount === files.length
                          ? t("extractedSummary", {
                              count: contributingCount,
                              chars: extractedText.length.toLocaleString(),
                            })
                          : t("extractedSummaryPartial", {
                              contributing: contributingCount,
                              total: files.length,
                              chars: extractedText.length.toLocaleString(),
                            })}
                      </p>
                      {files.length > 0 && (
                        <p className="text-2xs font-semibold text-muted-foreground truncate">
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
                    className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-muted/60 p-3 text-2xs font-mono font-medium border-[2px] border-border/40"
                  >
                    {extractedText}
                  </pre>
                )}
              </div>
              )}

              {/* audit-3 F-F5: files that contributed nothing are named
                  explicitly — silence about a dropped upload is what let the
                  old summary claim sources the model never saw. */}
              {skippedFiles.length > 0 && (
                <div className="flex items-start gap-3 rounded-2xl border-[3px] border-amber-500/30 bg-amber-500/10 p-3.5 shadow-[var(--shadow-clay-sm)]">
                  <div className="rounded-xl bg-amber-500/20 p-2 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5">
                    <AlertTriangle className="size-4" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="text-xs font-bold font-heading text-amber-950 dark:text-amber-200">
                      {t("skippedFilesTitle")}
                    </p>
                    <p className="text-2xs font-semibold text-amber-900/90 dark:text-amber-300/90 leading-relaxed">
                      {t("skippedFilesDesc", {
                        files: skippedFiles.map((o) => o.name).join(", "),
                      })}
                    </p>
                  </div>
                </div>
              )}

              {/* audit-2 M-17: partial-OCR warning — fires for EVERY file
                  type when any page of a multi-page extraction failed, not
                  just office decks with low text density.
                  audit-3 F-F2: when the loss was caused by the OCR budget
                  (429), name the cause and offer a retry for just the failed
                  files instead of a generic "some pages failed". */}
              {partialPages && (
                <div className="flex items-start gap-3 rounded-2xl border-[3px] border-amber-500/30 bg-amber-500/10 p-3.5 shadow-[var(--shadow-clay-sm)]">
                  <div className="rounded-xl bg-amber-500/20 p-2 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5">
                    <AlertCircle className="size-4" />
                  </div>
                  <div className="min-w-0 space-y-1.5 flex-1">
                    <p className="text-xs font-bold font-heading text-amber-950 dark:text-amber-200">
                      {t("partialPagesTitle")}
                    </p>
                    <p className="text-2xs font-semibold text-amber-900/90 dark:text-amber-300/90 leading-relaxed">
                      {t("partialPagesDesc", { failed: partialPages.failed, attempted: partialPages.attempted })}
                    </p>
                    {rateLimitedPages !== null && (
                      <p className="text-2xs font-semibold text-amber-900/90 dark:text-amber-300/90 leading-relaxed">
                        {t("partialPagesRateLimitedDesc", { count: rateLimitedPages })}
                      </p>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleRetryFailedFiles()}
                      disabled={busy}
                      className="h-8 gap-1.5 rounded-xl border-[2px] border-amber-500/50 bg-card px-3 text-2xs font-extrabold text-amber-900 hover:bg-amber-500/10 dark:text-amber-200"
                    >
                      <RefreshCw className="size-3.5" />
                      {t("retryFailedPages")}
                    </Button>
                  </div>
                </div>
              )}

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
                    <p className="text-2xs font-semibold text-amber-900/90 dark:text-amber-300/90 leading-relaxed">
                      {t("lowDensityDesc")}
                    </p>
                  </div>
                </div>
              )}

              {/* Web-knowledge augmentation (lecturer + flag only): optionally
                  ground the generation in BOTH the material above AND fresh
                  web pages — real-world updates the uploads may not have. A
                  failed search degrades to material-only, never an error. */}
              {!isStudent && hasWebSearch && (
                <div className="space-y-2 rounded-2xl border-[3px] border-border bg-card p-3.5 shadow-[var(--shadow-clay-sm)]">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={webAugment}
                      onChange={(e) => {
                        setWebAugment(e.target.checked);
                        if (!e.target.checked) setWebFocusHint("");
                      }}
                      disabled={busy}
                      data-testid="web-augment-toggle"
                      className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-xs font-extrabold text-foreground font-heading">
                        <Globe className="size-3.5 text-primary" aria-hidden="true" />
                        {t("webAugmentLabel")}
                      </span>
                      <span className="mt-0.5 block text-2xs font-semibold text-muted-foreground leading-relaxed">
                        {t("webAugmentDesc")}
                      </span>
                    </span>
                  </label>
                  {webAugment && (
                    <div className="space-y-1.5 pl-7">
                      <Label htmlFor="web-focus-hint" className="text-2xs font-extrabold text-muted-foreground">
                        {t("webFocusHintLabel")}
                      </Label>
                      <Input
                        id="web-focus-hint"
                        value={webFocusHint}
                        onChange={(e) => setWebFocusHint(e.target.value)}
                        placeholder={t("webFocusHintPlaceholder")}
                        maxLength={500}
                        disabled={busy}
                        data-testid="web-focus-hint"
                        className="rounded-xl border-[3px] border-border bg-background/50 focus:bg-background focus:border-primary transition-colors text-xs font-semibold h-9"
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Custom Steering Prompt (lecturer surface only) */}
              {!isStudent && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="steering-prompt" className="text-xs font-extrabold text-foreground">
                    {t("steeringPromptLabel")}
                  </Label>
                  <span id="steering-prompt-hint" className="text-2xs font-bold text-muted-foreground bg-muted/60 px-2 py-0.5 rounded-full border border-border/40">
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
              )}

              {/* Controls: Difficulty & Question Type Mix (Equal Height) */}
              <div className={`grid grid-cols-1 gap-3.5 items-stretch ${isStudent ? "" : "sm:grid-cols-2"}`}>
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
                        className={`h-full min-h-[46px] rounded-xl border-[3px] py-2 px-2.5 text-2xs font-extrabold transition-[border-color,background-color,box-shadow,transform] duration-150 text-center flex items-center justify-center ${
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

                {/* Question Type Mix (lecturer surface only) */}
                {!isStudent && (
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
                        className={`flex-1 min-h-[36px] rounded-xl border-[3px] py-1.5 px-3 text-2xs font-extrabold transition-[border-color,background-color,box-shadow,transform] duration-150 text-left flex items-center justify-between ${
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
                )}
              </div>

              {/* Question Count & Language */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 items-end">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="question-count" className="text-xs font-extrabold text-foreground">
                      {t("questionCountLabel")}
                    </Label>
                    <span className="text-2xs font-extrabold text-primary bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
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
                      className="size-9 shrink-0 flex items-center justify-center rounded-xl border-[3px] border-border bg-card hover:bg-muted font-bold text-foreground disabled:opacity-40 transition-[box-shadow,transform] shadow-[0_2px_0_var(--border)] active:translate-y-0.5"
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
                      className="size-9 shrink-0 flex items-center justify-center rounded-xl border-[3px] border-border bg-card hover:bg-muted font-bold text-foreground disabled:opacity-40 transition-[box-shadow,transform] shadow-[0_2px_0_var(--border)] active:translate-y-0.5"
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
                          className={`px-2.5 py-1 text-2xs font-extrabold rounded-xl border-[2px] transition-[border-color,background-color,box-shadow] ${
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
                        className={`h-9 rounded-xl border-[3px] px-1 text-xs font-extrabold transition-[border-color,background-color,box-shadow] duration-150 text-center flex items-center justify-center ${
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

              {/* Append vs Replace Choice (lecturer surface only — the
                  practice route seeds-or-appends server-side) */}
              {!isStudent && hasQuestions && (
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
                      className={`rounded-xl border-[3px] py-2.5 px-3.5 text-xs font-extrabold text-left transition-[border-color,background-color,box-shadow,transform] duration-150 ${
                        generationMode === "append"
                          ? "border-emerald-500 bg-emerald-500/15 text-emerald-950 dark:text-emerald-200 shadow-[0_3px_0_#10b981]"
                          : "border-border bg-card hover:bg-muted/50 text-foreground shadow-[0_3px_0_var(--border)] hover:-translate-y-0.5 active:translate-y-0"
                      }`}
                    >
                      <div className="flex items-center gap-2 font-heading">
                        <PlusCircle className="size-4 text-emerald-600 dark:text-emerald-400" />
                        <span>{t("modeAppendTitle")}</span>
                      </div>
                      <p className="text-2xs font-semibold text-muted-foreground mt-1">
                        {t("modeAppendDesc")}
                      </p>
                    </button>

                    <button
                      type="button"
                      role="radio"
                      aria-checked={generationMode === "replace"}
                      onClick={() => setGenerationMode("replace")}
                      className={`rounded-xl border-[3px] py-2.5 px-3.5 text-xs font-extrabold text-left transition-[border-color,background-color,box-shadow,transform] duration-150 ${
                        generationMode === "replace"
                          ? "border-amber-500 bg-amber-500/15 text-amber-950 dark:text-amber-200 shadow-[0_3px_0_#f59e0b]"
                          : "border-border bg-card hover:bg-muted/50 text-foreground shadow-[0_3px_0_var(--border)] hover:-translate-y-0.5 active:translate-y-0"
                      }`}
                    >
                      <div className="flex items-center gap-2 font-heading">
                        <RefreshCw className="size-4 text-amber-600 dark:text-amber-400" />
                        <span>{t("modeReplaceTitle")}</span>
                      </div>
                      <p className="text-2xs font-semibold text-muted-foreground mt-1">
                        {t("modeReplaceDesc")}
                      </p>
                    </button>
                  </div>

                  {generationMode === "replace" && (
                    <div className="flex items-center gap-1.5 text-2xs font-bold text-amber-700 dark:text-amber-400 bg-amber-500/10 px-3 py-1.5 rounded-xl border border-amber-500/30">
                      <AlertTriangle className="size-3.5 shrink-0" />
                      <span>{t("modeReplaceWarning")}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {busy && step === 2 && !generating && (
          <div className="flex shrink-0 items-center justify-center gap-2.5 rounded-2xl border-[3px] border-primary/30 bg-primary/5 px-4 py-3">
            <BotAvatar state="thinking" size={32} />
            <span className="text-sm font-extrabold text-primary">
              {t("generatingBtn")}
            </span>
          </div>
        )}

        <ResponsiveModalFooter className="shrink-0 pt-3 border-t-[3px] border-border/40 flex items-center justify-between sm:justify-between gap-3 bg-card pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {generating ? null : step === 1 ? (
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
              {inputMode === "file" ? (
                <Button
                  type="button"
                  onClick={() => void handleExtractAll()}
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
              ) : (
                <Button
                  type="button"
                  onClick={() => {
                    const text = pastedText.trim();
                    if (!text) {
                      setError(t("emptyTextError"));
                      return;
                    }
                    setExtractedText(text);
                    setIsLowDensity(false);
                    setError(null);
                    setStep(2);
                  }}
                  disabled={busy || pastedText.trim().length === 0}
                  className="font-bold rounded-xl gap-2 bg-primary text-primary-foreground shadow-[var(--shadow-clay-sm)]"
                >
                  <span>{t("continueWithText")}</span>
                  <ArrowRight className="size-4" />
                </Button>
              )}
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
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
