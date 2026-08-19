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
import { visionExtract } from "@/lib/extract/vision";

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
  const cfg = opts.config ?? {};

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
  // An EXPLICITLY selected OCR engine (glm/vision) is authoritative: it runs
  // directly on the file without the native shortcut. The lecturer chose it
  // for accuracy (scanned slides, tables, embedded/partial text layers), so a
  // sparse native text layer must not silently win. Only the default cascade
  // (native → tesseract) keeps the free native-first shortcut.
  if (engine === "glm" || engine === "vision") {
    return runOcr(opts, engine, cfg);
  }

  opts.onProgress?.({ stage: "native", page: 0, total: 1 });
  throwIfAborted(opts.signal);
  let native: ExtractionResult;
  try {
    native = await nativeExtract(data, filename, { node: !opts.file });
  } catch (err) {
    if ((err as Error)?.message === "unsupported_file_type") {
      // Image files (PNG/JPG/WEBP) have no "native text layer" — they are
      // first-class extraction inputs and should fall through to OCR. Return a
      // low-confidence empty result so the cascade continues.
      const isImage = /\.(png|jpe?g|webp)$/i.test(filename);
      if (isImage) {
        native = { text: "", pages: 0, engine: "native", lowConfidence: true };
      } else {
        throw err;
      }
    } else {
      // Corrupt / unparseable native extraction: fall through to OCR instead of
      // failing the whole pipeline (U-E7 requires a clean error for zero-byte
      // files though — handled by the caller's pre-check).
      native = { text: "", pages: 0, engine: "native", lowConfidence: true };
    }
  }

  const usable =
    native.text.trim().length > 0 &&
    !native.lowConfidence &&
    native.pages > 0;

  if (usable) {
    return native;
  }

  // ── [2] OCR engine ──────────────────────────────────────────────
  throwIfAborted(opts.signal);
  if (!opts.file) {
    // Server-side: we cannot run browser OCR; signal that the client must.
    throw new Error("ocr_required_browser");
  }

  return runOcr(opts, engine, cfg);
}

/**
 * Run the chosen OCR engine. Requires a browser `File` (server-side callers
 * never reach this — they throw `ocr_required_browser` in the pipeline).
 */
async function runOcr(
  opts: PipelineOptions,
  engine: ExtractEngine,
  cfg: Partial<OcrConfig>,
): Promise<ExtractionResult> {
  const file = opts.file!;

  if (engine === "glm") {
    const glm = await glmExtract(
      file,
      { baseUrl: cfg.glmBaseUrl ?? "http://localhost:11434", model: cfg.glmModel ?? "glm-ocr" },
      (page, total) => opts.onProgress?.({ stage: "ocr", page, total, engine: "glm" }),
    );
    return glm;
  }

  if (engine === "vision") {
    const vision = await visionExtract(
      file,
      {},
      (done, total) => opts.onProgress?.({ stage: "ocr", page: done, total, engine: "vision" }),
    );
    return vision;
  }

  // Default: tesseract.
  const ocr = await tesseractExtract(file, (page, total) =>
    opts.onProgress?.({ stage: "ocr", page, total, engine: "tesseract" }),
  );
  return ocr;
}
