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

/**
 * Zip-bomb pre-flight (PLAN §S1). Validates the total entry count and the
 * cumulative declared-uncompressed size of the selected entries (the ones
 * actually decompressed by the caller) BEFORE the underlying library reads
 * anything. Throws `<label>_too_many_entries` or `<label>_too_large` so the
 * route maps to a typed 4xx.
 *
 * The pre-check is best-effort: jszip exposes the declared
 * `uncompressedSize` (a *hint* from the central directory), not the true
 * output size. A pathological zip that lies in its headers can still OOM on
 * decompress — the route also caps input at 25 MB (route + bucket), which is
 * the strongest hard bound.
 */
async function assertZipBounds(
  source: ArrayBuffer | Array<{ name: string; dir: boolean; async: (type: string) => Promise<Uint8Array | string> }>,
  label: "docx" | "pptx",
  select: (name: string) => boolean,
): Promise<void> {
  let entries: Array<{ name: string; dir: boolean; async: (type: string) => Promise<Uint8Array | string> }>;
  if (source instanceof ArrayBuffer) {
    // DOCX is via mammoth; we pre-flight the central-directory sizes by loading
    // with jszip (which only parses the directory at this point — no entry
    // bodies are decompressed until entry.async() is called).
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(source);
    entries = Object.values(zip.files) as unknown as Array<{
      name: string;
      dir: boolean;
      async: (type: string) => Promise<Uint8Array | string>;
    }>;
  } else {
    entries = source;
  }
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`${label}_too_many_entries`);
  }
  let preflightBytes = 0;
  for (const entry of entries) {
    if (!select(entry.name)) continue;
    // jszip's ZipObject also exposes _data.uncompressedSize (not in the public
    // type) — fall back to it. Same field read as the PPTX path.
    const entryAny = entry as unknown as {
      name: string;
      uncompressedSize?: number;
      _data?: { uncompressedSize?: number };
    };
    preflightBytes +=
      entryAny.uncompressedSize ?? entryAny._data?.uncompressedSize ?? 0;
    if (preflightBytes > MAX_ZIP_TOTAL_BYTES) {
      throw new Error(`${label}_too_large`);
    }
  }
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
  // DOCX zip-bomb pre-check (mirrors the PPTX one). Mammoth internally
  // decompresses the zip on extractRawText; pre-flight declared sizes so a
  // bomb entry can't OOM the worker.
  await assertZipBounds(data, "docx", (name) => /^word\//.test(name) || /^\[Content_Types\]\.xml$/.test(name));
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
  const entries = Object.values(zip.files) as unknown as Array<{
    name: string;
    dir: boolean;
    async: (type: string) => Promise<Uint8Array | string>;
  }>;
  await assertZipBounds(
    entries,
    "pptx",
    (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name),
  );
  const slideFiles = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name) && !e.dir)
    .sort((a, b) => {
      const na = Number(/slide(\d+)\.xml$/.exec(a.name)?.[1] ?? 0);
      const nb = Number(/slide(\d+)\.xml$/.exec(b.name)?.[1] ?? 0);
      return na - nb;
    });

  const pages: string[] = [];
  for (const entry of slideFiles) {
    // Read the entry ONCE (avoid double-decompress); decode the bytes as text.
    const bytes = (await entry.async("uint8array")) as Uint8Array;
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
