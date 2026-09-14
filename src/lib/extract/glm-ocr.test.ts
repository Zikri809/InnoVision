import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildRemoteResult,
  assertRemotePageCap,
  CLIENT_GLM_PROBE_TIMEOUT_MS,
  glmAvailable,
  glmEngineInfo,
  glmExtract,
  OcrPageError,
  resolveOcrFileKind,
  sanitizeGlmMarkdown,
  sanitizeGlmText,
  sniffRealFileKind,
} from "@/lib/extract/glm-ocr";
import { loadPdfJs, destroyPdf } from "@/lib/extract/pdf";
import { MAX_OCR_PAGES, MAX_OCR_PAGES_REMOTE, UNKNOWN_MAX_PAGES } from "@/lib/extract/types";

/**
 * The pdf.js loader is wrapped (not replaced) so most tests exercise the REAL
 * page-count path against the checked-in fixture, while the over-cap case can
 * swap in a document with a controlled `numPages` without building a 31-page
 * PDF by hand.
 */
vi.mock("@/lib/extract/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/extract/pdf")>();
  return {
    ...actual,
    loadPdfJs: vi.fn(actual.loadPdfJs),
    destroyPdf: vi.fn(actual.destroyPdf),
  };
});

const fixtureBytes = (name: string): ArrayBuffer => {
  const buf = fs.readFileSync(path.resolve(__dirname, "__fixtures__", name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

const pdfFile = (name = "chapter-sample.pdf", type = "application/pdf"): File =>
  new File([fixtureBytes(name)], name, { type });

/** The 1×1 PNG the remote probe uses — a real, sniffable image. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Decode base64 to a plain ArrayBuffer (avoids Buffer's ArrayBufferLike). */
const pngBytes = (): ArrayBuffer => {
  const binary = atob(TINY_PNG_BASE64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
};

const pngFile = (name = "scan.png", type = "image/png"): File =>
  new File([pngBytes()], name, { type });

/** A Response-shaped stub: the module only reads ok/status/json(). */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const stubFetch = (impl: (input: unknown, init?: RequestInit) => Promise<Response>) => {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
};

/**
 * The LOCAL leg reads the file through `FileReader` (browser-only; this suite
 * runs in the Node environment). The two tests below are the only ones that
 * reach it, so the stub lives here rather than in `src/test/setup.ts` (which
 * this workstream does not own).
 */
function stubFileReader(): void {
  class FakeFileReader {
    result: string | ArrayBuffer | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(blob: Blob): void {
      void blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(
          buf,
        ).toString("base64")}`;
        this.onload?.();
      });
    }
  }
  vi.stubGlobal("FileReader", FakeFileReader);
}

/** A pdf.js document stub whose only interesting property is `numPages`. */
function fakePdfjs(numPages: number) {
  return {
    getDocument: () => ({ promise: Promise.resolve({ numPages }) }),
  } as unknown as Awaited<ReturnType<typeof loadPdfJs>>;
}

beforeEach(() => {
  vi.mocked(loadPdfJs).mockClear();
  vi.mocked(destroyPdf).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(loadPdfJs).mockReset();
  vi.mocked(destroyPdf).mockReset();
  // Re-arm the pass-through implementations for the next test.
  vi.mocked(loadPdfJs).mockImplementation(async () => {
    const actual = await vi.importActual<typeof import("@/lib/extract/pdf")>(
      "@/lib/extract/pdf",
    );
    return actual.loadPdfJs();
  });
  vi.mocked(destroyPdf).mockImplementation(async (doc) => {
    const actual = await vi.importActual<typeof import("@/lib/extract/pdf")>(
      "@/lib/extract/pdf",
    );
    return actual.destroyPdf(doc);
  });
});

describe("sanitizeGlmText", () => {
  it("collapses a long run of markdown-fence noise to a single fence", () => {
    const noisy =
      "Velocity is the rate of change of displacement.\n" +
      "``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ```";
    const out = sanitizeGlmText(noisy);
    expect(out).toContain("Velocity is the rate of change of displacement.");
    // The fence run is collapsed to a single fence (not dozens).
    expect(out.match(/```/g)?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it("leaves clean text unchanged", () => {
    const clean = "Force equals mass times acceleration.";
    expect(sanitizeGlmText(clean)).toBe(clean);
  });

  it("leaves a single legitimate code fence intact", () => {
    const fenced = "```\nVelocity is the rate of change of displacement.\n```";
    expect(sanitizeGlmText(fenced)).toBe(fenced);
  });
});

describe("sanitizeGlmMarkdown (gate G1/G6 — markdown-aware)", () => {
  const TABLE =
    "| Quantity | Symbol | Unit |\n" +
    "| --- | --- | --- |\n" +
    "| Velocity | v | m/s |\n" +
    "| Acceleration | a | m/s² |";

  it("PRESERVES a markdown table byte-for-byte (never strips pipes)", () => {
    expect(sanitizeGlmMarkdown(TABLE)).toBe(TABLE);
  });

  it("preserves a table that follows fence-run noise", () => {
    const noisy = `Heading\n\`\`\`\n\`\`\`\n\`\`\`\n\`\`\`\n\n${TABLE}`;
    const out = sanitizeGlmMarkdown(noisy);
    expect(out).toContain("| Velocity | v | m/s |");
    expect(out).toContain("| --- | --- | --- |");
    // The run collapsed to exactly one fence line.
    expect(out.match(/```/g)?.length ?? 0).toBe(1);
  });

  it("collapses a run of 3+ fence-only lines to a single fence", () => {
    const noisy = "Transcribed text.\n```\n```\n```\n```\n```\n";
    const out = sanitizeGlmMarkdown(noisy);
    expect(out).toContain("Transcribed text.");
    expect(out.match(/```/g)?.length ?? 0).toBe(1);
  });

  it("collapses one-line fence-token noise (``` ``` ```)", () => {
    const noisy = "Transcribed text.\n``` ``` ``` ``` ``` ``` ```";
    const out = sanitizeGlmMarkdown(noisy);
    expect(out).toContain("Transcribed text.");
    expect(out.match(/```/g)?.length ?? 0).toBe(1);
  });

  it("collapses a BLANK-LINE-separated fence run (the remote emitter's shape)", () => {
    // The remote model emits one fence per line with blank lines between them;
    // a line-run-only rule would leave this noise in the corpus.
    const noisy = "Transcribed text.\n```\n\n```\n\n```\n\n```\n";
    const out = sanitizeGlmMarkdown(noisy);
    expect(out).toContain("Transcribed text.");
    expect(out.match(/```/g)?.length ?? 0).toBe(1);
  });

  it("collapses a CRLF fence run", () => {
    const noisy = "Transcribed text.\r\n```\r\n```\r\n```\r\n";
    const out = sanitizeGlmMarkdown(noisy);
    expect(out.match(/```/g)?.length ?? 0).toBe(1);
  });

  it("collapses a MIXED run (lines and same-line tokens together)", () => {
    const noisy = "Transcribed text.\n```\n``` ```\n```\n";
    const out = sanitizeGlmMarkdown(noisy);
    expect(out.match(/```/g)?.length ?? 0).toBe(1);
  });

  it("keeps TWO real code blocks separated by a blank line", () => {
    const two = "```\ncode one\n```\n\n```\ncode two\n```";
    expect(sanitizeGlmMarkdown(two)).toBe(two);
  });

  it("keeps a real code block that contains a blank line", () => {
    const block = "```\nfirst\n\nsecond\n```";
    expect(sanitizeGlmMarkdown(block)).toBe(block);
  });

  it("keeps a single legitimate fenced code block intact", () => {
    const fenced = "```\nconst v = d / t;\n```";
    expect(sanitizeGlmMarkdown(fenced)).toBe(fenced);
  });

  it("keeps a two-fence block (open + close) intact", () => {
    const two = "```\n```";
    expect(sanitizeGlmMarkdown(two)).toBe(two);
  });

  it("preserves layout tags, headings and inline code", () => {
    const md =
      "# Chapter 1\n\n<div align=\"center\"><b>Motion</b></div>\n\n" +
      "Use `d = v * t` for distance.";
    expect(sanitizeGlmMarkdown(md)).toBe(md);
  });

  it("leaves clean markdown unchanged", () => {
    const clean = "Force equals mass times acceleration.";
    expect(sanitizeGlmMarkdown(clean)).toBe(clean);
  });

  // ── defect #3: the two PROVEN corruption inputs ────────────────────────
  it("PRESERVES a 4-backtick block whose content is three fence-only lines", () => {
    // Proven corruption: the old single-regex rule collapsed this to "````\n",
    // eating the block's CONTENT. A ``` token strictly inside ```` … ```` is
    // content, not noise: it cannot close either fence.
    const inner = "````\n```\n```\n```\n````";
    expect(sanitizeGlmMarkdown(inner)).toBe(inner);
  });

  it("PRESERVES three distinct empty code blocks (blank-line separated)", () => {
    // Proven corruption: the old rule collapsed this to "```\n" — three real
    // (empty) code blocks became one.
    const three = "```\n```\n\n```\n```\n\n```\n```";
    expect(sanitizeGlmMarkdown(three)).toBe(three);
  });

  it("PRESERVES a 4-backtick block containing a 3-backtick block", () => {
    const nested = "````\n```\ncode\n```\n````";
    expect(sanitizeGlmMarkdown(nested)).toBe(nested);
  });

  it("PRESERVES two empty code blocks separated by a blank line", () => {
    const two = "```\n```\n\n```\n```";
    expect(sanitizeGlmMarkdown(two)).toBe(two);
  });

  // ── defect #4: separators the TEXT path already handled ────────────────
  it("collapses a CR-only fence run (no weaker than sanitizeGlmText)", () => {
    // Proven weakness: the old markdown pattern accepted only [ \t] + CRLF, so
    // a CR-only run stayed in the corpus while sanitizeGlmText collapsed it.
    const noisy = "Transcribed text.\r```\r```\r```\r";
    const out = sanitizeGlmMarkdown(noisy);
    expect(out).toContain("Transcribed text.");
    expect(out.match(/```/g)?.length ?? 0).toBe(1);
  });

  it("collapses an NBSP-separated fence run", () => {
    const noisy = "Transcribed text.\n```\u00a0\n```\u00a0\n```\n";
    const out = sanitizeGlmMarkdown(noisy);
    expect(out.match(/```/g)?.length ?? 0).toBe(1);
  });

  it("collapses a form-feed-separated fence run", () => {
    const noisy = "Transcribed text.\f```\f```\f```\f";
    const out = sanitizeGlmMarkdown(noisy);
    expect(out).toContain("Transcribed text.");
    expect(out.match(/```/g)?.length ?? 0).toBe(1);
  });

  it("collapses a U+2028-separated fence run", () => {
    const noisy = "Transcribed text.\u2028```\u2028```\u2028```\u2028";
    const out = sanitizeGlmMarkdown(noisy);
    expect(out.match(/```/g)?.length ?? 0).toBe(1);
  });

  it("still collapses a bare run of 5 same-length fences to exactly 1", () => {
    // The contract's REQUIRED behaviour (must survive the rewrite): 3+ adjacent
    // same-length fences with no blank-line grouping are the model's loop.
    const noisy = "Body text.\n```\n```\n```\n```\n```\n";
    const out = sanitizeGlmMarkdown(noisy);
    expect(out).toContain("Body text.");
    expect(out.match(/```/g)?.length ?? 0).toBe(1);
  });

  it("never eats table rows or layout tags around a collapsed run", () => {
    const md = `${TABLE}\n\`\`\`\n\`\`\`\n\`\`\`\n\n<div><b>end</b></div>`;
    const out = sanitizeGlmMarkdown(md);
    expect(out).toContain(TABLE);
    expect(out).toContain("<div><b>end</b></div>");
    expect(out.match(/```/g)?.length ?? 0).toBe(1);
  });
});

describe("assertRemotePageCap (gate G3 — pre-flight, before any spend)", () => {
  it("accepts a document at exactly the cap", () => {
    expect(() => assertRemotePageCap(30, 30)).not.toThrow();
  });

  it("throws glm_pages_exceeded one page over the cap", () => {
    expect(() => assertRemotePageCap(31, 30)).toThrow(OcrPageError);
    try {
      assertRemotePageCap(31, 30);
    } catch (err) {
      expect((err as OcrPageError).code).toBe("glm_pages_exceeded");
    }
  });

  it("accepts a small document under the cap", () => {
    expect(() => assertRemotePageCap(1, 30)).not.toThrow();
  });
});

describe("buildRemoteResult (gate G6 — whole-document shaping)", () => {
  it("shapes a normal remote 200 body", () => {
    const r = buildRemoteResult({
      text: "# Chapter 1\n\nVelocity is the rate of change of displacement.",
      pages: 12,
      numPages: 12,
      degraded: false,
      blank: false,
    });
    expect(r.engine).toBe("glm");
    expect(r.provider).toBe("remote");
    expect(r.text).toContain("Velocity is the rate of change of displacement.");
    expect(r.pages).toBe(12);
    expect(r.totalPages).toBe(12);
    expect(r.pagesAttempted).toBe(12);
    expect(r.lowConfidence).toBeUndefined();
    expect(r.wholeDocumentRetry).toBeUndefined();
  });

  it("NEVER fabricates pageTexts — markdown has no page boundaries (G6)", () => {
    const r = buildRemoteResult({
      text: "Page one text.\n\nPage two text.\n\nPage three text.",
      numPages: 3,
    });
    expect(r.pageTexts).toBeUndefined();
    // And no page-level failure attribution either.
    expect(r.failedPages).toBeUndefined();
    expect(r.rateLimitedPages).toBeUndefined();
  });

  it("falls back to `pages` when numPages is absent (defect #7)", () => {
    expect(buildRemoteResult({ text: "x", pages: 7 }).pages).toBe(7);
    // Garbage page counts are ignored (never NaN, never 0 as a count).
    expect(buildRemoteResult({ text: "x", numPages: 0, pages: -2 }).pages).toBe(0);
    expect(buildRemoteResult({ text: "x", numPages: Number.NaN }).pages).toBe(0);
  });

  it("reports an UNKNOWN page count as 0 with pageCountKnown:false, never a fabricated 1", () => {
    // Defect #7: the server now emits `numPages: null` AND `pages: null` when
    // `data_info.num_pages` is genuinely absent. The old `?? 1` fabricated a
    // 1-page document, which the dialog's density heuristic then divided by —
    // a 300-page deck read as 300x denser than it is.
    const r = buildRemoteResult({ text: "whole doc", numPages: null, pages: null });
    expect(r.pages).toBe(0);
    expect(r.totalPages).toBe(0);
    expect(r.pagesAttempted).toBe(0);
    expect(r.pageCountKnown).toBe(false);
    // And it must NOT claim a page count it does not have.
    expect(r.pages).not.toBe(1);
  });

  it("omits pageCountKnown when the count IS reported", () => {
    const r = buildRemoteResult({ text: "x", numPages: 12 });
    expect(r.pages).toBe(12);
    expect(r.pageCountKnown).toBeUndefined();
  });

  it("marks a degraded reading as low confidence AND whole-document retry", () => {
    const r = buildRemoteResult({
      text: "partial text",
      numPages: 4,
      degraded: true,
      blank: false,
    });
    expect(r.lowConfidence).toBe(true);
    expect(r.wholeDocumentRetry).toBe(true);
    expect(r.pageTexts).toBeUndefined();
  });

  it("marks a blank document as low confidence but NOT a retry candidate", () => {
    const r = buildRemoteResult({ text: "", numPages: 2, blank: true, degraded: false });
    expect(r.text).toBe("");
    expect(r.lowConfidence).toBe(true);
    expect(r.wholeDocumentRetry).toBeUndefined();
    expect(r.pages).toBe(2);
  });

  it("sanitizes fence-run noise but keeps tables in the returned text", () => {
    const r = buildRemoteResult({
      text: "| a | b |\n| --- | --- |\n| 1 | 2 |\n```\n```\n```\n",
      numPages: 1,
    });
    expect(r.text).toContain("| a | b |");
    expect(r.text.match(/```/g)?.length ?? 0).toBe(1);
  });

  it("treats a non-string text field as empty rather than throwing", () => {
    const r = buildRemoteResult({ text: undefined, numPages: 1 });
    expect(r.text).toBe("");
  });
});

describe("glmAvailable (semantics unchanged — the picker's old probe)", () => {
  it("returns true when the server reports available", async () => {
    stubFetch(async () => jsonResponse(200, { available: true, provider: "remote" }));
    await expect(glmAvailable()).resolves.toBe(true);
  });

  it("returns false on a non-OK response", async () => {
    stubFetch(async () => jsonResponse(429, { error: "glm_rate_limited" }));
    await expect(glmAvailable()).resolves.toBe(false);
  });

  it("returns false when the request throws", async () => {
    stubFetch(async () => {
      throw new Error("offline");
    });
    await expect(glmAvailable()).resolves.toBe(false);
  });
});

describe("glmEngineInfo (gate G7 — provider + caps for the picker)", () => {
  it("maps the remote probe payload", async () => {
    stubFetch(async () =>
      jsonResponse(200, {
        available: true,
        reason: "ok",
        checkedAt: "2026-09-14T00:00:00.000Z",
        provider: "remote",
        maxPages: 30,
        maxImageBytes: 10_485_760,
        maxPdfBytes: 52_428_800,
        cached: true,
      }),
    );
    const info = await glmEngineInfo();
    expect(info).toEqual({
      available: true,
      reason: "ok",
      provider: "remote",
      maxPages: 30,
      maxImageBytes: 10_485_760,
      maxPdfBytes: 52_428_800,
    });
  });

  it("maps the local probe payload", async () => {
    stubFetch(async () =>
      jsonResponse(200, {
        available: true,
        reason: "ok",
        provider: "local",
        maxPages: 200,
        maxImageBytes: 24_000_000,
        maxPdfBytes: 0,
      }),
    );
    const info = await glmEngineInfo();
    expect(info.provider).toBe("local");
    expect(info.maxPages).toBe(200);
    expect(info.maxPdfBytes).toBe(0);
  });

  it("reports provider UNKNOWN (never local) when the request fails — defect #1", async () => {
    // The defect: this shape used to be `provider:"local"`, which drove the
    // METERED per-page loop against a remote server (12 billed calls for a
    // 12-page deck instead of one). A probe that could not determine the leg
    // must not assert one.
    stubFetch(async () => jsonResponse(503, { error: "glm_model_unavailable" }));
    const info = await glmEngineInfo();
    expect(info.available).toBe(false);
    expect(info.provider).toBe("unknown");
    expect(info.provider).not.toBe("local");
    expect(info.reason).toBe("unreachable");
    // And the local 200-page cap must not be reported for an unknown leg.
    expect(info.maxPages).toBe(UNKNOWN_MAX_PAGES);
    expect(info.maxPages).not.toBe(MAX_OCR_PAGES);
  });

  it("reports provider UNKNOWN when the body is unparseable — defect #1", async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => null }) as unknown as Response);
    const info = await glmEngineInfo();
    expect(info.available).toBe(false);
    expect(info.provider).toBe("unknown");
  });

  it("reports provider UNKNOWN when the fetch itself throws — defect #1", async () => {
    stubFetch(async () => {
      throw new Error("network down");
    });
    const info = await glmEngineInfo();
    expect(info.available).toBe(false);
    expect(info.provider).toBe("unknown");
    expect(info.maxPages).toBe(UNKNOWN_MAX_PAGES);
  });

  it("reports provider UNKNOWN for a 200 that does not name a known leg — defect #1", async () => {
    // A 200 with an unrecognised provider is as unusable as a failure: the caps
    // are provider-DERIVED, so guessing the provider guesses the caps too.
    stubFetch(async () => jsonResponse(200, { available: true, provider: "zai" }));
    const info = await glmEngineInfo();
    expect(info.provider).toBe("unknown");
    expect(info.available).toBe(false);
    expect(info.maxPages).toBe(UNKNOWN_MAX_PAGES);
  });

  it("still honours an explicit local verdict (the real local leg)", async () => {
    stubFetch(async () => jsonResponse(200, { available: true, reason: "ok", provider: "local" }));
    const info = await glmEngineInfo();
    expect(info.provider).toBe("local");
    expect(info.available).toBe(true);
    expect(info.maxPages).toBe(MAX_OCR_PAGES);
  });

  it("uses a probe deadline with margin over the server's cold path — defect #2", () => {
    // The server's own remote probe bound is 5 s, ON TOP of auth round trips;
    // a 5 s client window made the abort the EXPECTED outcome on a cold cache.
    expect(CLIENT_GLM_PROBE_TIMEOUT_MS).toBeGreaterThan(5_000);
    expect(CLIENT_GLM_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
  });

  it("defaults maxPages per provider when the field is missing or invalid", async () => {
    stubFetch(async () => jsonResponse(200, { available: true, provider: "remote", maxPages: -1 }));
    expect((await glmEngineInfo()).maxPages).toBe(MAX_OCR_PAGES_REMOTE);
    stubFetch(async () => jsonResponse(200, { available: true, provider: "local" }));
    expect((await glmEngineInfo()).maxPages).toBe(200);
  });

  it("reports unknown byte caps as 0 rather than a fabricated allowance", async () => {
    stubFetch(async () => jsonResponse(200, { available: true, provider: "remote" }));
    const info = await glmEngineInfo();
    expect(info.maxImageBytes).toBe(0);
    expect(info.maxPdfBytes).toBe(0);
  });
});

describe("glmExtract — remote branch (gate G3/G6: ONE request per document)", () => {
  it("sends a single {file, kind} request for an image and shapes the result", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, { text: "# Notes\n\nVelocity is displacement over time.", pages: 1, numPages: 1, degraded: false, blank: false }),
    );
    const progress: [number, number][] = [];
    const r = await glmExtract(
      pngFile(),
      (p, t) => progress.push([p, t]),
      { provider: "remote", maxPages: 30 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/extract/ocr");
    const body = JSON.parse(String(init.body)) as { file: string; kind: string };
    expect(body.kind).toBe("image");
    expect(body.file.startsWith("data:image/png;base64,")).toBe(true);
    // The LOCAL shape must not be used on the remote leg.
    expect(body).not.toHaveProperty("image");

    expect(r.engine).toBe("glm");
    expect(r.provider).toBe("remote");
    expect(r.pageTexts).toBeUndefined();
    expect(r.text).toContain("Velocity is displacement over time.");
    // One request = one unit of progress.
    expect(progress).toEqual([[1, 1]]);
  });

  it("derives the image MIME from the extension when the File type is empty", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { text: "x", numPages: 1 }));
    await glmExtract(pngFile("scan.png", ""), undefined, { provider: "remote" });
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as {
      file: string;
    };
    expect(body.file.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("reads the PDF page count with pdf.js and sends the whole document ONCE", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, { text: "whole doc", numPages: 1, degraded: false, blank: false }),
    );
    const r = await glmExtract(pdfFile(), undefined, { provider: "remote", maxPages: 30 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as {
      file: string;
      kind: string;
    };
    expect(body.kind).toBe("pdf");
    expect(body.file.startsWith("data:application/pdf;base64,")).toBe(true);
    // The fixture's real bytes made it into the payload (no rasterization).
    expect(Buffer.from(body.file.split(",")[1], "base64").subarray(0, 5).toString("latin1")).toBe(
      "%PDF-",
    );
    expect(r.pages).toBe(1);
    expect(r.pageTexts).toBeUndefined();
    expect(r.wholeDocumentRetry).toBeUndefined();
  });

  it("refuses an over-cap PDF BEFORE any upload and destroys the pdf document", async () => {
    vi.mocked(loadPdfJs).mockResolvedValue(fakePdfjs(99));
    const fetchMock = stubFetch(async () => jsonResponse(200, { text: "should not happen" }));

    await expect(
      glmExtract(pdfFile(), undefined, { provider: "remote", maxPages: 30 }),
    ).rejects.toMatchObject({ code: "glm_pages_exceeded" });
    // No spend, no upload.
    expect(fetchMock).not.toHaveBeenCalled();
    // The pdf.js document was destroyed immediately (no leak).
    expect(destroyPdf).toHaveBeenCalledTimes(1);
  });

  it("uses MAX_OCR_PAGES_REMOTE as the default cap when none is supplied", async () => {
    vi.mocked(loadPdfJs).mockResolvedValue(fakePdfjs(MAX_OCR_PAGES_REMOTE + 1));
    const fetchMock = stubFetch(async () => jsonResponse(200, { text: "nope" }));
    await expect(glmExtract(pdfFile(), undefined, { provider: "remote" })).rejects.toMatchObject({
      code: "glm_pages_exceeded",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the server's typed failure code (single request = total failure)", async () => {
    stubFetch(async () => jsonResponse(429, { error: "glm_spend_cap" }));
    await expect(
      glmExtract(pngFile(), undefined, { provider: "remote", maxPages: 30 }),
    ).rejects.toMatchObject({ code: "glm_spend_cap" });
  });

  it("surfaces glm_pages_exceeded from the server's own lower-bound check", async () => {
    stubFetch(async () => jsonResponse(413, { error: "glm_pages_exceeded" }));
    await expect(
      glmExtract(pngFile(), undefined, { provider: "remote", maxPages: 30 }),
    ).rejects.toMatchObject({ code: "glm_pages_exceeded" });
  });

  it("maps a bodyless failure to glm_error", async () => {
    stubFetch(async () => ({ ok: false, status: 502, json: async () => null }) as unknown as Response);
    await expect(
      glmExtract(pngFile(), undefined, { provider: "remote", maxPages: 30 }),
    ).rejects.toMatchObject({ code: "glm_error" });
  });

  it("maps a transport abort to glm_timeout and other failures to glm_error", async () => {
    stubFetch(async () => {
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    });
    await expect(
      glmExtract(pngFile(), undefined, { provider: "remote", maxPages: 30 }),
    ).rejects.toMatchObject({ code: "glm_timeout" });

    stubFetch(async () => {
      throw new Error("connection reset");
    });
    await expect(
      glmExtract(pngFile(), undefined, { provider: "remote", maxPages: 30 }),
    ).rejects.toMatchObject({ code: "glm_error" });
  });

  it("a 200 without a text field is a failure, never an empty success", async () => {
    stubFetch(async () => jsonResponse(200, { pages: 3, numPages: 3 }));
    await expect(
      glmExtract(pngFile(), undefined, { provider: "remote", maxPages: 30 }),
    ).rejects.toMatchObject({ code: "glm_error" });
  });

  it("retryWhole re-sends the document as ONE request (the remote retry unit)", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, { text: "retried", numPages: 1, degraded: true }),
    );
    const r = await glmExtract(pngFile(), undefined, {
      provider: "remote",
      maxPages: 30,
      retryWhole: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.wholeDocumentRetry).toBe(true);
    expect(r.pageTexts).toBeUndefined();
  });

  it("refuses an empty file before uploading anything", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { text: "nope" }));
    const empty = new File([new Uint8Array(0)], "scan.png", { type: "image/png" });
    await expect(
      glmExtract(empty, undefined, { provider: "remote", maxPages: 30 }),
    ).rejects.toMatchObject({ code: "glm_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays on the LOCAL leg when provider is omitted (fail-closed default)", async () => {
    // No provider → local: the request must carry the `{image}` shape, and a
    // PNG never touches pdf.js.
    stubFileReader();
    const fetchMock = stubFetch(async () => jsonResponse(200, { text: "page text" }));
    const r = await glmExtract(pngFile());
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(body).toHaveProperty("image");
    expect(body).not.toHaveProperty("file");
    // Local keeps the per-page machine: index-aligned pageTexts.
    expect(r.pageTexts).toEqual(["page text"]);
    expect(r.provider).toBeUndefined();
  });

  it("stays on the LOCAL leg for an unrecognised provider value (fail-closed)", async () => {
    // A direct caller passing garbage (not a failed PROBE — that is "unknown",
    // covered below) keeps the pre-toggle fail-closed default: only the exact
    // "remote" string selects the metered branch.
    stubFileReader();
    const fetchMock = stubFetch(async () => jsonResponse(200, { text: "page text" }));
    await glmExtract(pngFile(), undefined, {
      provider: "zai" as unknown as "remote",
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(body).toHaveProperty("image");
  });
});

describe("defect #1 — glmExtract REFUSES an unidentified provider", () => {
  it("throws glm_model_unavailable for provider:'unknown' and makes NO call", async () => {
    // THE DEFECT: `provider:"unknown"` used to fall through to the local branch
    // and drive the metered per-page loop — 12 billed `{image}` calls for a
    // 12-page deck instead of ONE whole-document call.
    const fetchMock = stubFetch(async () => jsonResponse(200, { text: "should never happen" }));
    await expect(
      glmExtract(pngFile(), undefined, { provider: "unknown" }),
    ).rejects.toMatchObject({ code: "glm_model_unavailable" });
    // No rasterization, no upload, no spend.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses BEFORE touching the file (a PDF is never even parsed)", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { text: "nope" }));
    await expect(
      glmExtract(pdfFile(), undefined, { provider: "unknown" }),
    ).rejects.toMatchObject({ code: "glm_model_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadPdfJs).not.toHaveBeenCalled();
  });

  it("the refusal is an OcrPageError so the dialog maps it to glmUnavailable", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { text: "nope" }));
    try {
      await glmExtract(pngFile(), undefined, { provider: "unknown" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OcrPageError);
      expect((err as OcrPageError).code).toBe("glm_model_unavailable");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still defaults to the LOCAL leg when NO provider is supplied (backwards compat)", async () => {
    // Direct callers that never probed must keep today's behaviour: the local
    // per-page loop with the `{image}` shape.
    stubFileReader();
    const fetchMock = stubFetch(async () => jsonResponse(200, { text: "page text" }));
    const r = await glmExtract(pngFile());
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(body).toHaveProperty("image");
    expect(r.pageTexts).toEqual(["page text"]);
    expect(r.pages).toBe(1);
  });

  it("keeps the LOCAL per-page loop and its 200-page cap intact", async () => {
    // The local leg's cap must not move: a PDF is rasterized page-by-page and
    // bounded by MAX_OCR_PAGES (the remote cap never leaks into this branch).
    expect(MAX_OCR_PAGES).toBe(200);
    stubFileReader();
    const fetchMock = stubFetch(async () => jsonResponse(200, { text: "page" }));
    await glmExtract(pngFile(), undefined, { maxPages: MAX_OCR_PAGES_REMOTE });
    // The local leg ignores `maxPages` entirely (it is the rasterizer's own
    // MAX_OCR_PAGES bound), so a remote-looking cap cannot shrink it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("defect #5 — the real container decides the branch", () => {
  const bytesOf = (text: string): Uint8Array<ArrayBuffer> =>
    new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  const head = (text: string): Uint8Array => bytesOf(text).subarray(0, 1024);

  it("sniffs %PDF from the leading bytes", () => {
    expect(sniffRealFileKind(head("%PDF-1.7\n"))).toBe("pdf");
    expect(sniffRealFileKind(head("\n\n%PDF-1.4 junk before header"))).toBe("pdf");
  });

  it("sniffs PNG / JPEG / WebP magic", () => {
    expect(sniffRealFileKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image",
    );
    expect(sniffRealFileKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image");
    expect(
      sniffRealFileKind(
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        ]),
      ),
    ).toBe("image");
  });

  it("returns unknown for bytes that name nothing", () => {
    expect(sniffRealFileKind(head("just some text"))).toBe("unknown");
    expect(sniffRealFileKind(new Uint8Array(0))).toBe("unknown");
  });

  it("routes a %PDF named .png as a PDF (the lying extension)", async () => {
    // Proven: this file took the image branch, was labelled image/png, and was
    // rejected by the route's sniffer as a generic glm_error.
    const lying = new File([bytesOf("%PDF-1.4\n%%EOF\n")], "deck.png", { type: "image/png" });
    await expect(resolveOcrFileKind(lying)).resolves.toBe("pdf");
  });

  it("routes a PNG named .pdf as an image (the lying extension, other way)", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
    ]) as Uint8Array<ArrayBuffer>;
    const lying = new File([png], "scan.pdf", { type: "application/pdf" });
    await expect(resolveOcrFileKind(lying)).resolves.toBe("image");
  });

  it("refuses a non-PDF named .pdf with the typed invalid_pdf (no spend)", async () => {
    const fake = new File([bytesOf("this is not a pdf at all")], "notes.pdf", {
      type: "application/pdf",
    });
    await expect(resolveOcrFileKind(fake)).rejects.toMatchObject({ code: "invalid_pdf" });
  });

  it("maps pdf.js's raw InvalidPDFException to the typed invalid_pdf", async () => {
    // Proven: the raw English library message ("Invalid PDF structure.") fell
    // through the dialog's generic branch untranslated.
    const fetchMock = stubFetch(async () => jsonResponse(200, { text: "nope" }));
    vi.mocked(loadPdfJs).mockResolvedValue({
      getDocument: () => ({
        promise: Promise.reject(
          Object.assign(new Error("Invalid PDF structure."), { name: "InvalidPDFException" }),
        ),
      }),
    } as unknown as Awaited<ReturnType<typeof loadPdfJs>>);
    const fake = new File([bytesOf("%PDF-1.4\n%%EOF\n")], "broken.pdf", {
      type: "application/pdf",
    });
    await expect(
      glmExtract(fake, undefined, { provider: "remote", maxPages: 30 }),
    ).rejects.toMatchObject({ code: "invalid_pdf" });
    // Refused before any upload.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not mask a non-pdf.js error as invalid_pdf", async () => {
    vi.mocked(loadPdfJs).mockResolvedValue({
      getDocument: () => ({ promise: Promise.reject(new Error("out of memory")) }),
    } as unknown as Awaited<ReturnType<typeof loadPdfJs>>);
    const fake = new File([bytesOf("%PDF-1.4\n%%EOF\n")], "broken.pdf", {
      type: "application/pdf",
    });
    await expect(
      glmExtract(fake, undefined, { provider: "remote", maxPages: 30 }),
    ).rejects.toThrow("out of memory");
  });
});
