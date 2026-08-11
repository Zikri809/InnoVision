/**
 * Cloud vision OCR — opt-in, costs tokens (PLAN §3.1).
 *
 * The lecturer's browser rasterizes PDF pages to base64 PNGs and POSTs them in
 * sequential batches of ≤3 to /api/ocr/vision (Vercel 4.5 MB body cap). The
 * route forwards to the configured vision LLM and returns markdown-ish text.
 * Images are never stored anywhere.
 */

import {
  batch,
  MAX_EXTRACT_CHARS,
  MAX_IMAGE_BASE64_CHARS,
  MAX_VISION_PAGES,
  type ExtractionResult,
} from "@/lib/extract/types";

export type VisionOcrConfig = {
  /** Base path of the API, e.g. '' (same origin). Overridable in tests. */
  endpoint?: string;
};

async function rasterizeToBase64(file: File, maxPages: number): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist");
  const arrayBuffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  try {
    const out: string[] = [];
    const total = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= total; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas_unavailable");
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      out.push(canvas.toDataURL("image/png"));
    }
    return out;
  } finally {
    await doc.loadingTask.destroy().catch(() => undefined);
  }
}

/**
 * OCR a file with the cloud vision route. PDFs are rasterized client-side and
 * sent in sequential ≤3-page batches; images are sent as a single batch.
 * Progress fires per batch.
 */
export async function visionExtract(
  file: File,
  cfg: VisionOcrConfig = {},
  onProgress?: (done: number, total: number) => void,
): Promise<ExtractionResult> {
  const endpoint = cfg.endpoint ?? "/api/ocr/vision";
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

  let images: string[];
  if (isPdf) {
    images = await rasterizeToBase64(file, MAX_VISION_PAGES);
  } else {
    images = [await fileToDataUrl(file)];
  }

  const batches = batch(images, MAX_VISION_PAGES);
  const parts: string[] = [];
  let done = 0;
  for (const group of batches) {
    onProgress?.(done, batches.length);
    // Client-side size guard (server also enforces).
    if (group.some((b) => b.length > MAX_IMAGE_BASE64_CHARS)) {
      throw new Error("vision_image_too_large");
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images: group }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new Error(body.error === "rate_limited" ? "vision_rate_limited" : "vision_http_error");
    }
    const data = (await res.json()) as { text?: string };
    parts.push(data.text ?? "");
    done += group.length;
  }

  let text = parts.join("\n\n").trim();
  if (text.length > MAX_EXTRACT_CHARS) text = text.slice(0, MAX_EXTRACT_CHARS);
  return { text, pages: images.length, engine: "vision" };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}
