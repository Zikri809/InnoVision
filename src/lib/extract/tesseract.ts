/**
 * Tesseract.js client-side OCR — the DEFAULT engine (PLAN §3.1).
 *
 * Runs entirely in the lecturer's browser (WASM), $0, zero setup. Accuracy is
 * weaker on formulas/tables — the UI offers GLM-OCR as the opt-in upgrade.
 *
 * Asset paths default to the official CDN now; self-hosting under /public is a
 * P9 task (venue/edu Wi-Fi often blocks storage.googleapis.com).
 *
 * Memory model (audit-3 F-F3): rasterization is STREAMED — one page is
 * rendered, encoded, recognized, and released before the next page is
 * rendered, so peak memory is a single canvas + base64 string rather than the
 * whole deck (~0.2-1 GB at 200 pages before this change).
 */

import {
  MAX_OCR_PAGES,
  MIN_CHARS_PER_PAGE,
  type ExtractionResult,
} from "@/lib/extract/types";
import { destroyPdf, loadPdfJs } from "@/lib/extract/pdf";
import { assertSafeImageDimensions } from "@/lib/extract/image-guard";

export type OcrProgress = (page: number, total: number) => void;

/**
 * Render a File (PDF/image) to PNG pages and OCR them with tesseract.js.
 * Only meaningful in the browser (uses canvas/Image). Returns the concatenated
 * text with engine='tesseract'.
 */
export async function tesseractExtract(
  file: File,
  onProgress?: OcrProgress,
  languages = "eng+msa",
): Promise<ExtractionResult> {
  const Tesseract = await import("tesseract.js");

  // Single worker reused across all pages — in tesseract.js v7, recognize()
  // internally creates+terminates a worker per call, which re-fetches the WASM
  // core (~MB) and traineddata (~4-11 MB) on every page. Creating one worker
  // here and reusing it is the supported pattern.
  //
  // `logger` MUST be a function — tesseract.js v7's message handler invokes
  // `logger({...})` unconditionally and crashes with `TypeError: logger is
  // not a function` when undefined.
  let worker: Tesseract.Worker;
  try {
    worker = await Tesseract.createWorker(languages, 1, {
      logger: () => {},
    });
  } catch {
    // Fallback to English only if combined data is unavailable
    worker = await Tesseract.createWorker("eng", 1, {
      logger: () => {},
    });
  }

  // PDFs must be rasterized page-by-page first; images OCR directly. The page
  // source is a generator so each rasterized page is dropped before the next
  // render (audit-3 F-F3).
  let total = 0;
  const pages = pageSource(file, (n) => {
    total = n;
  });

  const parts: string[] = [];
  let attempted = 0;
  try {
    for (;;) {
      const next = await pages.next();
      if (next.done) break;
      attempted += 1;
      onProgress?.(attempted, total);
      const { data } = await worker.recognize(next.value.dataUrl);
      parts.push(data.text);
    }
  } finally {
    // Close the page source BEFORE terminating the worker: its `finally` is
    // what zeroes the canvas and calls page.cleanup()/destroyPdf(), and it
    // only runs when the generator completes or is explicitly returned. A
    // throw from worker.recognize() would otherwise leave a 4096px canvas and
    // the pdf.js document alive until GC (adversarial review A1).
    try {
      await pages.return(undefined as never);
    } catch {
      // Cleanup failure must not mask the original error.
    }
    await worker.terminate().catch(() => undefined);
  }

  const text = parts.join("\n\n").trim();

  const nonEmpty = parts.filter((p) => p.trim().length > 0).length;
  const avgPerPage = nonEmpty > 0 ? text.length / nonEmpty : 0;
  const lowConfidence = nonEmpty > 0 && avgPerPage < MIN_CHARS_PER_PAGE;

  return { text, pages: attempted, engine: "tesseract", lowConfidence };
}

type RenderedPage = { dataUrl: string; width: number; height: number };

async function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image_load_failed"));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const MAX_CANVAS_DIMENSION = 4096;

/**
 * Yield rendered PNG pages for a PDF (via pdf.js render) or the single raw
 * image for an image file. Streaming is load-bearing: the caller consumes
 * each page before the generator renders the next (audit-3 F-F3).
 * `onTotal` reports the capped page count before the first yield.
 */
async function* pageSource(
  file: File,
  onTotal: (total: number) => void,
): AsyncGenerator<RenderedPage> {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    // Reject absurd dimensions before the browser decodes the bitmap.
    await assertSafeImageDimensions(file);
    onTotal(1);
    const img = await loadImageFromFile(file);
    let targetWidth = img.naturalWidth;
    let targetHeight = img.naturalHeight;
    const maxDim = Math.max(targetWidth, targetHeight);
    if (maxDim > MAX_CANVAS_DIMENSION) {
      const scale = MAX_CANVAS_DIMENSION / maxDim;
      targetWidth = Math.floor(targetWidth * scale);
      targetHeight = Math.floor(targetHeight * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas_unavailable");
    try {
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
      yield { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
    return;
  }

  const pdfjs = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  try {
    // Cap pages (MAX_OCR_PAGES) to bound browser CPU; memory is bounded by the
    // streaming consumer, not by this cap.
    // `progress.total` reflects the capped count so the dialog bar matches.
    const total = Math.min(doc.numPages, MAX_OCR_PAGES);
    onTotal(total);
    for (let i = 1; i <= total; i++) {
      const page = await doc.getPage(i);
      let viewport = page.getViewport({ scale: 1.5 });
      const maxDim = Math.max(viewport.width, viewport.height);
      if (maxDim > MAX_CANVAS_DIMENSION) {
        const scale = (MAX_CANVAS_DIMENSION / maxDim) * 1.5;
        viewport = page.getViewport({ scale });
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas_unavailable");
      try {
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        yield {
          dataUrl: canvas.toDataURL("image/png"),
          width: canvas.width,
          height: canvas.height,
        };
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    }
  } finally {
    await destroyPdf(doc);
  }
}
