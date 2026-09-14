/**
 * GLM-OCR client (extraction pipeline, browser side).
 *
 * The heavy lifting is SERVER-SIDE now: `/api/extract/ocr` proxies to the
 * local GLM-OCR container (vLLM), so remote users (e.g. via a tunnel) can use
 * the engine even though the container is loopback-bound on the host machine.
 * This module keeps only what genuinely needs the browser:
 *  - PDF → PNG rasterization (pdf.js + canvas)
 *  - image decompression-bomb guard
 *  - per-page progress reporting
 *
 * Memory model (audit-3 F-F3): rasterization is STREAMED — one page is
 * rendered, encoded, OCR'd, and released before the next page is rendered.
 * Materialising every page's base64 PNG first (the pre-F3 shape) cost
 * ~0.2-1 GB for a 200-page deck and could OOM the tab; the page-count cap
 * alone bounded CPU, never memory.
 *
 * Error contract (pinned by GenerateFromFileDialog's i18n mapping):
 * `glm_model_unavailable` / `glm_timeout` / `glm_error` / `glm_rate_limited`
 * (audit-3 F-F10: our per-user budget or an upstream 429 is NOT a read
 * failure — the distinct code lets the dialog say "rate limited, retry"
 * instead of provoking retries into the same spent window) / `glm_busy`.
 */

import { MAX_OCR_PAGES, type ExtractionResult } from "@/lib/extract/types";
import { destroyPdf, loadPdfJs } from "@/lib/extract/pdf";
import { assertSafeImageDimensions } from "@/lib/extract/image-guard";

/** Probe wrapper matching the picker's needs (U-E4/U-E8). */
export async function glmAvailable(): Promise<boolean> {
  try {
    const res = await fetch("/api/extract/ocr", { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return false;
    const json = (await res.json()) as { available?: boolean };
    return json.available === true;
  } catch {
    return false;
  }
}

/** Rasterize a PDF to base64 PNG pages in the browser. */
const MAX_CANVAS_DIMENSION = 4096;

/**
 * Rasterize a PDF ONE PAGE AT A TIME. The caller consumes each page (OCR +
 * drop) before `next()` renders the following one, so peak memory is a single
 * canvas + a single base64 string instead of the whole deck (audit-3 F-F3).
 * `onTotal` reports the capped page count as soon as it is known (before the
 * first yield) so progress bars can render "1 of N". `onlyPages` (audit-3
 * F-F2) renders ONLY those 1-based pages, so a retry never re-rasterizes the
 * whole deck.
 */
async function* rasterizePdfPages(
  file: File,
  onTotal?: (total: number, progressTotal: number) => void,
  onlyPages?: Set<number>,
): AsyncGenerator<{ dataUrl: string; page: number }> {
  const pdfjs = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  try {
    // Cap pages (MAX_OCR_PAGES) to bound browser CPU; memory is bounded by the
    // streaming loop below, not by this cap.
    const total = Math.min(doc.numPages, MAX_OCR_PAGES);
    // A retry renders only a subset — the progress bar counts THAT subset,
    // while `total` stays the document's page count (pageTexts sizing).
    const progressTotal = onlyPages
      ? [...onlyPages].filter((p) => p >= 1 && p <= total).length
      : total;
    onTotal?.(total, progressTotal);
    for (let i = 1; i <= total; i++) {
      if (onlyPages && !onlyPages.has(i)) continue;
      const page = await doc.getPage(i);
      let viewport = page.getViewport({ scale: 2 });
      const maxDim = Math.max(viewport.width, viewport.height);
      if (maxDim > MAX_CANVAS_DIMENSION) {
        const scale = (MAX_CANVAS_DIMENSION / maxDim) * 2;
        viewport = page.getViewport({ scale });
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas_unavailable");
      try {
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        yield { dataUrl: canvas.toDataURL("image/png"), page: i };
      } finally {
        // Release the bitmap + pdf.js page resources before the next render —
        // this is the whole point of streaming (F-F3).
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    }
  } finally {
    await destroyPdf(doc);
  }
}

// Overall wall-clock budget for a whole GLM OCR run (all pages up to 200).
const GLM_OCR_BUDGET_MS = 20 * 60_000;
const PAGE_TIMEOUT_MS = 90_000;

/** An OCR page failure carrying the SERVER'S typed code (F-F2/F-F10). */
export class OcrPageError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "OcrPageError";
  }
}

/** Codes whose remedy is "wait and retry", not "this page is unreadable". */
const RETRYABLE_PAGE_CODES = new Set(["glm_rate_limited", "glm_busy"]);

/**
 * Page OCR under the run's remaining wall-clock budget. SDK/fetch failures
 * collapse to `glm_error`; the server's typed code is preserved on an
 * OcrPageError so the caller can tell a spent budget from a bad page.
 */
async function ocrPage(dataUrl: string, remainingMs: number): Promise<string> {
  const res = await fetch("/api/extract/ocr", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: dataUrl }),
    signal: AbortSignal.timeout(Math.min(PAGE_TIMEOUT_MS, remainingMs)),
  });
  const json = (await res.json().catch(() => null)) as
    | { text?: string; error?: string }
    | null;
  if (!res.ok || !json?.text) {
    throw new OcrPageError(json?.error ?? "glm_error");
  }
  return json.text;
}

/**
 * OCR a file with GLM-OCR through the server proxy. Images/PDF pages are
 * rasterized and sent ONE AT A TIME (vision-language models accept a single
 * image per message; also preserves per-page progress), and each page is
 * released before the next is rendered. Returns concatenated text with
 * engine='glm'.
 */
