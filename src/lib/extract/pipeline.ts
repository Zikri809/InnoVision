/**
 * Extraction pipeline — cascade logic (PLAN §3.2).
 *
 *   Upload file
 *      ▼
 *   [1] NativeExtractor (free, instant)  ← skipped when an OCR engine is
 *      │                                    EXPLICITLY chosen (glm/vision)
 *      │  text density OK? (≥ MIN_CHARS_PER_PAGE avg)
 *      ├── yes ──────────────────────────► use text, engine='native'
 *      ▼ no (scanned doc / image slides)
 *   [2] OCR engine picker (default = Tesseract, always available):
 *      ├── TesseractExtractor   → client-side WASM, $0 (DEFAULT)
 *      ├── GlmOcrExtractor      → local Docker/vLLM (opt-in, probe-gated)
 *      └── VisionOcrExtractor   → cloud vision LLM (opt-in)
 *      ▼
 *   Extracted text → /api/ai/generate-quiz
 *
 * Engine semantics: an explicitly selected OCR engine (glm or vision) runs
 * DIRECTLY on the file — the lecturer chose it for accuracy (tables, formulas,
 * partial/embedded text layers), so a sparse native text layer must not
 * silently win. Only the free default cascade (native → tesseract) keeps the
 * native-first shortcut.
 */

import {
  type ExtractEngine,
  type ExtractionResult,
  type GlmEngineInfo,
  type OcrConfig,
  type OcrProvider,
} from "@/lib/extract/types";
import { nativeExtract } from "@/lib/extract/native";
import { tesseractExtract } from "@/lib/extract/tesseract";
import { glmExtract, OcrPageError } from "@/lib/extract/glm-ocr";

export type PipelineProgress = {
  stage: "native" | "ocr";
  page: number;
  total: number;
  engine?: ExtractEngine;
};

export type PipelineOptions = {
  /** Preferred OCR engine (from the picker / config). Defaults to tesseract. */
  engine?: ExtractEngine;
  config?: Partial<OcrConfig>;
  onProgress?: (p: PipelineProgress) => void;
  /** Abort signal so a client can cancel a long extraction (checked between stages). */
  signal?: AbortSignal;
  /** Browser File when available; server passes ArrayBuffer + filename. */
  file?: File;
  data?: ArrayBuffer;
  filename?: string;
  /**
   * audit-3 F-F2: re-OCR ONLY these 1-based pages (a retry after a rate-limit
   * loss). Currently honoured by the GLM engine, which reports per-page text;
   * the caller splices the result back into the prior per-page corpus.
   */
  pagesToRetry?: number[];
  /**
   * gate G6: re-run the WHOLE document. The remote (Z.ai) leg returns one
   * markdown string with no page boundaries, so `pagesToRetry` cannot express
   * its retry unit — this flag forwards the intent to `glmExtract`, which
   * re-sends (and re-bills) the entire file. Ignored by the local leg, where
   * the page IS the retry unit.
   */
  retryWhole?: boolean;
  /**
   * Which OCR leg to use, as last observed from `glmEngineInfo()`. Omitted =
   * local (the free, per-page leg). Kept for direct callers; the dialog passes
   * the whole `engineInfo` below so the pipeline can read `available`.
   */
  provider?: OcrProvider;
  /**
   * Provider-aware page cap observed from `glmEngineInfo()` (local 200, remote
   * `GLM_REMOTE_MAX_PAGES` ?? 30). Omitted = the engine's own default.
   */
  maxPages?: number;
  /**
   * Defect #1: the FULL probe verdict, when the caller has one. Its presence is
   * what makes `available` load-bearing — the pipeline refuses to run GLM on a
   * verdict that is unavailable or unidentified, instead of silently taking the
   * local per-page branch. Omitted (no probe) keeps the pre-toggle behaviour:
   * `provider`/`maxPages` are forwarded as given and the engine's own default
   * applies.
   */
  engineInfo?: GlmEngineInfo | null;
};

