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
 * Error contract (pinned by GenerateFromFileDialog's i18n mapping):
 * `glm_model_unavailable` / `glm_timeout` / `glm_error`.
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

async function rasterizePdfToPngs(file: File): Promise<{ dataUrl: string; page: number }[]> {
  const pdfjs = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  try {
    const out: { dataUrl: string; page: number }[] = [];
    // Cap pages (MAX_OCR_PAGES) to bound browser CPU/memory on huge scans.
    const total = Math.min(doc.numPages, MAX_OCR_PAGES);
    for (let i = 1; i <= total; i++) {
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
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      out.push({ dataUrl: canvas.toDataURL("image/png"), page: i });
    }
    return out;
  } finally {
    await destroyPdf(doc);
  }
}

// Overall wall-clock budget for a whole GLM OCR run (all pages up to 200).
const GLM_OCR_BUDGET_MS = 20 * 60_000;
const PAGE_TIMEOUT_MS = 90_000;

/** Page OCR under the run's remaining wall-clock budget. */
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
    throw new Error(json?.error ?? "glm_error");
  }
  return json.text;
}

/**
 * OCR a file with GLM-OCR through the server proxy. Images/PDF pages are
 * sent one at a time (vision-language models accept a single image per
 * message; also preserves per-page progress). Returns concatenated text with
 * engine='glm'.
 */
export async function glmExtract(
  file: File,
  onProgress?: (page: number, total: number) => void,
): Promise<ExtractionResult> {
  let images: { dataUrl: string; page: number }[];
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    images = await rasterizePdfToPngs(file);
  } else {
    // Same decompression-bomb gate as the Tesseract path: reject absurd
    // dimensions before encoding/uploading.
    await assertSafeImageDimensions(file);
    images = [{ dataUrl: await fileToDataUrl(file), page: 1 }];
  }

  const deadline = Date.now() + GLM_OCR_BUDGET_MS;
  const parts: string[] = [];
  let successCount = 0;
  for (let i = 0; i < images.length; i++) {
    onProgress?.(i + 1, images.length);
    const remaining = Math.max(1_000, deadline - Date.now());
    try {
      const text = await ocrPage(images[i].dataUrl, remaining);
      parts.push(text);
      successCount++;
    } catch (err) {
      console.warn(`[GLM-OCR] Error on page ${i + 1}:`, err);
      // If all pages fail, error out; if partial pages fail, keep existing.
      if (images.length === 1) throw err;
    }
  }

  if (successCount === 0 && images.length > 0) {
    throw new Error("glm_error");
  }

  // Partial runs are honest: report the pages that actually produced text
  // (not attempted count — the density heuristic consumes this number) and
  // flag low confidence so the caller knows pages were lost mid-run.
  const partial = successCount < images.length;
  let text = parts.join("\n\n").trim();
  text = sanitizeGlmText(text);
  return {
    text,
    pages: successCount,
    engine: "glm",
    ...(partial ? { lowConfidence: true } : {}),
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
