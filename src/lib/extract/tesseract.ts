/**
 * Tesseract.js client-side OCR — the DEFAULT engine (PLAN §3.1).
 *
 * Runs entirely in the lecturer's browser (WASM), $0, zero setup. Accuracy is
 * weaker on formulas/tables — the UI offers GLM-OCR as the opt-in upgrade.
 *
 * Asset paths default to the official CDN now; self-hosting under /public is a
 * P9 task (venue/edu Wi-Fi often blocks storage.googleapis.com).
 */

import {
  MAX_OCR_PAGES,
  MIN_CHARS_PER_PAGE,
  type ExtractionResult,
} from "@/lib/extract/types";
import { destroyPdf, loadPdfJs } from "@/lib/extract/pdf";

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

  // PDFs must be rasterized page-by-page first; images OCR directly.
  const pages = await rasterizeToImages(file, onProgress);

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


  const parts: string[] = [];
  try {
    for (let i = 0; i < pages.length; i++) {
      onProgress?.(i + 1, pages.length);
      const { data } = await worker.recognize(pages[i].dataUrl);
      parts.push(data.text);
    }
  } finally {
    await worker.terminate().catch(() => undefined);
  }

  let text = parts.join("\n\n").trim();

  const nonEmpty = parts.filter((p) => p.trim().length > 0).length;
  const avgPerPage = nonEmpty > 0 ? text.length / nonEmpty : 0;
  const lowConfidence = nonEmpty > 0 && avgPerPage < MIN_CHARS_PER_PAGE;

  return { text, pages: pages.length, engine: "tesseract", lowConfidence };
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

/** Rasterize a PDF (via pdf.js render) or return the raw image for an image file. */
async function rasterizeToImages(
  file: File,
  onProgress?: OcrProgress,
): Promise<RenderedPage[]> {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    const img = await loadImageFromFile(file);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas_unavailable");
    ctx.drawImage(img, 0, 0);
    return [{ dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height }];
  }

  const pdfjs = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  try {
    // Cap pages (MAX_OCR_PAGES) to bound browser CPU/memory on huge scans.
    // `progress.total` reflects the capped count so the dialog bar matches.
    const total = Math.min(doc.numPages, MAX_OCR_PAGES);
    const pages: RenderedPage[] = [];
    for (let i = 1; i <= total; i++) {
      onProgress?.(i, total);
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas_unavailable");
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      pages.push({
        dataUrl: canvas.toDataURL("image/png"),
        width: canvas.width,
        height: canvas.height,
      });
    }
    return pages;
  } finally {
    await destroyPdf(doc);
  }
}