/**
 * Throw an AbortError if the caller has cancelled the extraction. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Multi-file fold / retry decisions (defect #6)
 *
 * These were inline in `GenerateFromFileDialog`'s `handleExtractAll`, which the
 * Node test env cannot render — so the whole retry machine (the `!retryWhole`
 * splice guard, the `retryWhole && previous → {pages:[], whole:true}`
 * construction, the `skippedReason` exception, and the new error mappings) had
 * ZERO coverage: reverting any of it kept the suite green. They live here as
 * pure functions so the rules are pinned by tests; the dialog is now a thin
 * caller.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Per-file extraction outcome. Mirrors the dialog's `FileOutcome` exactly (the
 * dialog aliases this type), so the fold rules below are the single source of
 * truth for both.
 */
export type ExtractionOutcome = {
  path: string;
  name: string;
  /** 1-based position in the uploaded list — keeps SOURCE headers stable. */
  index: number;
  /** Trimmed extracted text ("" when the file contributed nothing). */
  text: string;
  /** Per-page text when the engine reports it (GLM local). */
  pageTexts?: string[];
  /** Full page count of the file (the density denominator across retries).
   *  `0` = the engine did not report one (remote `numPages: null`). */
  totalPages: number;
  /** 1-based pages that produced nothing, as of the latest attempt. */
  failedPages: number[];
  /** Failed pages rejected by the OCR rate limit (audit-3 F-F2/F-F10). */
  rateLimitedPages: number;
  /** Engine's own density/partial flag (feeds the low-density advisory). */
  lowConfidence: boolean;
  /** gate G6: a remote whole-document reading — retry the DOCUMENT, not pages. */
  wholeDocumentRetry: boolean;
  /** Why this file contributed no text at all (audit-3 F-F5). */
  skippedReason?: "empty";
};

/** The text an outcome contributes: per-page parts when available, else the
 *  engine's combined text. */
export function outcomeText(o: ExtractionOutcome): string {
  if (o.pageTexts) return o.pageTexts.filter((t) => t.trim()).join("\n\n").trim();
  return o.text.trim();
}

/**
 * gate G6: outcomes whose reading came from the REMOTE leg and must be retried
 * as a WHOLE DOCUMENT (one markdown string, no page boundaries). Kept apart
 * from the per-page failure set because the cost model differs: a whole-document
 * retry re-sends and RE-BILLS the entire file.
 */
export function documentRetryOutcomes(outcomes: ExtractionOutcome[]): ExtractionOutcome[] {
  return outcomes.filter((o) => o.wholeDocumentRetry);
}

/** audit-3 F-F2: paths whose OCR pages failed (or that produced nothing), i.e.
 *  the per-page retry set. */
export function failedRetryPaths(outcomes: ExtractionOutcome[]): string[] {
  return outcomes
    .filter((o) => o.failedPages.length > 0 || o.skippedReason === "empty")
    .map((o) => o.path);
}

/**
 * The `retry` argument for one `extractOne` call (gate G6).
 *
 * - `retryWhole` + a prior outcome → `{pages: [], previous, whole: true}`: the
 *   remote leg has no page set to re-run, and the `whole` flag is what tells
 *   the splice guard to stand down.
 * - otherwise the prior FAILED pages → a page-granular retry.
 * - nothing to retry (first run, or a whole-doc retry with no prior outcome) →
 *   `undefined`.
 */
export function planRetry(args: {
  retryWhole: boolean;
  retarget: boolean;
  previous?: ExtractionOutcome;
}): { pages: number[]; previous: ExtractionOutcome; whole?: true } | undefined {
  const { retryWhole, retarget, previous } = args;
  if (retryWhole) return previous ? { pages: [], previous, whole: true } : undefined;
  if (!retarget || !previous || previous.failedPages.length === 0) return undefined;
  return { pages: previous.failedPages, previous };
}

/**
 * The splice decision (audit-3 F-F2): re-OCR'd pages land back in their original
 * positions — but ONLY for a page-granular retry. A whole-document retry
 * REPLACES the outcome (it has no `pageTexts` to splice), and splicing it would
 * fabricate page boundaries the remote leg never reported.
 */
