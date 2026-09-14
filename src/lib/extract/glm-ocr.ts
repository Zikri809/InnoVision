/**
 * GLM-OCR client (extraction pipeline, browser side).
 *
 * The heavy lifting is SERVER-SIDE: `/api/extract/ocr` proxies to EITHER the
 * local GLM-OCR container (vLLM) OR the Z.ai PaaS API, so remote users (e.g.
 * via a tunnel) can use the engine even though the container is loopback-bound
 * on the host machine. This module keeps only what genuinely needs the browser:
 *  - PDF → PNG rasterization (pdf.js + canvas) — LOCAL leg only
 *  - image decompression-bomb guard
 *  - per-page progress reporting (local) / single-request progress (remote)
 *
 * TWO LEGS (contract §4.7, gates G3/G6):
 *  - LOCAL (`provider: "local"`, the default): ONE PAGE PER REQUEST, rasterized
 *    in the browser and spliced back by page index (`pageTexts[]`,
 *    `failedPages`, `rateLimitedPages`, `pagesToRetry`). Free.
 *  - REMOTE (`provider: "remote"`): exactly ONE request per DOCUMENT — the file
 *    bytes go up as a data URL and the server returns whole-document markdown
 *    (`md_results`), which has NO page boundaries. `pageTexts` is therefore
 *    `undefined` and the retry unit is the WHOLE DOCUMENT
 *    (`wholeDocumentRetry: true`). Splitting markdown into fake pages would
 *    silently corrupt the corpus, so it is never done. Metered (billed).
 *
 * Memory model (audit-3 F-F3): local rasterization is STREAMED — one page is
 * rendered, encoded, OCR'd, and released before the next page is rendered.
 * Materialising every page's base64 PNG first (the pre-F3 shape) cost
 * ~0.2-1 GB for a 200-page deck and could OOM the tab; the page-count cap
 * alone bounded CPU, never memory. The remote leg does not rasterize at all
 * (the file is uploaded as-is), so it has no per-page memory profile.
 *
 * Error contract (pinned by GenerateFromFileDialog's i18n mapping):
 * `glm_model_unavailable` / `glm_timeout` / `glm_error` / `glm_rate_limited`
 * (audit-3 F-F10: our per-user budget or an upstream 429 is NOT a read
 * failure — the distinct code lets the dialog say "rate limited, retry"
 * instead of provoking retries into the same spent window) / `glm_busy` /
 * `glm_pages_exceeded` (gate G3: remote PDF over the page cap, refused
 * client-side BEFORE any upload or spend) / `glm_spend_cap` (gate G8: the
 * remote daily token budget is spent).
 */

import {
  MAX_OCR_PAGES,
  MAX_OCR_PAGES_REMOTE,
  UNKNOWN_MAX_PAGES,
  type ExtractionResult,
  type GlmEngineInfo,
  type OcrProvider,
} from "@/lib/extract/types";
import { destroyPdf, loadPdfJs } from "@/lib/extract/pdf";
import { assertSafeImageDimensions } from "@/lib/extract/image-guard";

/**
 * Client-side probe deadline (defect #2). It MUST comfortably exceed the
 * SERVER's worst cold-cache path, or the abort is the EXPECTED outcome:
 *
 *   createClient() + requireLecturer()   (Supabase round trips, ~0.2-1 s each)
 *   + the route's window limiter         (in-process)
 *   + glmHealth() on the REMOTE leg      (a real BILLED `layout_parsing` POST
 *                                         whose own bound is
 *                                         GLM_PROBE_TIMEOUT_MS = 5_000)
 *
 * So 5 s of legitimate server work inside the old 5_000 ms client window was a
 * deadline INVERSION: a cold remote cache aborted the probe, which then landed
 * on the fail-closed shape and hid a healthy engine. 20 s leaves ~15 s for the
 * auth round trips + queueing on top of the server's own 5 s bound, while still
 * bounding the picker's spinner. The server caches its verdict (300 s positive
 * / 30 s negative), so this is the COLD path only.
 */
