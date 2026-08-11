/**
 * Native text-layer extraction — free, instant, no OCR.
 *
 * Isomorphic (browser + Node): pdfjs-dist for PDF text layers, mammoth for
 * DOCX, jszip + slide-XML text nodes for PPTX, passthrough for plain text.
 *
 * Node specifics (server-side fallback in /api/ai/generate-quiz): pdf.js must
 * NOT spin up a worker or fetch CMaps/fonts — we disable them and read the
 * text layer directly. Browser path uses the default worker (self-hosted in
 * P9; CDN default now).
 *
 * Bounds (S1 from the P4 plan review): the caller is responsible for capping
 * file size / page count before calling; this module enforces MAX_PARSE_PAGES
 * and the MAX_EXTRACT_CHARS text cap defensively.
 */

import {
  MAX_EXTRACT_CHARS,
  MAX_PARSE_PAGES,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_TOTAL_BYTES,
  MIN_CHARS_PER_PAGE,
  type ExtractionResult,
} from "@/lib/extract/types";
import { destroyPdf, loadPdfJs } from "@/lib/extract/pdf";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export type NativeParseOptions = {
  /** When true, force Node-safe pdf.js settings (no worker/fetch). */
  node?: boolean;
  /**
   * Hard deadline for the parse. If the deadline elapses, the PDF/DOCX/PPTX
   * parse rejects with `parse_timeout` (mapped by the route to 503). The
   * browser/Node APIs we use don't all honor AbortSignal natively, so the
   * deadline is enforced via Promise.race at the route boundary rather than
   * threaded through every parse call.
   */
  timeoutMs?: number;
};

/** Count characters (approx) in a string — used for the density heuristic. */
function charCount(s: string): number {
  return s.length;
}

/** Extract text layer from a PDF ArrayBuffer. Returns per-page text. */
async function extractPdfText(
  data: ArrayBuffer,
  opts: NativeParseOptions,
): Promise<{ pages: string[] }> {
  const pdfjs = await loadPdfJs();
  const node = opts.node ?? !isBrowser();

  // In Node there is no worker thread / DOM; disable worker, fetch, fonts.
  // `disableWorker` is a runtime option in pdfjs-dist v6 that is not exposed in
  // the public DocumentInitParameters type — cast the params object.
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data),
    disableWorker: node,
    useWorkerFetch: !node,
    isEvalSupported: false,
    useSystemFonts: !node,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;

  try {
    const pageCount = Math.min(doc.numPages, MAX_PARSE_PAGES);
    const pages: string[] = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const items = (content.items ?? []) as { str?: string }[];
      const text = items.map((it) => it.str ?? "").join(" ");
      pages.push(text);
    }
    return { pages };
  } finally {
    await destroyPdf(doc);
  }
}

/** Extract text from a DOCX (mammoth → raw text). */
async function extractDocxText(data: ArrayBuffer): Promise<{ pages: string[] }> {
  const mammoth = await import("mammoth");
  // Mammoth's Node build reads `{ buffer }`; the browser build reads
  // `{ arrayBuffer }`. Pass both-compatible options explicitly.
  const options = isBrowser()
    ? { arrayBuffer: data }
    : { buffer: Buffer.from(data) };
  const result = await mammoth.extractRawText(options);
  return { pages: [result.value] };
}

/** Extract text from a PPTX (jszip → slide XML text nodes). */
async function extractPptxText(data: ArrayBuffer): Promise<{ pages: string[] }> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error("pptx_too_many_entries");
  }
  const slideFiles = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name) && !e.dir)
    .sort((a, b) => {
      const na = Number(/slide(\d+)\.xml$/.exec(a.name)?.[1] ?? 0);
      const nb = Number(/slide(\d+)\.xml$/.exec(b.name)?.[1] ?? 0);
      return na - nb;
    });

  // Pre-check uncompressed sizes BEFORE any decompression. JSZip exposes
  // `uncompressedSize` (or `_data?.uncompressedSize` on its internal type)
  // without reading the entry. This is the zip-bomb DoS guard the plan called
  // for — checking AFTER `entry.async(...)` decompresses the entry into RAM.
  let preflightBytes = 0;
  for (const entry of slideFiles) {
    // JSZip's `ZipObject` type doesn't expose `uncompressedSize` publicly; the
    // internal `_data?.uncompressedSize` is the documented pre-check field.
    const entryAny = entry as unknown as { uncompressedSize?: number; _data?: { uncompressedSize?: number } };
    const sz = entryAny.uncompressedSize ?? entryAny._data?.uncompressedSize ?? 0;
    preflightBytes += sz;
    if (preflightBytes > MAX_ZIP_TOTAL_BYTES) {
      throw new Error("pptx_too_large");
    }
  }

  const pages: string[] = [];
  for (const entry of slideFiles) {
    // Read the entry ONCE (avoid double-decompress); decode the bytes as text.
    const bytes = await entry.async("uint8array");
    const xml = new TextDecoder("utf-8").decode(bytes);
    // Strip tags and collect <a:t> text node contents.
    const text = xml
      .replace(/<a:t[^>]*>/gi, "\u0001")
      .replace(/<\/a:t>/gi, "\u0002")
      .replace(/<[^>]+>/g, " ")
      .split(/\u0001|\u0002/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push(text);
  }
  return { pages };
}

function decodeText(data: ArrayBuffer): string {
  return new TextDecoder("utf-8").decode(data);
}

/** Detect the file type from its name; throw on unsupported. */
export function detectNativeType(
  filename: string,
): "pdf" | "docx" | "pptx" | "text" {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "pdf":
      return "pdf";
    case "docx":
      return "docx";
    case "pptx":
      return "pptx";
    case "txt":
    case "md":
      return "text";
    default:
      throw new Error("unsupported_file_type");
  }
}

/**
 * Run native extraction. Returns an ExtractionResult with engine='native'.
 * `lowConfidence` is set when the average chars/page falls below
 * MIN_CHARS_PER_PAGE (the pipeline then falls through to OCR).
 */
export async function nativeExtract(
  data: ArrayBuffer,
  filename: string,
  opts: NativeParseOptions = {},
): Promise<ExtractionResult> {
  const type = detectNativeType(filename);

  let pages: string[];
  switch (type) {
    case "pdf":
      ({ pages } = await extractPdfText(data, opts));
      break;
    case "docx":
      ({ pages } = await extractDocxText(data));
      break;
    case "pptx":
      ({ pages } = await extractPptxText(data));
      break;
    default: {
      const text = decodeText(data);
      pages = text ? [text] : [];
    }
  }

  const joined = pages.join("\n\n");
  const text = joined.length > MAX_EXTRACT_CHARS ? joined.slice(0, MAX_EXTRACT_CHARS) : joined;

  const nonEmpty = pages.filter((p) => charCount(p.trim()) > 0).length;
  const avgPerPage = nonEmpty > 0 ? charCount(text) / nonEmpty : 0;
  const lowConfidence = nonEmpty > 0 && avgPerPage < MIN_CHARS_PER_PAGE;

  return { text, pages: pages.length, engine: "native", lowConfidence };
}
