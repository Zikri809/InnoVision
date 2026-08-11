/**
 * Shared types + constants for the pluggable text-extraction pipeline
 * (PLAN §3). Engine semantics:
 *  - 'native'  — free, instant text-layer extraction (pdfjs/mammoth/jszip).
 *  - 'tesseract' — client-side WASM OCR (default, $0, zero setup).
 *  - 'glm'     — local GLM-OCR via Ollama (opt-in, probe-gated, high accuracy).
 *  - 'vision'  — cloud vision LLM via /api/ocr/vision (opt-in, costs tokens).
 */

export type ExtractEngine = "native" | "tesseract" | "glm" | "vision";

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
  ollamaBaseUrl: string;
  glmModel: string;
  visionModel: string;
};

/** Text density: a page is "scanned" (needs OCR) below this many chars. */
export const MIN_CHARS_PER_PAGE = 40;
/** Extracted text is capped to keep AI calls inside the 60s serverless budget. */
export const MAX_EXTRACT_CHARS = 15_000;
/** Max pages rendered per vision OCR request (Vercel 4.5 MB body cap). */
export const MAX_VISION_PAGES = 3;
/** Max pages rasterized + recognized per Tesseract/GLM OCR run (DoS / responsiveness cap). */
export const MAX_OCR_PAGES = 50;
/** Max base64 characters per image sent to /api/ocr/vision (~1.3 MB binary). */
export const MAX_IMAGE_BASE64_CHARS = 1_300_000;
/** Client-side file size cap. */
export const MAX_FILE_BYTES = 25_000_000;
/** Server-side native-parse page cap (DoS hardening). */
export const MAX_PARSE_PAGES = 50;
/** Zip (docx/pptx) decompression-bomb caps. */
export const MAX_ZIP_ENTRIES = 1000;
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
