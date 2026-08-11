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
  MAX_EXTRACT_CHARS,
  MIN_CHARS_PER_PAGE,
  type ExtractionResult,
} from "@/lib/extract/types";

export type OcrProgress = (page: number, total: number) => void;

/**
 * Render a File (PDF/image) to PNG pages and OCR them with tesseract.js.
 * Only meaningful in the browser (uses canvas/Image). Returns the concatenated
 * text with engine='tesseract'.
 */
export async function tesseractExtract(
  file: File,
  onProgress?: OcrProgress,
): Promise<ExtractionResult> {
  const Tesseract = await import("tesseract.js");

  // PDFs must be rasterized page-by-page first; images OCR directly.
  const pages = await rasterizeToImages(file, onProgress);

  const parts: string[] = [];
  let recognizedChars = 0;
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(i + 1, pages.length);
    const { data } = await Tesseract.recognize(pages[i].dataUrl, "eng", {
      logger: undefined,
    });
    parts.push(data.text);
    recognizedChars += data.text.length;
    if (recognizedChars > MAX_EXTRACT_CHARS * 2) break; // safety backstop
  }

  let text = parts.join("\n\n").trim();
  if (text.length > MAX_EXTRACT_CHARS) text = text.slice(0, MAX_EXTRACT_CHARS);

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

  const pdfjs = await import("pdfjs-dist");
  const arrayBuffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  try {
    const total = doc.numPages;
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
    await doc.loadingTask.destroy().catch(() => undefined);
  }
}