export function shouldSpliceRetry(args: {
  retryWhole: boolean;
  retryPages?: number[];
  previous?: ExtractionOutcome;
}): boolean {
  const { retryWhole, retryPages, previous } = args;
  return !retryWhole && !!retryPages && previous?.pageTexts !== undefined;
}

/** Splice recovered page text into the prior per-page corpus, in position. */
export function spliceRetriedPages(
  fresh: ExtractionOutcome,
  previous: ExtractionOutcome,
  retryPages: number[],
): ExtractionOutcome {
  const merged = [...(previous.pageTexts ?? [])];
  fresh.pageTexts?.forEach((t, i) => {
    if (t.trim()) merged[i] = t;
  });
  return {
    ...fresh,
    pageTexts: merged,
    text: merged.filter((t) => t.trim()).join("\n\n").trim(),
    // Recovered pages drop out of the failure set.
    failedPages: fresh.failedPages.filter((p) => !retryPages.includes(p)),
  };
}

/**
 * Fold fresh outcomes into the prior set: a retry replaces only the re-run
 * files (F-F2 — the user retries the lost pages, not the whole batch), while a
 * full run's `produced` list IS the new state.
 */
export function mergeOutcomes(args: {
  prior: ExtractionOutcome[];
  produced: ExtractionOutcome[];
  paths: string[];
  retarget: boolean;
}): ExtractionOutcome[] {
  const { prior, produced, paths, retarget } = args;
  if (!retarget) return produced;
  const byPath = new Map(prior.map((o) => [o.path, o]));
  for (const outcome of produced) byPath.set(outcome.path, outcome);
  const merged = paths
    .map((path) => byPath.get(path))
    .filter((o): o is ExtractionOutcome => o !== undefined);
  return merged.length > 0 ? merged : produced;
}

/**
 * The `skippedReason` decision (audit-3 F-F5 + gate G6). A retry keeps the
 * file's "contributed" status from its earlier attempt — only the failed pages
 * were re-run, so an all-failed retry must not erase pages that succeeded
 * before. A WHOLE-document retry is the EXCEPTION: it replaces the outcome
 * wholesale, so an empty re-run really does mean this file contributed nothing.
 */
export function outcomeSkippedReason(args: {
  text: string;
  retry?: { pages: number[]; previous: ExtractionOutcome; whole?: boolean };
}): "empty" | undefined {
  const { text, retry } = args;
  if (text.trim()) return undefined;
  if (!retry?.whole && retry?.previous.text.trim()) return undefined;
  return "empty";
}

/** Cross-file totals the dialog's advisories + density heuristic key on. */
export type OutcomeSummary = {
  totalAttemptedPages: number;
  totalFailedPages: number;
  totalRateLimitedPages: number;
  hasLowConfidence: boolean;
  /**
   * Outcomes whose engine reported NO page count (`totalPages === 0`). When
   * this is non-zero the density denominator is a LOWER BOUND, so the
   * per-page average must not be trusted (defect #7 — dividing by a fabricated
   * 1 claimed a 300-page deck was 300x denser than it is).
   */
  unknownPageCount: number;
};

export function summarizeOutcomes(outcomes: ExtractionOutcome[]): OutcomeSummary {
  return {
    totalAttemptedPages: outcomes.reduce((n, o) => n + o.totalPages, 0),
    totalFailedPages: outcomes.reduce((n, o) => n + o.failedPages.length, 0),
    totalRateLimitedPages: outcomes.reduce((n, o) => n + o.rateLimitedPages, 0),
    hasLowConfidence: outcomes.some((o) => o.lowConfidence),
    unknownPageCount: outcomes.filter((o) => o.totalPages <= 0).length,
  };
}

/**
 * The low-density advisory (audit-2 M-17 + defect #7). Presentation/office
 * decks with suspiciously sparse text (<12 words or <50 chars per page) are
 * flagged — but ONLY when every contributing file reported a page count. With
 * an unknown count the denominator is a lower bound, so the average is an
 * over-estimate and a "very little text" claim would be unearned; the engine's
 * own `lowConfidence` flag still fires.
 */