export async function glmExtract(
  file: File,
  onProgress?: (page: number, total: number) => void,
  opts: { pagesToRetry?: number[] } = {},
): Promise<ExtractionResult> {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  // audit-3 F-F2: a retry targets ONLY the previously-failed pages, so it does
  // not re-spend the freshly-reset budget on pages that already succeeded.
  const onlyPages =
    opts.pagesToRetry && opts.pagesToRetry.length > 0 ? new Set(opts.pagesToRetry) : undefined;

  // Lazily-built page source: PDFs stream page-by-page; images are a single
  // page read into a data URL (same decompression-bomb gate as Tesseract).
  let total = 0;
  let progressTotal = 0;
  // Kept so the consume loop can CLOSE the generator on an early throw
  // (adversarial review A1): the generator's `finally` is what zeroes the
  // canvas and calls page.cleanup()/destroyPdf(), and it only runs when the
  // generator is resumed to completion OR explicitly returned. Throwing out of
  // the loop left a 4096px canvas + the pdf.js document alive until GC.
  let pagesGen: AsyncGenerator<{ dataUrl: string; page: number }> | null = null;
  let nextPage: () => Promise<{ dataUrl: string; page: number } | null>;
  if (isPdf) {
    const pages = rasterizePdfPages(
      file,
      (n, p) => {
        total = n;
        progressTotal = p;
      },
      onlyPages,
    );
    pagesGen = pages;
    nextPage = async () => {
      const r = await pages.next();
      return r.done ? null : r.value;
    };
  } else {
    await assertSafeImageDimensions(file);
    const dataUrl = await fileToDataUrl(file);
    total = 1;
    progressTotal = 1;
    let taken = false;
    nextPage = async () => {
      if (taken) return null;
      taken = true;
      return { dataUrl, page: 1 };
    };
  }

  // Prime the source: for the PDF path this triggers `onTotal`, so `total` is
  // known before the first OCR call allocates the per-page array.
  let current = await nextPage();

  const deadline = Date.now() + GLM_OCR_BUDGET_MS;
  const parts: string[] = [];
  const failedPages: number[] = [];
  const rateLimitedPages: number[] = [];
  const errors = new Map<string, OcrPageError>();
  // Index-aligned per-page text (audit-3 F-F2) so the caller can splice a
  // retried page back into its original position.
  const pageTexts: string[] = new Array(Math.max(total, 1)).fill("");
  let successCount = 0;
  let attempted = 0;

  try {
    while (current) {
      const item = current;
      attempted += 1;
      onProgress?.(attempted, progressTotal || total);
      const remaining = Math.max(1_000, deadline - Date.now());
      try {
        const text = await ocrPage(item.dataUrl, remaining);
        parts.push(text);
        pageTexts[item.page - 1] = text;
        successCount++;
      } catch (err) {
        console.warn(`[GLM-OCR] Error on page ${item.page}:`, err);
        // A single-page input has no "keep the rest" fallback — surface the
        // typed failure directly (unchanged pre-F2 behavior).
        if (total <= 1) throw err;
        const code = err instanceof OcrPageError ? err.code : "glm_error";
        if (!errors.has(code)) {
          errors.set(code, err instanceof OcrPageError ? err : new OcrPageError("glm_error"));
        }
        failedPages.push(item.page);
        // audit-3 F-F2/F-F10: distinguish "the budget was spent" from "this page
        // could not be read" so the advisory can name the cause + offer a retry.
        if (RETRYABLE_PAGE_CODES.has(code)) rateLimitedPages.push(item.page);
      }
      current = await nextPage();
    }
  } finally {
    // Close the source on EVERY exit (including the single-page rethrow and
    // any other error) so the rasterizer's cleanup always runs.
    if (pagesGen) {
      try {
        await pagesGen.return(undefined as never);
      } catch {
        // Cleanup failure must not mask the original error.
      }
    }
  }

  if (attempted === 0) {
    // Nothing was rasterized (empty PDF) — same failure shape as before.
    throw new OcrPageError("glm_error");
  }

  if (successCount === 0) {
    // Every attempted page failed: surface the MOST ACTIONABLE code. A spent
    // budget (F-F10) must not read as "the scanner could not read this file" —
    // that advice provokes retries into the same window.
    const retryable = [...errors.keys()].find((c) => RETRYABLE_PAGE_CODES.has(c));
    throw errors.get(retryable ?? "glm_error") ?? new OcrPageError("glm_error");
  }

  // Partial runs are honest: report the pages that actually produced text
  // (not attempted count — the density heuristic consumes this number) and
  // flag low confidence so the caller knows pages were lost mid-run.
  const partial = successCount < attempted;
  let text = parts.join("\n\n").trim();
  text = sanitizeGlmText(text);
  return {
    text,
    pages: successCount,
    engine: "glm",
    // audit-2 M-17: carry the real denominator + which pages failed so the
    // dialog can warn "N of M pages failed" for EVERY file type (the old
    // low-confidence flag only surfaced for office files) and run the
    // density heuristic over ATTEMPTED pages (the success count deflated it,
    // inflating avg words/page on partial runs).
    pagesAttempted: attempted,
    totalPages: total,
    pageTexts,
    ...(partial
      ? {
          lowConfidence: true,
          failedPages,
          // audit-3 F-F2: the retryable subset (rate limit / busy), so the
          // dialog can say WHY and offer to retry just those pages.
          ...(rateLimitedPages.length > 0 ? { rateLimitedPages } : {}),
        }
      : {}),
  };
}

/**
 * Clean GLM-OCR output. The model sometimes emits a long run of markdown-fence
 * noise (repeated ``` ``` ``` ...) after the real transcription — it loops on
 * the closing delimiter. Collapse any run of 3+ consecutive fence lines down
 * to a single fence so the extracted text isn't polluted.
 */
export function sanitizeGlmText(text: string): string {
  return text.replace(/(?:```\s*){3,}/g, "```\n");
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}
