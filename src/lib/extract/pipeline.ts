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
  type OcrConfig,
} from "@/lib/extract/types";
import { nativeExtract } from "@/lib/extract/native";
import { tesseractExtract } from "@/lib/extract/tesseract";
import { glmExtract } from "@/lib/extract/glm-ocr";

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
};

/** Throw an AbortError if the caller has cancelled the extraction. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
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
    const glm = await glmExtract(file, (page, total) =>
      opts.onProgress?.({ stage: "ocr", page, total, engine: "glm" }),
    );
    return glm;
  }

  // Default: tesseract.
  const ocr = await tesseractExtract(file, (page, total) =>
    opts.onProgress?.({ stage: "ocr", page, total, engine: "tesseract" }),
  );
  return ocr;
}
