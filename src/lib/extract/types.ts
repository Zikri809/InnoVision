/**
 * Shared types + constants for the pluggable text-extraction pipeline
 * (PLAN §3). Engine semantics:
 *  - 'native'  — free, instant text-layer extraction (pdfjs/mammoth/jszip).
 *  - 'tesseract' — client-side WASM OCR (default, $0, zero setup).
 *  - 'glm'     — local GLM-OCR via Docker/vLLM (opt-in, probe-gated, high accuracy).
 */

export type ExtractEngine = "native" | "tesseract" | "glm";

export type ExtractionResult = {
  text: string;
  pages: number;
  engine: ExtractEngine;
  /** Heuristic: too little text per page for reliable question generation. */
  lowConfidence?: boolean;
  /**
   * audit-2 M-17: multi-page engines (GLM over a PDF) keep going when
   * individual pages fail, so `pages` (success count) alone let a partial
   * corpus read as a complete one. `pagesAttempted` is the real denominator
   * for density math; `failedPages` (1-based) drives the UI warning.
   */
  pagesAttempted?: number;
  failedPages?: number[];
  /**
   * audit-3 F-F2/F-F10: the subset of `failedPages` rejected because the
   * per-user OCR budget was spent (HTTP 429), NOT because the page could not
   * be read. The dialog names the cause ("rate limited — retry") instead of
   * reporting a generic read failure, and offers a retry for the lost pages.
   */
  rateLimitedPages?: number[];
  /**
   * audit-3 F-F2: per-page text, index-aligned to page number (index i is
   * page i+1; "" for a page that produced nothing). Lets a retry re-OCR ONLY
   * the failed pages and splice them back into position, instead of re-running
   * the whole deck and re-tripping the very budget that caused the loss.
   */
  pageTexts?: string[];
  /** Pages actually attempted on this call (a retry attempts only the
   * requested subset, so `pages`/`pagesAttempted` describe just that call). */
  totalPages?: number;
};

/** Config passed from the builder page (server component reads env).
 * GLM connection details are server-only env now — the browser never needs
 * them (extraction proxies through /api/extract/ocr). */
export type OcrConfig = {
  defaultEngine: ExtractEngine;
};

/** Text density: a page is "scanned" (needs OCR) below this many chars. */
export const MIN_CHARS_PER_PAGE = 40;
/** Max pages rasterized + recognized per Tesseract/GLM OCR run (includes GLM-OCR up to 200 pages).
 * audit-3 F-F3: this cap bounds CPU/page count only — MEMORY is bounded by the
 * streaming rasterizer (one page in flight), not by this number. */
export const MAX_OCR_PAGES = 200;
/** Client-side file size cap (single file). */
export const MAX_FILE_BYTES = 25_000_000;
/** Maximum number of source files allowed in a multi-file batch upload. */
export const MAX_FILES = 5;
/** Maximum total upload size across all files in a multi-file batch (50 MB). */
export const MAX_TOTAL_UPLOAD_BYTES = 50_000_000;
/** Maximum aggregate extracted text character cap sent to the AI model (400,000 chars ~ 100,000 tokens). */
export const MAX_AGGREGATE_CHARS = 400_000;
/** Server-side native-parse page cap (supports full slide decks up to 200 pages). */
export const MAX_PARSE_PAGES = 200;
/** Zip (docx/pptx) decompression-bomb caps. */
export const MAX_ZIP_ENTRIES = 2500;
export const MAX_ZIP_TOTAL_BYTES = 50_000_000;

/** Allowed upload extensions (client-side MIME/extension gate). */
export const ALLOWED_EXTENSIONS = [
  "pdf",
  "docx",
  "pptx",
  "txt",
  "md",
  "png",
  "jpg",
  "jpeg",
  "webp",
] as const;

export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

/** Normalize an extension (strip dots, lowercase) and check membership. */
export function isAllowedExtension(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Sanitize a user-supplied filename for use as a single storage path segment.
 * Strips control characters, path separators, and `..` traversal sequences.
 * Falls back to a timestamped name when nothing safe remains.
 */
export function sanitizeStorageFilename(filename: string): string {
  // audit-3 INJ-F3 (hygiene): a dot-only name (".pdf") is an EXTENSION, not a
  // filename. `isAllowedExtension` accepts it (`split(".").pop()`), but the
  // stripping below deletes the leading dot and leaves a bare stem, so the
  // stored object loses its extension and `detectNativeType` throws
  // `unsupported_file_type` — a 422 whose "run OCR in the browser" advice
  // cannot work. Preserve the validated extension under a safe generated stem.
  if (/^\.[A-Za-z0-9]+$/.test(filename) && isAllowedExtension(filename)) {
    return `file-${Date.now()}.${filename.slice(1).toLowerCase()}`;
  }
  let base = filename.replace(/[\u0000-\u001f\u007f\\/]/g, "").trim();
  while (base.includes("..")) {
    base = base.replace(/\.\./g, "");
  }
  base = base
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  if (!base) return `file-${Date.now()}`;
  return base;
}

/** Estimate decoded bytes from a base64 string (data-URL aware). */
export function base64ByteLength(b64: string): number {
  const comma = b64.indexOf(",");
  const body = comma >= 0 ? b64.slice(comma + 1) : b64;
  // Padding may be absent; compute from length.
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return Math.floor((body.length * 3) / 4) - padding;
}

/** Split an array into sequential batches of at most `size`. */
export function batch<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
