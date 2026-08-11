/**
 * GLM-OCR via local Ollama — opt-in high-accuracy engine (PLAN §3.1).
 *
 * ⚠️ GLM-OCR is a vision-language CHAT model, not a strict OCR API — it must
 * be prompted to transcribe. Availability is gated behind `probeGlm()`; the
 * engine picker only shows it when the probe finds the model locally.
 *
 * Client-only by design: the lecturer's browser talks directly to their own
 * Ollama (localhost). The server NEVER proxies this endpoint (SSRF guard).
 */

import { MAX_EXTRACT_CHARS, MAX_OCR_PAGES, type ExtractionResult } from "@/lib/extract/types";
import { httpChatCompletions, probeOllamaModel } from "@/lib/ai/http-compat";
import { destroyPdf, loadPdfJs } from "@/lib/extract/pdf";

export type GlmOcrConfig = {
  baseUrl: string; // ROOT URL, e.g. http://localhost:11434
  model: string;
};

export { probeOllamaModel };

/** Probe wrapper matching the picker's needs (U-E4/U-E8). */
export async function glmAvailable(cfg: GlmOcrConfig): Promise<boolean> {
  return probeOllamaModel({ baseUrl: cfg.baseUrl, model: cfg.model });
}

/** Rasterize a PDF to base64 PNG pages in the browser. */
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
      const viewport = page.getViewport({ scale: 2 });
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

const GLM_TRANSCRIBE_PROMPT =
  "You are an OCR engine. Transcribe ALL visible text from this page image " +
  "faithfully, preserving structure (headings, bullets, tables as text). " +
  "Output ONLY the transcribed text, no commentary.";

// Overall wall-clock budget for a whole GLM OCR run (all pages). Each page
// call has its own 90s timeout, but a 50-page PDF would otherwise run
// unbounded sequentially — this caps the total so the dialog can't hang.
const GLM_OCR_BUDGET_MS = 5 * 60_000;

/**
 * OCR a file with the local GLM-OCR model. Images/PDF pages are sent one at a
 * time (vision-language models accept a single image per message). Returns
 * concatenated text with engine='glm'.
 */
export async function glmExtract(
  file: File,
  cfg: GlmOcrConfig,
  onProgress?: (page: number, total: number) => void,
): Promise<ExtractionResult> {
  const available = await glmAvailable(cfg);
  if (!available) {
    throw new Error("glm_model_unavailable");
  }

  let images: { dataUrl: string; page: number }[];
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    images = await rasterizePdfToPngs(file);
  } else {
    images = [{ dataUrl: await fileToDataUrl(file), page: 1 }];
  }

  const deadline = Date.now() + GLM_OCR_BUDGET_MS;
  const parts: string[] = [];
  for (let i = 0; i < images.length; i++) {
    onProgress?.(i + 1, images.length);
    const remaining = Math.max(1_000, deadline - Date.now());
    const res = await httpChatCompletions({
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      messages: [
        { role: "system", content: GLM_TRANSCRIBE_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe this page:" },
            { type: "image_url", image_url: { url: images[i].dataUrl } },
          ] as unknown as string,
        },
      ],
      maxTokens: 2000,
      timeoutMs: Math.min(90_000, remaining),
    });
    if (!res.ok) throw new Error(res.error === "timeout" ? "glm_timeout" : "glm_error");
    parts.push(res.text);
  }

  let text = parts.join("\n\n").trim();
  text = sanitizeGlmText(text);
  if (text.length > MAX_EXTRACT_CHARS) text = text.slice(0, MAX_EXTRACT_CHARS);
  return { text, pages: images.length, engine: "glm" };
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