export const CLIENT_GLM_PROBE_TIMEOUT_MS = 20_000;

/** Probe wrapper matching the picker's needs (U-E4/U-E8). */
export async function glmAvailable(): Promise<boolean> {
  try {
    const res = await fetch("/api/extract/ocr", {
      signal: AbortSignal.timeout(CLIENT_GLM_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { available?: boolean };
    return json.available === true;
  } catch {
    return false;
  }
}

/**
 * Full probe payload for the picker + provider-aware caps (contract §4.7,
 * gate G7). The server caches its verdict (positive 300 s / negative 30 s) and
 * on the remote leg that verdict comes from a BILLED probe, so this is a cheap
 * read in the common case — never gate the UI on an uncached billed call.
 *
 * A probe that FAILS (non-OK response, throw, abort, unparseable body) reports
 * `provider: "unknown"` (defect #1). It must never assert `"local"`: doing so
 * made the client take the LOCAL per-page loop against a REMOTE server — N
 * billed `{image}` calls instead of ONE whole-document call, which is exactly
 * the 10-200x overspend gate G3 exists to prevent — and reported the local
 * 200-page cap for the metered leg. `glmExtract` refuses to run on "unknown".
 */
export async function glmEngineInfo(): Promise<GlmEngineInfo> {
  try {
    const res = await fetch("/api/extract/ocr", {
      signal: AbortSignal.timeout(CLIENT_GLM_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return unavailableEngineInfo();
    const json = (await res.json().catch(() => null)) as Partial<GlmEngineInfo> | null;
    if (json === null || typeof json !== "object") return unavailableEngineInfo();
    // A 200 that does not name a known leg is just as unusable as a failure:
    // the caps below are provider-DERIVED, so guessing a provider would guess
    // the caps too.
    const provider = resolveProvider(json.provider);
    if (provider === "unknown") return unavailableEngineInfo("error");
    return {
      available: json.available === true,
      reason: typeof json.reason === "string" && json.reason ? json.reason : "error",
      provider,
      maxPages: engineCap(
        json.maxPages,
        provider === "remote" ? MAX_OCR_PAGES_REMOTE : MAX_OCR_PAGES,
        1,
      ),
      // The byte caps are informational for the UI; an absent/invalid value
      // falls back to 0 (= unknown) rather than a fabricated allowance.
      maxImageBytes: engineCap(json.maxImageBytes, 0, 0),
      maxPdfBytes: engineCap(json.maxPdfBytes, 0, 0),
    };
  } catch {
    return unavailableEngineInfo();
  }
}

/** Only the two KNOWN legs are ever asserted; anything else is "unknown". */
function resolveProvider(value: unknown): OcrProvider {
  if (value === "remote") return "remote";
  if (value === "local") return "local";
  return "unknown";
}

/**
 * The fail-closed probe shape for a verdict that could NOT be obtained
 * (defect #1). `provider: "unknown"` is the honest answer, and `maxPages` is
 * `UNKNOWN_MAX_PAGES` (0) rather than the local 200 — reporting the local cap
 * for an unidentified leg was the same guess as reporting its provider.
 */
function unavailableEngineInfo(reason = "unreachable"): GlmEngineInfo {
  return {
    available: false,
    reason,
    provider: "unknown",
    maxPages: UNKNOWN_MAX_PAGES,
    maxImageBytes: 0,
    maxPdfBytes: 0,
  };
}

/** A finite numeric cap at or above `min`, else `fallback` (fail-closed). */
function engineCap(value: unknown, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) return fallback;
  return Math.floor(value);
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
/**
 * Wall-clock bound for the remote leg's SINGLE whole-document request. The
 * server's own upstream bound is 120 s, so this is slack for queueing, not a
 * second timeout policy; without it a hung fetch would hold the dialog open
 * until the 20-minute run budget expires.
 */
const REMOTE_DOCUMENT_TIMEOUT_MS = 5 * 60_000;

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

/** The server's remote 200 body (contract §4.5). */
export type RemoteOcrResponse = {
  text?: unknown;
  pages?: unknown;
  numPages?: unknown;
  degraded?: unknown;
  blank?: unknown;
  /** Present only on a non-200 typed failure body. */
  error?: unknown;
};

/** The real container of an upload, as determined from its leading bytes. */
export type RealFileKind = "pdf" | "image" | "unknown";

/** Enough bytes to cover every signature sniffed here (WebP needs 12). */
const SNIFF_HEAD_BYTES = 1024;

/**
 * Sniff the REAL container from the leading bytes (defect #5). A PDF is
 * identified by the `%PDF` marker (searched over the first 1 KB, because a
 * producer may prepend junk); images by the PNG/JPEG/WebP magic.
 *
 * Exported and pure so the routing decision is unit-testable without a File.
 */
export function sniffRealFileKind(head: Uint8Array): RealFileKind {
  if (head.length === 0) return "unknown";
  // `%PDF` anywhere in the probe window — never a substring match on a longer
  // sequence, since PDF junk-before-header is legal and this direction only
  // decides "treat as a PDF" (the route re-checks the byte-0 prefix).
  const probe = latin1(head);
  if (probe.includes("%PDF")) return "pdf";
  if (
    head.length >= 8 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) {
    return "image";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image";
  if (
    head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) {
    return "image";
  }
  return "unknown";
}

/** ASCII view of a byte window (signatures are all ASCII). */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * The kind to route a file under: the SNIFFED container when the bytes name one
 * (a `%PDF` file named `.png` is a PDF), else the declared type/extension.
 *
 * A declared-PDF whose bytes are neither a PDF nor an image is refused with the
 * typed `invalid_pdf` BEFORE any work: pdf.js would throw a raw
 * `InvalidPDFException` ("Invalid PDF structure.") that fell through to the
 * dialog's generic branch and surfaced an untranslated English library message
 * (defect #5). Same for a declared image whose bytes are neither — the route's
 * sniffer would 400 it as a generic `glm_error`, so the client refuses it with
 * a translated code instead.
 */
export async function resolveOcrFileKind(file: File): Promise<"pdf" | "image"> {
  const declaredPdf = isPdfInput(file);
  let real: RealFileKind = "unknown";
  try {
    const head = new Uint8Array(
      await file.slice(0, SNIFF_HEAD_BYTES).arrayBuffer(),
    );
    real = sniffRealFileKind(head);
  } catch {
    // A slice failure (detached blob) falls back to the declared type; the
    // route remains the authority and answers with a typed error.
    return declaredPdf ? "pdf" : "image";
  }
  if (real === "pdf") return "pdf";
  if (real === "image") return "image";
  // Bytes name nothing we can read. Only refuse a DECLARED type we can prove
  // wrong; an unreadable-but-declared-image file still gets its upload (the
  // route's allowlist owns that rule) rather than a new client-side veto.
  if (declaredPdf) throw new OcrPageError("invalid_pdf");
  return "image";
}

/** Is this input a PDF (by declared MIME or extension)? */
function isPdfInput(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

/**
 * OCR a file with GLM-OCR through the server proxy.
 *
 * LOCAL (default): images/PDF pages are rasterized and sent ONE AT A TIME
 * (vision-language models accept a single image per message; also preserves
 * per-page progress), each page released before the next is rendered. Returns
 * concatenated text with engine='glm' and index-aligned `pageTexts`.
 *
 * REMOTE (`opts.provider === "remote"`): ONE request for the WHOLE document —
 * no rasterization, the file's bytes go up as a data URL and the response's
 * `md_results` string is returned verbatim (minus fence-run noise) with
 * `pageTexts` UNDEFINED and `wholeDocumentRetry` set when the reading was
 * partial (gate G6).
 */
export async function glmExtract(
  file: File,
  onProgress?: (page: number, total: number) => void,
  opts: {
    pagesToRetry?: number[];
    /** Re-run the WHOLE document (remote whole-doc retry, gate G6). */
    retryWhole?: boolean;
    /**
     * Provider + caps observed from `glmEngineInfo()`. Omitted = local (the
     * direct-caller default, unchanged). `"unknown"` (a failed probe) is
     * REFUSED — see the guard below.
     */
    provider?: OcrProvider;
    maxPages?: number;
  } = {},
): Promise<ExtractionResult> {
  // Defect #1: a probe that could not identify the leg must NOT be treated as
  // local. Defaulting to local ran the per-page loop (N rasterized `{image}`
  // calls) against a REMOTE server — a 12-page deck billed 12 calls instead of
  // one — and reported the local 200-page cap on the metered leg. Refusing is
  // the honest failure: the engine could not be reached or identified, which
  // is precisely what `glm_model_unavailable` means to the dialog.
  if (opts.provider === "unknown") {
    throw new OcrPageError("glm_model_unavailable");
  }
  // Fail-closed: only the exact "remote" value selects the metered branch;
  // omitted/undefined is the local default (backwards compatible for callers
  // that never probed — e.g. the pre-toggle direct call sites).
  if (opts.provider === "remote") return glmExtractRemote(file, onProgress, opts);

  // Defect #5: route on the REAL container, not the declared name/type, so a
  // PDF named `.png` is rasterized as the PDF it is (the old code took the
  // image branch, labelled it `image/png`, and let the route's sniffer reject
  // it as a generic `glm_error`) and a non-PDF named `.pdf` fails with the
  // typed `invalid_pdf` instead of pdf.js's raw English `InvalidPDFException`.
  const isPdf = (await resolveOcrFileKind(file)) === "pdf";
  // audit-3 F-F2: a retry targets ONLY the previously-failed pages, so it does
  // not re-spend the freshly-reset budget on pages that already succeeded.
  // `retryWhole` is meaningless here (this leg is already page-granular) and is
  // ignored by design.
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
 * REMOTE leg (gate G3/G6): ONE request per document.
 *
 * There is no rasterization here — the file's own bytes are uploaded, because
 * the Z.ai `layout_parsing` endpoint accepts a whole PDF (≤50 MB / ≤30 pages
 * interim) and bills per token. The per-page loop would be a 10-200× overspend
 * AND would trip the per-user window mid-deck.
 *
 * The PDF page cap is checked client-side with pdf.js BEFORE any upload, so an
 * over-cap deck costs nothing (the server re-checks with a cheap lower bound
 * and would 413 `glm_pages_exceeded` anyway). `retryWhole` needs no special
 * handling: this branch has exactly one shape, so a retry IS the same call.
 */
async function glmExtractRemote(
  file: File,
  onProgress?: (page: number, total: number) => void,
  opts: { maxPages?: number } = {},
): Promise<ExtractionResult> {
  // Defect #5: route on the REAL container. A `%PDF` file named `.png` used to
  // take the image branch, get labelled `image/png`, and be rejected by the
  // route's sniffer as a generic `glm_error`; a non-PDF named `.pdf` made
  // pdf.js throw a raw `InvalidPDFException` that surfaced as an untranslated
  // English library string. `resolveOcrFileKind` reads the leading bytes (which
  // this path reads anyway) and raises the typed `invalid_pdf` instead.
  const kind = await resolveOcrFileKind(file);
  const isPdf = kind === "pdf";
  const maxPages =
    typeof opts.maxPages === "number" && Number.isFinite(opts.maxPages) && opts.maxPages > 0
      ? Math.floor(opts.maxPages)
      : MAX_OCR_PAGES_REMOTE;

  if (isPdf) {
    const numPages = await readPdfPageCount(file);
    // Fail-closed BEFORE any upload/spend: an over-cap deck is refused here,
    // not paid for and then refused by the server.
    assertRemotePageCap(numPages, maxPages);
  } else {
    // Same decompression-bomb gate as every other image path.
    await assertSafeImageDimensions(file);
  }

  // One request = one unit of progress. The dialog's bar shows "1 of 1".
  onProgress?.(1, 1);

  const dataUrl = await remoteFileDataUrl(file, isPdf);
  const json = await postRemoteDocument(dataUrl, kind);
  return buildRemoteResult(json);
}

/** pdf.js page count, with the document destroyed immediately afterwards.
 *
 *  A malformed PDF is mapped to the typed `invalid_pdf` (defect #5): pdf.js
 *  throws `InvalidPDFException` with an English library message ("Invalid PDF
 *  structure.") that the dialog could only render untranslated. */
async function readPdfPageCount(file: File): Promise<number> {
  const pdfjs = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  // Node has no worker thread / DOM — same settings `native.ts` uses, so the
  // unit suite can read a page count without a browser. In the browser the
  // worker stays enabled (a page count still parses the cross-reference
  // table, which must not block the main thread on a large deck).
  const node = typeof window === "undefined";
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(arrayBuffer),
      disableWorker: node,
      useWorkerFetch: !node,
      isEvalSupported: false,
      useSystemFonts: !node,
    } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;
  } catch (err) {
    if (isInvalidPdfError(err)) throw new OcrPageError("invalid_pdf");
    throw err;
  }
  try {
    return doc.numPages;
  } finally {
    await destroyPdf(doc);
  }
}

/** pdf.js names every malformed-document failure `InvalidPDFException`
 *  (`name` survives the bundled build; the class identity does not). */
function isInvalidPdfError(err: unknown): boolean {
  return err instanceof Error && err.name === "InvalidPDFException";
}

/**
 * Client-side page-cap decision for the remote leg (gate G3). Exported so the
 * decision is unit-testable without pdf.js or a network stub.
 */
export function assertRemotePageCap(numPages: number, maxPages: number): void {
  if (numPages > maxPages) throw new OcrPageError("glm_pages_exceeded");
}

/**
 * POST the whole document as `{file, kind}` (contract §4.5 — the remote shape;
 * the local leg's `{image}` is deliberately NOT used here).
 */
async function postRemoteDocument(
  dataUrl: string,
  kind: "pdf" | "image",
): Promise<RemoteOcrResponse> {
  let res: Response;
  try {
    res = await fetch("/api/extract/ocr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: dataUrl, kind }),
      signal: AbortSignal.timeout(REMOTE_DOCUMENT_TIMEOUT_MS),
    });
  } catch (err) {
    // Our own abort is a timeout (the server has a 120 s upstream bound);
    // anything else is a transport failure. Neither is a "bad page".
    const aborted =
      err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    throw new OcrPageError(aborted ? "glm_timeout" : "glm_error");
  }

  const json = (await res.json().catch(() => null)) as RemoteOcrResponse | null;
  // ONE request = total failure on non-200 (the local leg's `total <= 1`
  // semantics): surface the server's typed code so the dialog can name it.
  if (!res.ok || json === null || typeof json.text !== "string") {
    const code = typeof json?.error === "string" && json.error ? json.error : "glm_error";
    throw new OcrPageError(code);
  }
  return json;
}

/**
 * Shape a remote 200 body into an `ExtractionResult` (gate G6). Exported and
 * pure so the shaping rules are testable without pdf.js or fetch.
 *
 * Load-bearing: `pageTexts` is NEVER set — `md_results` is one markdown string
 * with no page boundaries, and splitting it into fake pages would silently
 * corrupt the corpus. `wholeDocumentRetry` marks a DEGRADED reading (an
 * upstream error code rode alongside usable text), which the dialog retries as
 * a unit with an explicit re-bill warning.
 *
 * PAGE COUNT (defect #7): the server reports `numPages: null` AND `pages: null`
 * when `data_info.num_pages` is genuinely absent. The old `?? 1` fabricated a
 * 1-page document, which the dialog's density heuristic then divided by — a
 * 300-page deck read as 300x denser than it is. `pages: 0` now means "the
 * engine did not report a page count"; `pageCountKnown` says so explicitly and
 * the dialog's math (guarded on `totalAttemptedPages > 0`) stands down.
 */
export function buildRemoteResult(json: RemoteOcrResponse): ExtractionResult {
  const text = typeof json.text === "string" ? json.text : "";
  const numPages = positiveNumber(json.numPages) ?? positiveNumber(json.pages);
  const pageCountKnown = numPages !== null;
  const degraded = json.degraded === true;
  const blank = json.blank === true;

  return {
    text: sanitizeGlmMarkdown(text),
    // 0 = unknown, never a fabricated 1.
    pages: numPages ?? 0,
    engine: "glm",
    provider: "remote",
    // The density heuristic divides by this: the document's real page count
    // (numPages) when reported, else 0 = "unknown" (the dialog's
    // `totalAttemptedPages > 0` guard is what keeps its math honest).
    totalPages: numPages ?? 0,
    // The whole document was attempted in one request. `failedPages` stays
    // undefined — no page attribution exists, which is exactly why the retry
    // unit is the document (G6).
    pagesAttempted: numPages ?? 0,
    ...(pageCountKnown ? {} : { pageCountKnown: false }),
    ...(degraded || blank ? { lowConfidence: true } : {}),
    ...(degraded ? { wholeDocumentRetry: true } : {}),
  };
}

/** A finite number > 0, else null (page counts are never 0 or NaN). */
function positiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

/**
 * Data URL for the remote upload. The MIME is derived from the FILE (declared
 * type / extension), never taken from `FileReader`'s default: a PDF whose
 * `type` is empty would otherwise be serialized as
 * `data:application/octet-stream;base64,…`, which the route's `data:` MIME
 * allowlist rejects as `glm_error`.
 *
 * The bytes come from `file.arrayBuffer()` (not FileReader) so the whole remote
 * leg is exercisable in the Node unit suite, and an empty file is refused
 * before it is uploaded (fail-closed; the route would 400 it anyway).
 */
async function remoteFileDataUrl(file: File, isPdf: boolean): Promise<string> {
  const mime = isPdf ? "application/pdf" : imageMimeFor(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) throw new OcrPageError("glm_error");
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/** Chunk size for `String.fromCharCode` — large enough to be fast, small
 *  enough that a 25 MB file cannot blow the argument-count limit. */
const BASE64_CHUNK = 0x8000;

/** Base64-encode bytes without a FileReader (works in browser + Node). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

/** The route's image allowlist (png/jpeg/webp), resolved from type + name. */
function imageMimeFor(file: File): string {
  const declared = (file.type || "").toLowerCase();
  if (declared === "image/png" || declared === "image/jpeg" || declared === "image/webp") {
    return declared;
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  // Unknown: pass the declared type through and let the route's allowlist
  // reject it (fail-closed at the boundary that owns the rule).
  return declared || "application/octet-stream";
}

/**
 * Clean LOCAL GLM-OCR output. The model sometimes emits a long run of
 * markdown-fence noise (repeated ``` ``` ``` ...) after the real transcription
 * — it loops on the closing delimiter. Collapse any run of 3+ consecutive fence
 * lines down to a single fence so the extracted text isn't polluted.
 */
export function sanitizeGlmText(text: string): string {
  return text.replace(/(?:```\s*){3,}/g, "```\n");
}

/**
 * 3+ fence tokens separated only by whitespace and/or blank lines.
 *
 * This is `sanitizeGlmText`'s rule WIDENED to tolerate the newlines a markdown
 * emitter puts between the fences — the remote model loops on the closing
 * delimiter and emits the noise both as ` ``` ``` ``` ` and as one fence per
 * line with blank lines between them.
 *
 * DEFECT #3/#4 REWRITE. The old implementation was a single regex
 * (`(?:```[ \t]*(?:\r?\n[ \t]*)*){3,}`) and it CORRUPTED real markdown, proven
 * on two inputs:
 *   - `"````\n```\n```\n```\n````"` (a 4-backtick block whose content is three
 *     fence-only lines) collapsed to `"````\n"` — the CONTENT was eaten;
 *   - `"```\n```\n\n```\n```\n\n```\n```"` (three distinct empty code blocks)
 *     collapsed to `"```\n"`.
 * It was also WEAKER than `sanitizeGlmText` on non-LF separators: the text
 * path's `\s` covers CR, NBSP, form-feed and U+2028, while the old markdown
 * pattern only accepted `[ \t]` + CRLF, so a CR-only/NBSP-separated run was
 * left in the corpus.
 *
 * The rule is now a small scanner over the text's LINES, and a run is collapsed
 * only when ALL of these hold:
 *  1. the run holds >= 3 fence tokens (a bare 2-fence block is a real code
 *     block: open + close);
 *  2. the run is not ENCLOSED by a longer fence — a token strictly between two
 *     equal-length fences longer than itself is CONTENT (defect #3), so a
 *     ```` block containing ``` lines survives;
 *  3. the run is not a sequence of >= 2 blank-line-separated groups that are
 *     each exactly one same-length open+close PAIR — i.e. real (empty) code
 *     blocks (defect #3's second input).
 * Separators are the FULL whitespace class (defect #4): `\s` plus the explicit
 * NBSP-family/word-joiner characters, with LF/CR/CRLF/FF/VT/U+2028/U+2029 all
 * ending a line.
 *
 * Only backticks and whitespace are ever consumed, so tables (`|`-rows), layout
 * tags (`<table>`, `<b>`, …), headings and inline code spans pass through
 * byte-for-byte. Do NOT reuse `sanitizeGlmText`'s "strip noise" intent here with
 * a wider net: markdown is the payload of the remote leg, so anything that eats
 * `|`, `#` or angle brackets silently corrupts the corpus.
 */
export function sanitizeGlmMarkdown(text: string): string {
  if (!text.includes("```")) return text;
  const runs = findFenceRuns(text);
  let out = text;
  // Replace back-to-front so earlier offsets stay valid. Every offset up to the
  // run's end is identical in `out` and `text` (modifications only ever happen
  // strictly AFTER a later run's start), so the offsets are computed on `text`
  // and applied to `out`.
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (!shouldCollapseFenceRun(run)) continue;
    // Swallow the whitespace trailing the last token (rest of its line plus one
    // line terminator) so the collapse leaves ONE clean fence line instead of an
    // extra blank one — the old regex's behaviour.
    let end = run.end;
    while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
    end += lineTerminatorLengthAt(text, end);
    out = out.slice(0, run.start) + "```\n" + out.slice(end);
  }
  return out;
}

/** Length of the line terminator starting at `at`, or 0 when there is none. */
function lineTerminatorLengthAt(text: string, at: number): number {
  const ch = text[at];
  if (ch === "\r") return text[at + 1] === "\n" ? 2 : 1;
  if (ch === "\n" || ch === "\u2028" || ch === "\u2029" || ch === "\f" || ch === "\v") return 1;
  return 0;
}

/** A maximal run of whitespace-separated fence tokens. */
type FenceRun = {
  /** Absolute offset of the first token. */
  start: number;
  /** Absolute offset just past the last token. */
  end: number;
  /** Token lengths, in document order. */
  lengths: number[];
  /** Indices into `lengths`, grouped by "no blank line between them". */
  groups: number[][];
};

/** Line terminators: LF, CR, CRLF, plus the Unicode/control separators that
 *  end a line in the widened class (defect #4). */
const LINE_TERMINATOR = /\r\n|[\n\r\u2028\u2029\f\v]/;
/** A run of >= 3 backticks — the only thing this sanitizer looks for. */
const FENCE_TOKEN = /`{3,}/g;

/** Whitespace-only (a "blank line" for run-grouping purposes). */
function isBlankLine(line: string): boolean {
  return /^\s*$/.test(line);
}

/**
 * Every maximal fence run in the text, with its tokens and adjacency groups.
 * A run continues across BLANK lines (the remote emitter's shape) and ends at
 * the first line carrying any non-whitespace, non-fence character.
 */
function findFenceRuns(text: string): FenceRun[] {
  const runs: FenceRun[] = [];
  let current: FenceRun | null = null;
  // True when the previous line contributed tokens, so this line's tokens join
  // the same adjacency group.
  let prevLineHadTokens = false;

  for (const line of splitLines(text)) {
    const tokens = fenceTokensInLine(line.text, line.start);
    if (tokens.length > 0) {
      if (current === null) {
        current = { start: tokens[0].start, end: 0, lengths: [], groups: [] };
        runs.push(current);
        prevLineHadTokens = false;
      }
      if (!prevLineHadTokens) current.groups.push([]);
      for (const token of tokens) {
        const index = current.lengths.length;
        current.lengths.push(token.len);
        current.groups[current.groups.length - 1].push(index);
      }
      current.end = tokens[tokens.length - 1].end;
      prevLineHadTokens = true;
      continue;
    }
    if (isBlankLine(line.text)) {
      // A blank line breaks adjacency but keeps the run alive.
      if (current !== null) prevLineHadTokens = false;
      continue;
    }
    // Real content ends the run.
    current = null;
    prevLineHadTokens = false;
  }
  return runs;
}

/** Split into lines, carrying each line's absolute start offset. */
function splitLines(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let start = 0;
  for (const match of text.matchAll(new RegExp(LINE_TERMINATOR, "g"))) {
    const at = match.index ?? 0;
    out.push({ text: text.slice(start, at), start });
    start = at + match[0].length;
  }
  out.push({ text: text.slice(start), start });
  return out;
}

/**
 * The fence tokens on a line, or [] when the line is not fence-only. A line
 * qualifies when everything OUTSIDE its tokens is whitespace, which is what
 * makes the rule content-safe: `| a | b |` and `# Heading` never qualify.
 */
function fenceTokensInLine(
  line: string,
  offset: number,
): { start: number; end: number; len: number }[] {
  const tokens: { start: number; end: number; len: number }[] = [];
  let outside = "";
  let cursor = 0;
  for (const match of line.matchAll(new RegExp(FENCE_TOKEN, "g"))) {
    const at = match.index ?? 0;
    outside += line.slice(cursor, at);
    cursor = at + match[0].length;
    tokens.push({ start: offset + at, end: offset + cursor, len: match[0].length });
  }
  if (tokens.length === 0) return [];
  outside += line.slice(cursor);
  return isBlankLine(outside) ? tokens : [];
}

/**
 * The collapse decision (see `sanitizeGlmMarkdown` for the three conditions).
 * Exported for tests so the rule can be pinned without round-tripping text.
 */
export function shouldCollapseFenceRun(run: FenceRun): boolean {
  const n = run.lengths.length;
  if (n < 3) return false;

  // (2) Content enclosed by a LONGER fence. A token strictly between two
  // equal-length fences that are both longer than it cannot close either, so it
  // is inside a real code block — e.g. the three ``` lines in
  // "````\n```\n```\n```\n````".
  const enclosed = new Set<number>();
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      if (run.lengths[a] !== run.lengths[b]) continue;
      for (let i = a + 1; i < b; i++) {
        if (run.lengths[i] < run.lengths[a]) enclosed.add(i);
      }
    }
  }
  if (n - enclosed.size < 3) return false;

  // (3) Real EMPTY code blocks: >= 2 blank-line-separated groups, each exactly
  // one same-length open+close pair — e.g. "```\n```\n\n```\n```\n\n```\n```".
  // A single group is NOT this shape: 3-7 adjacent fences are the noise the
  // local leg already collapsed, and they must keep collapsing.
  if (
    run.groups.length >= 2 &&
    run.groups.every(
      (g) => g.length === 2 && run.lengths[g[0]] === run.lengths[g[1]],
    )
  ) {
    return false;
  }

  // (1) satisfied by the guard above; collapse the noise.
  return true;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}