export function isLowDensityOutcome(args: {
  hasOfficeFiles: boolean;
  summary: OutcomeSummary;
  words: number;
  chars: number;
}): boolean {
  const { hasOfficeFiles, summary, words, chars } = args;
  if (!hasOfficeFiles) return false;
  if (summary.unknownPageCount > 0) return summary.hasLowConfidence;
  if (summary.hasLowConfidence) return true;
  if (summary.totalAttemptedPages <= 0) return false;
  const avgWordsPerPage = Math.round(words / summary.totalAttemptedPages);
  const avgCharsPerPage = Math.round(chars / summary.totalAttemptedPages);
  return avgWordsPerPage < 12 || avgCharsPerPage < 50;
}

/**
 * Typed extraction error code → i18n key under the `extract` namespace
 * (contract §4.10.5). The dialog maps the code the pipeline threw to a
 * TRANSLATED message; anything absent falls through to the raw message.
 * `glm_pages_exceeded` / `glm_spend_cap` are gate G3/G8's additions and
 * `invalid_pdf` is defect #5's (a malformed PDF used to surface pdf.js's
 * untranslated English `InvalidPDFException` text).
 *
 * `as const` so the values are LITERAL keys: the dialog passes one straight to
 * `t()`, which is type-checked against `IntlMessages` — a typo here fails the
 * typecheck instead of rendering the key path.
 */
export const EXTRACT_ERROR_I18N = {
  glm_rate_limited: "glmRateLimited",
  glm_busy: "glmBusy",
  glm_error: "glmError",
  glm_timeout: "glmTimeout",
  glm_model_unavailable: "glmUnavailable",
  glm_pages_exceeded: "glmPagesExceeded",
  glm_spend_cap: "glmSpendCap",
  invalid_pdf: "invalidPdf",
  canvas_unavailable: "canvasUnavailable",
  unsupported_file_type: "unsupportedType",
} as const;

/** A message key the dialog can hand straight to `t()` under `extract`. */
export type ExtractErrorI18nKey = (typeof EXTRACT_ERROR_I18N)[keyof typeof EXTRACT_ERROR_I18N];

/**
 * The i18n key for a thrown extraction error, or null when the error carries no
 * code the dialog knows (caller falls back to the raw message, then generic).
 * `AbortError` is handled by the caller (it is a cancellation, not a code).
 */
export function extractErrorI18nKey(message: string): ExtractErrorI18nKey | null {
  return (EXTRACT_ERROR_I18N as Readonly<Record<string, ExtractErrorI18nKey>>)[message] ?? null;
}

/**
 * Defect #2: is this verdict DEFINITIVE (safe to cache for the rest of the
 * dialog session), or must it be re-probed?
 *
 * The dialog caches the probe promise for its whole lifetime, and `reset()`
 * never cleared it — so ONE transient blip (a cold-cache abort, a 429 on the
 * health bucket, a flaky network moment) poisoned EVERY later run in that
 * dialog session: the failed verdict was replayed forever and the engine was
 * permanently hidden until the page was reloaded.
 *
 * Only a verdict that NAMED the leg is definitive. A probe that failed resolves
 * to `provider:"unknown"` — an absence of information, not a verdict about the
 * engine — so it is dropped and the next run probes once more (the server's
 * negative TTL is 30 s, so this cannot hammer the billed remote probe).
 * A definitive `available:false` (e.g. remote misconfigured / auth failure) IS
 * cached: the server said so, and re-asking would just re-spend the probe.
 */
export function shouldReuseProbe(info: GlmEngineInfo | null | undefined): boolean {
  return info !== null && info !== undefined && info.provider !== "unknown";
}

/**
 * Defect #1 (the picker half): the engine to show as SELECTED once the probe's
 * verdict lands.
 *
 * The dialog restores `glm` from localStorage, so a FAILED probe used to leave
 * the option selected-but-hidden — still extractable, with the user never told
 * why the scanner vanished. The rule: a `glm` selection cannot survive a
 * verdict that says the engine is unusable (or unidentified), so it falls back
 * to the always-available tesseract. Any other selection is untouched.
 *
 * Exported and pure so the restored-selection interaction is unit-tested
 * (the component itself is not renderable in the Node test env).
 */
