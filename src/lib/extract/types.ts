/**
 * Shared types + constants for the pluggable text-extraction pipeline
 * (PLAN §3). Engine semantics:
 *  - 'native'  — free, instant text-layer extraction (pdfjs/mammoth/jszip).
 *  - 'tesseract' — client-side WASM OCR (default, $0, zero setup).
 *  - 'glm'     — local GLM-OCR via Docker/vLLM (opt-in, probe-gated, high accuracy).
 *  - 'vision'  — cloud vision LLM via /api/ocr/vision (opt-in, costs tokens).
 */

export type ExtractEngine = "native" | "tesseract" | "glm";

export type ExtractionResult = {
  text: string;
  pages: number;
  engine: ExtractEngine;
  /** Heuristic: too little text per page for reliable question generation. */
  lowConfidence?: boolean;
};

/** Config passed from the builder page (server component reads env). */
export type OcrConfig = {
  defaultEngine: ExtractEngine;
  glmBaseUrl: string;
  glmModel: string;
};

/** Text density: a page is "scanned" (needs OCR) below this many chars. */
export const MIN_CHARS_PER_PAGE = 40;
/** Max pages rendered per vision OCR request (Vercel 4.5 MB body cap). */
export const MAX_VISION_PAGES = 3;
/** Max pages rasterized + recognized per Tesseract/GLM OCR run (includes GLM-OCR up to 200 pages). */
export const MAX_OCR_PAGES = 200;
/** Max base64 characters per image sent to /api/ocr/vision (~0.93 MB binary). */
export const MAX_IMAGE_BASE64_CHARS = 1_300_000;
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