export function engineAfterProbe(
  value: ExtractEngine,
  info: GlmEngineInfo | null | undefined,
): ExtractEngine {
  if (value !== "glm") return value;
  // The probe has not answered yet: leave the selection alone. The extract path
  // still refuses if the verdict turns out unusable, so this cannot let a
  // metered per-page run through.
  if (info === null || info === undefined) return value;
  return usableEngineInfo(info) ? "glm" : "tesseract";
}

/** The decision the extract path must take for the selected engine + verdict. */
export type GlmRunDecision =
  | { action: "run"; engineInfo: GlmEngineInfo | null }
  | { action: "refuse"; code: "glm_model_unavailable" };

/**
 * Defect #1 (the dialog half): may extraction proceed, and under which verdict?
 *
 * This is the gate that was missing — the dialog spread `provider`/`maxPages`
 * into the pipeline without ever reading `available`, so a failed probe drove
 * the METERED per-page loop. Refusing (rather than defaulting to the local
 * per-page leg) is the whole point: the engine could not be reached or
 * identified, which is what `glm_model_unavailable` means to the user.
 *
 * A non-GLM engine, or a caller with no verdict at all, runs as before.
 */
export function planGlmRun(
  engine: ExtractEngine,
  info: GlmEngineInfo | null | undefined,
): GlmRunDecision {
  if (engine !== "glm") return { action: "run", engineInfo: null };
  // No verdict yet (a direct caller / non-GLM flow): the pipeline's own
  // fail-closed default applies, unchanged.
  if (info === null || info === undefined) return { action: "run", engineInfo: null };
  const usable = usableEngineInfo(info);
  if (!usable) return { action: "refuse", code: "glm_model_unavailable" };
  return { action: "run", engineInfo: usable };
}

/**
 * gate G7 + defect #1: which engine-info the pipeline may run GLM under.
 *
 * The picker forwards whatever the probe returned, and the dialog used to
 * spread it into the pipeline WITHOUT ever reading `available` — so a FAILED
 * probe (which reported `provider:"local"`) drove the metered per-page loop
 * against a remote server. This is the gate: an unavailable or unidentified
 * verdict yields `null`, meaning "do not extract under this probe".
 *
 * Returns the info to forward (only when the engine is genuinely usable), or
 * null when the caller must refuse. `null` is also the correct answer for a
 * caller that never probed at all (no info), because the pipeline's own default
 * is the free local leg — that path is unchanged and stays backwards
 * compatible.
 */
export function usableEngineInfo(info: GlmEngineInfo | null | undefined): GlmEngineInfo | null {
  if (!info) return null;
  if (info.provider === "unknown") return null;
  if (!info.available) return null;
  return info;
}

/**
 * Run the extraction cascade. Returns the best available result:
 *  - native text if density is OK (≥ MIN_CHARS_PER_PAGE average);
 *  - otherwise the chosen OCR engine (default tesseract; glm only if probe
 *    passes — the picker already hides it otherwise; vision opt-in).
 *
 * The GLM availability probe is re-run here so a stale picker choice can't
 * select an engine that's no longer reachable (U-E4).
 */
export async function runExtractionPipeline(
  opts: PipelineOptions,
): Promise<ExtractionResult> {
  const engine = opts.engine ?? "tesseract";

  let data: ArrayBuffer;
  let filename: string;
  if (opts.file) {
    data = await opts.file.arrayBuffer();
    filename = opts.file.name;
  } else if (opts.data && opts.filename) {
    data = opts.data;
    filename = opts.filename;
  } else {
    throw new Error("no_input");
  }

  // ── [1] Native extractor ────────────────────────────────────────
  // An EXPLICITLY selected OCR engine (glm) is authoritative for raster
  // inputs (PDFs and image files): it runs directly without the native shortcut.
  // Structured presentation/document archives (.pptx, .docx) contain XML streams
  // that vision models cannot decode directly as images; they are always parsed natively.
  const isImageOrPdf = /\.(pdf|png|jpe?g|webp)$/i.test(filename);
  if (engine === "glm" && isImageOrPdf) {
    return runOcr(opts, engine);
  }

  opts.onProgress?.({ stage: "native", page: 0, total: 1 });
  throwIfAborted(opts.signal);
  let native: ExtractionResult;
  try {
    native = await nativeExtract(data, filename, { node: !opts.file });
  } catch (err) {
    const msg = (err as Error)?.message;
    if (msg === "unsupported_file_type") {
      const isImage = /\.(png|jpe?g|webp)$/i.test(filename);
      if (isImage) {
        native = { text: "", pages: 0, engine: "native", lowConfidence: true };
      } else {
        throw err;
      }
    } else if (
      // Content-based rejections from magic-byte validation are FINAL: a
      // renamed binary will not magically parse in OCR either, so surface
      // the typed error instead of masking it as low-confidence text.
      msg === "corrupt_or_invalid_pdf" ||
      msg === "corrupt_or_invalid_docx" ||
      msg === "corrupt_or_invalid_pptx" ||
      msg === "binary_file_not_supported_as_text" ||
      msg === "image_too_large"
    ) {
      throw err;
    } else {
      native = { text: "", pages: 0, engine: "native", lowConfidence: true };
    }
  }

  const isOfficeDoc = /\.(pptx|docx)$/i.test(filename);
  const usable =
    (native.text.trim().length > 0 && !native.lowConfidence && native.pages > 0) ||
    isOfficeDoc;

  if (usable) {
    return native;
  }

  // ── [2] OCR engine ──────────────────────────────────────────────
  throwIfAborted(opts.signal);
  if (!opts.file) {
    // Server-side: we cannot run browser OCR; signal that the client must.
    throw new Error("ocr_required_browser");
  }

  return runOcr(opts, engine);
}

/**
 * Run the chosen OCR engine. Requires a browser `File` — the pipeline only
 * routes here when one exists (server-side callers throw earlier), but the
 * guard keeps the contract explicit instead of trusting a `!` assertion.
 */
async function runOcr(
  opts: PipelineOptions,
  engine: ExtractEngine,
): Promise<ExtractionResult> {
  const file = opts.file;
  if (!file) throw new Error("no_input");

  if (engine === "glm") {
    // Defect #1: the probe verdict is the gate. The dialog passes the WHOLE
    // `GlmEngineInfo` (not just the derived provider/cap pair) so this layer can
    // read `available` — the old wiring spread `provider`/`maxPages` into the
    // pipeline without ever consulting `available`, so a FAILED probe (which
    // reported `provider:"local"`) drove the metered per-page loop.
    //
    // A verdict that is present but unusable is REFUSED, not downgraded:
    // silently falling back to the local per-page loop against a remote server
    // is exactly the 10-200x overspend gate G3 exists to prevent.
    //
    // `null`/absent means "this caller has no verdict" (the pre-toggle direct
    // path, and the dialog when the engine is not glm) — that keeps the free
    // local default, unchanged.
    if (opts.engineInfo) {
      const info = usableEngineInfo(opts.engineInfo);
      if (!info) throw new OcrPageError("glm_model_unavailable");
      const glm = await glmExtract(
        file,
        (page, total) => opts.onProgress?.({ stage: "ocr", page, total, engine: "glm" }),
        {
          pagesToRetry: opts.pagesToRetry,
          retryWhole: opts.retryWhole,
          provider: info.provider,
          maxPages: info.maxPages,
        },
      );
      return glm;
    }
    const glm = await glmExtract(
      file,
      (page, total) => opts.onProgress?.({ stage: "ocr", page, total, engine: "glm" }),
      // audit-3 F-F2: a retry re-runs only the failed pages (honoured by GLM).
      // gate G6: on the REMOTE leg that machine does not apply (one markdown
      // string, no page boundaries) — `retryWhole` re-sends the document and
      // `provider`/`maxPages` pick the branch + its cap.
      {
        pagesToRetry: opts.pagesToRetry,
        retryWhole: opts.retryWhole,
        provider: opts.provider,
        maxPages: opts.maxPages,
      },
    );
    return glm;
  }

  // Default: tesseract.
  const ocr = await tesseractExtract(file, (page, total) =>
    opts.onProgress?.({ stage: "ocr", page, total, engine: "tesseract" }),
  );
  return ocr;
}
