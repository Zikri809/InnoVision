import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  documentRetryOutcomes,
  engineAfterProbe,
  extractErrorI18nKey,
  failedRetryPaths,
  isLowDensityOutcome,
  mergeOutcomes,
  outcomeSkippedReason,
  outcomeText,
  planGlmRun,
  planRetry,
  runExtractionPipeline,
  shouldReuseProbe,
  shouldSpliceRetry,
  spliceRetriedPages,
  summarizeOutcomes,
  usableEngineInfo,
  type ExtractionOutcome,
} from "@/lib/extract/pipeline";
import { probeGlmModel } from "@/lib/ai/http-compat";

// Mock the OCR modules so pipeline-level tests can exercise the GLM/Tesseract
// branches without the browser-only pdf.js/tesseract.js canvases.
vi.mock("@/lib/extract/tesseract", () => ({
  tesseractExtract: vi.fn(async () => ({
    text: "OCR result",
    pages: 1,
    engine: "tesseract",
  })),
}));
vi.mock("@/lib/extract/glm-ocr", () => ({
  glmExtract: vi.fn(async () => ({
    text: "GLM result",
    pages: 1,
    engine: "glm",
  })),
  glmAvailable: vi.fn(async () => true),
  // gate G6: the picker probes with glmEngineInfo; the mock must provide it or
  // a module that imports it would see undefined.
  glmEngineInfo: vi.fn(async () => ({
    available: true,
    reason: "ok",
    provider: "local",
    maxPages: 200,
    maxImageBytes: 24_000_000,
    maxPdfBytes: 0,
  })),
  // The pipeline throws this on an unusable probe verdict (defect #1).
  OcrPageError: class OcrPageError extends Error {
    constructor(public readonly code: string) {
      super(code);
      this.name = "OcrPageError";
    }
  },
}));

describe("U-E2 — low chars/page falls through to OCR picker", () => {
  it("server-side path throws ocr_required_browser when native is sparse", async () => {
    // Sparse plain text (< 40 chars) → native lowConfidence → would need OCR.
    const data = new TextEncoder().encode("Short.").buffer as ArrayBuffer;
    await expect(
      runExtractionPipeline({ data, filename: "notes.txt", engine: "tesseract" }),
    ).rejects.toThrow("ocr_required_browser");
  });

  it("client-side path without a File also throws (needs browser OCR)", async () => {
    const data = new TextEncoder().encode("Short.").buffer as ArrayBuffer;
    await expect(
      runExtractionPipeline({ data, filename: "notes.txt", engine: "tesseract" }),
    ).rejects.toThrow("ocr_required_browser");
  });
});

describe("U-E2b — image uploads fall through to the OCR cascade", () => {
  it("an image extension does NOT throw unsupported_file_type; it cascades to tesseract", async () => {
    // Image files are first-class inputs (ALLOWED_EXTENSIONS includes png/jpg/jpeg/webp).
    // The native extractor has no text-layer concept for images; the cascade must
    // fall through to OCR. In a test environment (no browser canvas), tesseract.js
    // fails — that's fine, we assert the pipeline reaches it.
    const data = new TextEncoder().encode("not a real png").buffer as ArrayBuffer;
    // Use a sparse enough buffer that even if tesseract "succeeds" the lowConfidence
    // flag would fire. We assert the pipeline doesn't reject the file outright.
    await expect(
      runExtractionPipeline({ data, filename: "scan.png", engine: "tesseract" }),
    ).rejects.not.toThrow(/unsupported_file_type/);
  });
});

describe("U-E2c — Tesseract OCR is the fallback for low-density native", () => {
  it("native lowConfidence (sparse text) cascades to tesseract (which errors in Node)", async () => {
    // We verify the cascade by asserting that the pipeline reaches the OCR
    // branch (not rejected as unsupported_file_type) — the actual Tesseract
    // call requires a browser canvas and is covered by the E2E test.
    const data = new TextEncoder().encode("Hi.").buffer as ArrayBuffer;
    await expect(
      runExtractionPipeline({ data, filename: "scan.pdf", engine: "tesseract" }),
    ).rejects.not.toThrow(/unsupported_file_type/);
  });
});

describe("U-E4 — GLM availability probe gating", () => {
  it("probeGlmModel returns false when the endpoint is unreachable", async () => {
    const ok = await probeGlmModel({
      baseUrl: "http://127.0.0.1:1", // nothing listens here
      model: "glm-ocr",
      timeoutMs: 300,
    });
    expect(ok).toBe(false);
  });

  it("probe returns false on non-OK HTTP response", async () => {
    // Stub fetch to return 500.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    const ok = await probeGlmModel({ baseUrl: "http://localhost:11434", model: "glm-ocr" });
    expect(ok).toBe(false);
    vi.unstubAllGlobals();
  });

  it("probe returns true when the model is listed (with :tag suffix)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "glm-ocr:latest" }] }),
      }),
    );
    const ok = await probeGlmModel({ baseUrl: "http://localhost:11434", model: "glm-ocr" });
    expect(ok).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("Pipeline engine branching", () => {
  // The pipeline requires a `File` for the OCR branches (server-side path
  // throws `ocr_required_browser` to avoid Node-only canvas code). A tiny
  // `File`-shaped stub is enough — we never call arrayBuffer/canvas on it
  // because the OCR modules are mocked. The payload carries a valid PDF
  // signature so magic-byte validation passes and the cascade proceeds.
  const fileStub = (filename: string) =>
    ({
      name: filename,
      arrayBuffer: async () =>
        new TextEncoder().encode("%PDF-1.4\n%%EOF\n").buffer as ArrayBuffer,
      slice: () => ({
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    }) as unknown as File;

  beforeEach(() => {
    // Clear the OCR mock call counts between tests so `not.toHaveBeenCalled`
    // assertions aren't polluted by previous tests.
    vi.clearAllMocks();
  });

  it("selects tesseract when engine='tesseract'", async () => {
    const tesseract = await import("@/lib/extract/tesseract");
    // sparse content so the cascade falls through to OCR.
    const r = await runExtractionPipeline({
      file: fileStub("scan.pdf"),
      engine: "tesseract",
    });
    expect(r.engine).toBe("tesseract");
    expect(tesseract.tesseractExtract).toHaveBeenCalled();
  });

  it("selects glm when engine='glm'", async () => {
    const glm = await import("@/lib/extract/glm-ocr");
    const r = await runExtractionPipeline({
      file: fileStub("scan.pdf"),
      engine: "glm",
    });
    expect(r.engine).toBe("glm");
    expect(glm.glmExtract).toHaveBeenCalled();
  });

  it("explicit glm runs DIRECTLY even when the file has a dense native text layer", async () => {
    // A lecturer picks GLM-OCR for accuracy; a partial/embedded native text
    // layer must not silently win. Regression for the "slide has more words
    // but only a few got extracted" report.
    const glm = await import("@/lib/extract/glm-ocr");
    const dense = "a".repeat(200);
    const r = await runExtractionPipeline({
      file: {
        name: "slides.pdf",
        arrayBuffer: async () =>
          new TextEncoder().encode(dense).buffer as ArrayBuffer,
      } as unknown as File,
      engine: "glm",
    });
    expect(r.engine).toBe("glm");
    expect(glm.glmExtract).toHaveBeenCalled();
  });

  it("structured formats (pptx, docx) bypass optical GLM OCR and extract natively", async () => {
    const glm = await import("@/lib/extract/glm-ocr");
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", "<p:txBody><a:t>Class inheritance and polymorphism.</a:t></p:txBody>");
    const buffer = await zip.generateAsync({ type: "arraybuffer" });

    const r = await runExtractionPipeline({
      file: {
        name: "Chapter 7 - Object-Oriented Programming.pptx",
        arrayBuffer: async () => buffer,
      } as unknown as File,
      engine: "glm",
    });

    expect(r.engine).toBe("native");
    expect(r.text).toContain("Class inheritance and polymorphism.");
    expect(glm.glmExtract).not.toHaveBeenCalled();
  });

  it("uses dense native text and skips OCR entirely (default tesseract cascade)", async () => {
    const tesseract = await import("@/lib/extract/tesseract");
    // A dense enough plain text > MIN_CHARS_PER_PAGE → native is usable.
    const dense = "a".repeat(200);
    const r = await runExtractionPipeline({
      file: {
        name: "notes.txt",
        arrayBuffer: async () =>
          new TextEncoder().encode(dense).buffer as ArrayBuffer,
      } as unknown as File,
      engine: "tesseract",
    });
    expect(r.engine).toBe("native");
    expect(tesseract.tesseractExtract).not.toHaveBeenCalled();
  });

  it("uses the config defaultEngine when no engine is set", async () => {
    // Dense enough content so the cascade is short-circuited (no OCR path)
    // and the engine returned is the config's defaultEngine.
    const dense = "a".repeat(200);
    const r = await runExtractionPipeline({
      file: {
        name: "notes.txt",
        arrayBuffer: async () =>
          new TextEncoder().encode(dense).buffer as ArrayBuffer,
      } as unknown as File,
      config: { defaultEngine: "glm" },
    });
    expect(r.engine).toBe("native");
  });

  it("forwards onProgress events from the native + OCR phases", async () => {
    const events: Array<{ stage: string; page: number; total: number }> = [];
    const dense = "a".repeat(200);
    await runExtractionPipeline({
      file: {
        name: "notes.txt",
        arrayBuffer: async () =>
          new TextEncoder().encode(dense).buffer as ArrayBuffer,
      } as unknown as File,
      engine: "tesseract",
      onProgress: (p) => events.push({ stage: p.stage, page: p.page, total: p.total }),
    });
    // At least one "native" progress event fired (the cascade ran).
    expect(events.some((e) => e.stage === "native")).toBe(true);
  });

  it("rethrows unsupported_file_type for genuinely unsupported file extensions", async () => {
    // .exe is in the server-side blocklist but not a browser-OCR input.
    await expect(
      runExtractionPipeline({
        file: {
          name: "archive.exe",
          arrayBuffer: async () => new TextEncoder().encode("MZ").buffer as ArrayBuffer,
        } as unknown as File,
        engine: "tesseract",
      }),
    ).rejects.toThrow(/unsupported_file_type/);
  });

  it("passes OCR text through uncapped", async () => {
    // The pipeline no longer truncates extracted text (removed the 15k cap).
    const tesseract = await import("@/lib/extract/tesseract");
    const hugeText = "x".repeat(20_000);
    vi.mocked(tesseract.tesseractExtract).mockResolvedValueOnce({
      text: hugeText,
      pages: 1,
      engine: "tesseract",
    });
    const r = await runExtractionPipeline({
      file: {
        name: "scan.pdf",
        arrayBuffer: async () =>
          new TextEncoder().encode("%PDF-1.4\n%%EOF\n").buffer as ArrayBuffer,
        slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
      } as unknown as File,
      engine: "tesseract",
    });
    expect(r.text.length).toBe(20_000);
  });
});

describe("gate G6 — provider/retry options reach glmExtract", () => {
  const fileStub = () =>
    ({
      name: "scan.pdf",
      arrayBuffer: async () =>
        new TextEncoder().encode("%PDF-1.4\n%%EOF\n").buffer as ArrayBuffer,
      slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
    }) as unknown as File;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards pagesToRetry to glmExtract (local per-page retry unchanged)", async () => {
    const glm = await import("@/lib/extract/glm-ocr");
    await runExtractionPipeline({
      file: fileStub(),
      engine: "glm",
      pagesToRetry: [2, 5],
    });
    expect(glm.glmExtract).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({ pagesToRetry: [2, 5] }),
    );
  });

  it("forwards provider + maxPages + retryWhole to glmExtract (remote whole-doc retry)", async () => {
    const glm = await import("@/lib/extract/glm-ocr");
    await runExtractionPipeline({
      file: fileStub(),
      engine: "glm",
      pagesToRetry: [],
      retryWhole: true,
      provider: "remote",
      maxPages: 30,
    });
    expect(glm.glmExtract).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        retryWhole: true,
        provider: "remote",
        maxPages: 30,
      }),
    );
  });

  it("forwards an undefined provider (the local default) without inventing one", async () => {
    const glm = await import("@/lib/extract/glm-ocr");
    await runExtractionPipeline({ file: fileStub(), engine: "glm" });
    const opts = vi.mocked(glm.glmExtract).mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(opts.provider).toBeUndefined();
    expect(opts.maxPages).toBeUndefined();
    expect(opts.retryWhole).toBeUndefined();
  });
});

describe("defect #1 — the pipeline refuses to run GLM on an unusable probe verdict", () => {
  const fileStub = () =>
    ({
      name: "scan.pdf",
      arrayBuffer: async () =>
        new TextEncoder().encode("%PDF-1.4\n%%EOF\n").buffer as ArrayBuffer,
      slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
    }) as unknown as File;

  const unknownInfo = {
    available: false,
    reason: "unreachable",
    provider: "unknown" as const,
    maxPages: 0,
    maxImageBytes: 0,
    maxPdfBytes: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws glm_model_unavailable for an `unknown` provider verdict and makes NO call", async () => {
    // THE DEFECT: the dialog spread `info.provider` into the pipeline without
    // reading `info.available`, so a failed probe (provider:"local") drove the
    // metered per-page loop. With the honest "unknown" provider, the pipeline
    // must refuse rather than default to local.
    const glm = await import("@/lib/extract/glm-ocr");
    await expect(
      runExtractionPipeline({ file: fileStub(), engine: "glm", engineInfo: unknownInfo }),
    ).rejects.toMatchObject({ code: "glm_model_unavailable" });
    expect(glm.glmExtract).not.toHaveBeenCalled();
  });

  it("throws for an unavailable-but-identified verdict too (available is the gate)", async () => {
    const glm = await import("@/lib/extract/glm-ocr");
    await expect(
      runExtractionPipeline({
        file: fileStub(),
        engine: "glm",
        engineInfo: { ...unknownInfo, provider: "remote", maxPages: 30 },
      }),
    ).rejects.toMatchObject({ code: "glm_model_unavailable" });
    expect(glm.glmExtract).not.toHaveBeenCalled();
  });

  it("runs the engine when the verdict IS usable and forwards its provider + cap", async () => {
    const glm = await import("@/lib/extract/glm-ocr");
    await runExtractionPipeline({
      file: fileStub(),
      engine: "glm",
      engineInfo: {
        available: true,
        reason: "ok",
        provider: "remote",
        maxPages: 30,
        maxImageBytes: 10_485_760,
        maxPdfBytes: 52_428_800,
      },
    });
    expect(glm.glmExtract).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({ provider: "remote", maxPages: 30 }),
    );
  });

  it("keeps the pre-toggle path for a caller that passes no engineInfo at all", async () => {
    const glm = await import("@/lib/extract/glm-ocr");
    await runExtractionPipeline({ file: fileStub(), engine: "glm", provider: "remote", maxPages: 30 });
    expect(glm.glmExtract).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({ provider: "remote", maxPages: 30 }),
    );
  });

  it("an explicit null engineInfo is NOT treated as an unusable verdict", async () => {
    // `null` means "this caller did not probe" (the pre-toggle direct path),
    // which keeps the free local default. Only a verdict that EXISTS and is
    // unusable is refused.
    const glm = await import("@/lib/extract/glm-ocr");
    await runExtractionPipeline({ file: fileStub(), engine: "glm", engineInfo: null });
    expect(glm.glmExtract).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(glm.glmExtract).mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(opts.provider).toBeUndefined();
  });
});

describe("usableEngineInfo / shouldReuseProbe (defect #1 + #2)", () => {
  const base = {
    available: true,
    reason: "ok",
    provider: "local" as const,
    maxPages: 200,
    maxImageBytes: 0,
    maxPdfBytes: 0,
  };

  it("returns the info for a usable verdict", () => {
    expect(usableEngineInfo(base)).toEqual(base);
    expect(shouldReuseProbe(base)).toBe(true);
  });

  it("returns null for an unavailable verdict", () => {
    expect(usableEngineInfo({ ...base, available: false })).toBeNull();
    expect(shouldReuseProbe({ ...base, available: false })).toBe(true); // definitive
  });

  it("returns null for an unidentified verdict", () => {
    const unknown = { ...base, provider: "unknown" as const, maxPages: 0 };
    expect(usableEngineInfo(unknown)).toBeNull();
    // And it must NOT be cached: one transient blip would otherwise poison
    // every later run in the dialog session.
    expect(shouldReuseProbe(unknown)).toBe(false);
  });

  it("treats absent info as 'nothing to gate on'", () => {
    expect(usableEngineInfo(null)).toBeNull();
    expect(usableEngineInfo(undefined)).toBeNull();
    expect(shouldReuseProbe(null)).toBe(false);
    expect(shouldReuseProbe(undefined)).toBe(false);
  });
});

describe("defect #1 — engineAfterProbe (the restored-from-localStorage interaction)", () => {
  const usableLocal = {
    available: true,
    reason: "ok",
    provider: "local" as const,
    maxPages: 200,
    maxImageBytes: 0,
    maxPdfBytes: 0,
  };
  const failed = {
    available: false,
    reason: "unreachable",
    provider: "unknown" as const,
    maxPages: 0,
    maxImageBytes: 0,
    maxPdfBytes: 0,
  };

  it("drops a restored `glm` selection when the probe failed", () => {
    // THE DEFECT: `glm` restored from localStorage stayed selected-but-hidden,
    // so it remained extractable and drove the metered per-page loop.
    expect(engineAfterProbe("glm", failed)).toBe("tesseract");
  });

  it("keeps `glm` when the probe succeeded", () => {
    expect(engineAfterProbe("glm", usableLocal)).toBe("glm");
    expect(engineAfterProbe("glm", { ...usableLocal, provider: "remote", maxPages: 30 })).toBe("glm");
  });

  it("drops `glm` for an unavailable-but-identified verdict too", () => {
    expect(engineAfterProbe("glm", { ...usableLocal, available: false })).toBe("tesseract");
  });

  it("leaves the selection alone while the probe is still pending", () => {
    // No verdict yet → do not churn the UI; the dialog's extract gate is what
    // refuses if the verdict lands unusable.
    expect(engineAfterProbe("glm", null)).toBe("glm");
    expect(engineAfterProbe("glm", undefined)).toBe("glm");
  });

  it("never touches a non-glm selection", () => {
    expect(engineAfterProbe("tesseract", failed)).toBe("tesseract");
    expect(engineAfterProbe("native", failed)).toBe("native");
    expect(engineAfterProbe("tesseract", null)).toBe("tesseract");
  });
});

describe("defect #1 — planGlmRun (the dialog's extract gate)", () => {
  const usableRemote = {
    available: true,
    reason: "ok",
    provider: "remote" as const,
    maxPages: 30,
    maxImageBytes: 10_485_760,
    maxPdfBytes: 52_428_800,
  };
  const failed = {
    available: false,
    reason: "unreachable",
    provider: "unknown" as const,
    maxPages: 0,
    maxImageBytes: 0,
    maxPdfBytes: 0,
  };

  it("REFUSES glm on a failed probe instead of defaulting to the local leg", () => {
    expect(planGlmRun("glm", failed)).toEqual({
      action: "refuse",
      code: "glm_model_unavailable",
    });
  });

  it("REFUSES glm on an unavailable-but-identified verdict", () => {
    expect(planGlmRun("glm", { ...usableRemote, available: false })).toEqual({
      action: "refuse",
      code: "glm_model_unavailable",
    });
  });

  it("runs glm and forwards the usable verdict", () => {
    expect(planGlmRun("glm", usableRemote)).toEqual({
      action: "run",
      engineInfo: usableRemote,
    });
  });

  it("runs glm with NO verdict when there is none (the pre-toggle direct path)", () => {
    expect(planGlmRun("glm", null)).toEqual({ action: "run", engineInfo: null });
    expect(planGlmRun("glm", undefined)).toEqual({ action: "run", engineInfo: null });
  });

  it("runs a non-glm engine regardless of the verdict", () => {
    // tesseract is always available and is not provider-gated.
    expect(planGlmRun("tesseract", failed)).toEqual({ action: "run", engineInfo: null });
    expect(planGlmRun("native", failed)).toEqual({ action: "run", engineInfo: null });
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * defect #6 — the dialog's fold/retry machine, now pure + tested
 * ────────────────────────────────────────────────────────────────────────── */

const outcome = (over: Partial<ExtractionOutcome> = {}): ExtractionOutcome => ({
  path: "a.pdf",
  name: "a.pdf",
  index: 0,
  text: "text",
  totalPages: 3,
  failedPages: [],
  rateLimitedPages: 0,
  lowConfidence: false,
  wholeDocumentRetry: false,
  ...over,
});

describe("defect #6 — planRetry", () => {
  const previous = outcome({ failedPages: [2, 5] });

  it("builds the WHOLE-document retry for a remote whole-doc re-run", () => {
    // The load-bearing construction: `pages: []` + `whole: true`. Without the
    // flag the splice guard would run against a result that has no pageTexts.
    expect(planRetry({ retryWhole: true, retarget: true, previous })).toEqual({
      pages: [],
      previous,
      whole: true,
    });
  });

  it("returns undefined for a whole-doc retry with no prior outcome", () => {
    expect(planRetry({ retryWhole: true, retarget: true, previous: undefined })).toBeUndefined();
  });

  it("re-runs only the FAILED pages for a page-granular retry", () => {
    expect(planRetry({ retryWhole: false, retarget: true, previous })).toEqual({
      pages: [2, 5],
      previous,
    });
  });

  it("returns undefined when the retried file has no failed pages", () => {
    expect(
      planRetry({ retryWhole: false, retarget: true, previous: outcome() }),
    ).toBeUndefined();
  });

  it("returns undefined for a first run (not a retarget)", () => {
    expect(planRetry({ retryWhole: false, retarget: false, previous })).toBeUndefined();
  });

  it("returns undefined when there is no prior outcome at all", () => {
    expect(
      planRetry({ retryWhole: false, retarget: true, previous: undefined }),
    ).toBeUndefined();
  });
});

describe("defect #6 — shouldSpliceRetry (the `!retryWhole` guard)", () => {
  const withPages = outcome({ pageTexts: ["p1", "p2", ""], failedPages: [3] });

  it("splices a page-granular retry that has prior per-page text", () => {
    expect(shouldSpliceRetry({ retryWhole: false, retryPages: [3], previous: withPages })).toBe(true);
  });

  it("NEVER splices a whole-document retry", () => {
    // The remote leg has no page boundaries; splicing would fabricate them.
    expect(shouldSpliceRetry({ retryWhole: true, retryPages: [3], previous: withPages })).toBe(false);
    // Even when the prior outcome happens to carry pageTexts (a local result
    // retried as a whole document), the guard stands the machine down.
    expect(shouldSpliceRetry({ retryWhole: true, retryPages: [], previous: withPages })).toBe(false);
  });

  it("does not splice without a prior page-text corpus", () => {
    expect(
      shouldSpliceRetry({ retryWhole: false, retryPages: [3], previous: outcome({ failedPages: [3] }) }),
    ).toBe(false);
  });

  it("does not splice without a retry page set or a prior outcome", () => {
    expect(shouldSpliceRetry({ retryWhole: false, previous: withPages })).toBe(false);
    expect(shouldSpliceRetry({ retryWhole: false, retryPages: [3] })).toBe(false);
  });
});

describe("defect #6 — spliceRetriedPages", () => {
  it("puts recovered text back in its original position", () => {
    const previous = outcome({
      pageTexts: ["one", "", "three"],
      failedPages: [2],
      text: "one\n\nthree",
    });
    const fresh = outcome({ pageTexts: ["", "TWO", ""], failedPages: [], text: "TWO" });
    const merged = spliceRetriedPages(fresh, previous, [2]);
    expect(merged.pageTexts).toEqual(["one", "TWO", "three"]);
    expect(merged.text).toBe("one\n\nTWO\n\nthree");
    // Recovered pages drop out of the failure set.
    expect(merged.failedPages).toEqual([]);
  });

  it("preserves the pre-existing failure-set filter (retried pages drop out)", () => {
    // NOTE (NEW ISSUE, reported): the filter is `!retryPages.includes(p)`, so a
    // page that FAILED AGAIN is also removed from the failure set. That is the
    // shipped behaviour and is preserved verbatim here (the local leg must not
    // regress); the text for that page is still absent from the spliced corpus.
    const previous = outcome({ pageTexts: ["one", ""], failedPages: [2] });
    const fresh = outcome({ pageTexts: ["", ""], failedPages: [2], text: "" });
    const merged = spliceRetriedPages(fresh, previous, [2]);
    expect(merged.failedPages).toEqual([]);
    expect(merged.text).toBe("one");
  });

  it("never drops pages that succeeded before the retry", () => {
    // A retry re-runs only the failed subset; the earlier successes must
    // survive in the spliced corpus.
    const previous = outcome({ pageTexts: ["keep me", ""], failedPages: [2] });
    const fresh = outcome({ pageTexts: ["", "recovered"], failedPages: [], text: "recovered" });
    const merged = spliceRetriedPages(fresh, previous, [2]);
    expect(merged.text).toBe("keep me\n\nrecovered");
  });
});

describe("defect #6 — mergeOutcomes", () => {
  it("replaces only the re-run files on a retarget", () => {
    const a = outcome({ path: "a.pdf", text: "old a" });
    const b = outcome({ path: "b.pdf", text: "b" });
    const freshA = outcome({ path: "a.pdf", text: "new a" });
    const merged = mergeOutcomes({
      prior: [a, b],
      produced: [freshA],
      paths: ["a.pdf", "b.pdf"],
      retarget: true,
    });
    expect(merged.map((o) => o.text)).toEqual(["new a", "b"]);
  });

  it("keeps the upload order (the SOURCE headers must stay stable)", () => {
    const a = outcome({ path: "a.pdf", index: 0 });
    const b = outcome({ path: "b.pdf", index: 1 });
    const merged = mergeOutcomes({
      prior: [a, b],
      produced: [outcome({ path: "b.pdf", text: "new b" })],
      paths: ["a.pdf", "b.pdf"],
      retarget: true,
    });
    expect(merged.map((o) => o.path)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("a full run's produced list IS the new state", () => {
    const prior = [outcome({ path: "gone.pdf" })];
    const produced = [outcome({ path: "new.pdf" })];
    expect(
      mergeOutcomes({ prior, produced, paths: ["new.pdf"], retarget: false }),
    ).toEqual(produced);
  });

  it("falls back to the produced list when the merge would be empty", () => {
    const produced = [outcome({ path: "x.pdf" })];
    const merged = mergeOutcomes({ prior: [], produced, paths: ["x.pdf"], retarget: true });
    expect(merged).toEqual(produced);
  });
});

describe("defect #6 — outcomeSkippedReason", () => {
  it("marks an empty first run as skipped", () => {
    expect(outcomeSkippedReason({ text: "   " })).toBe("empty");
  });

  it("does not mark a run that produced text", () => {
    expect(outcomeSkippedReason({ text: "hello" })).toBeUndefined();
  });

  it("keeps a file's contributed status across a PAGE-granular retry", () => {
    // Only the failed pages were re-run; an all-failed retry must not erase
    // pages that succeeded before.
    const previous = outcome({ text: "earlier text" });
    expect(
      outcomeSkippedReason({ text: "", retry: { pages: [2], previous } }),
    ).toBeUndefined();
  });

  it("EXCEPTION: a whole-document retry replaces the outcome wholesale", () => {
    // The re-run IS the document, so an empty result really does mean this
    // file contributed nothing.
    const previous = outcome({ text: "earlier text" });
    expect(
      outcomeSkippedReason({ text: "", retry: { pages: [], previous, whole: true } }),
    ).toBe("empty");
  });

  it("marks a whole-doc retry that returned text as not skipped", () => {
    const previous = outcome({ text: "earlier text" });
    expect(
      outcomeSkippedReason({ text: "fresh", retry: { pages: [], previous, whole: true } }),
    ).toBeUndefined();
  });
});

describe("defect #6/#7 — summarizeOutcomes + isLowDensityOutcome", () => {
  it("sums the per-file totals", () => {
    const summary = summarizeOutcomes([
      outcome({ totalPages: 3, failedPages: [1], rateLimitedPages: 1, lowConfidence: true }),
      outcome({ path: "b.pdf", totalPages: 5, failedPages: [2, 4] }),
    ]);
    expect(summary).toEqual({
      totalAttemptedPages: 8,
      totalFailedPages: 3,
      totalRateLimitedPages: 1,
      hasLowConfidence: true,
      unknownPageCount: 0,
    });
  });

  it("counts outcomes whose engine reported no page count", () => {
    const summary = summarizeOutcomes([
      outcome({ totalPages: 0, text: "whole doc" }),
      outcome({ path: "b.pdf", totalPages: 4 }),
    ]);
    expect(summary.unknownPageCount).toBe(1);
    expect(summary.totalAttemptedPages).toBe(4);
  });

  it("flags a low-density office deck (the pre-existing heuristic)", () => {
    const summary = summarizeOutcomes([outcome({ totalPages: 10 })]);
    expect(
      isLowDensityOutcome({ hasOfficeFiles: true, summary, words: 20, chars: 200 }),
    ).toBe(true);
  });

  it("does not flag a dense office deck", () => {
    const summary = summarizeOutcomes([outcome({ totalPages: 10 })]);
    expect(
      isLowDensityOutcome({ hasOfficeFiles: true, summary, words: 500, chars: 5000 }),
    ).toBe(false);
  });

  it("does not flag non-office decks at all", () => {
    const summary = summarizeOutcomes([outcome({ totalPages: 10 })]);
    expect(isLowDensityOutcome({ hasOfficeFiles: false, summary, words: 1, chars: 1 })).toBe(false);
  });

  it("does not make the density claim when a page count is UNKNOWN (defect #7)", () => {
    // Dividing by a lower-bound denominator over-estimates density, so the
    // "very little text" claim would be unearned — a 300-page deck read as 1
    // page used to produce exactly this false positive.
    const summary = summarizeOutcomes([outcome({ totalPages: 0, lowConfidence: false })]);
    expect(
      isLowDensityOutcome({ hasOfficeFiles: true, summary, words: 3, chars: 20 }),
    ).toBe(false);
  });

  it("stands the density claim down in a MIXED batch (one known count, one unknown)", () => {
    // The load-bearing case: `totalAttemptedPages` is non-zero (so the >0 guard
    // does not fire) but the denominator is still a lower bound, because one
    // file's engine never reported a count. A remote deck with `numPages: null`
    // next to a normal local file is exactly this shape.
    const summary = summarizeOutcomes([
      outcome({ path: "remote.pdf", totalPages: 0, lowConfidence: false }),
      outcome({ path: "local.pdf", totalPages: 1, lowConfidence: false }),
    ]);
    expect(summary.totalAttemptedPages).toBe(1);
    expect(summary.unknownPageCount).toBe(1);
    // 3 words over a LOWER BOUND of 1 page would look sparse — but the count is
    // not trustworthy, so the claim is not made.
    expect(isLowDensityOutcome({ hasOfficeFiles: true, summary, words: 3, chars: 20 })).toBe(false);
  });

  it("still flags a mixed batch when the ENGINE itself reported low confidence", () => {
    const summary = summarizeOutcomes([
      outcome({ path: "remote.pdf", totalPages: 0, lowConfidence: true }),
      outcome({ path: "local.pdf", totalPages: 1, lowConfidence: false }),
    ]);
    expect(isLowDensityOutcome({ hasOfficeFiles: true, summary, words: 500, chars: 5000 })).toBe(true);
  });

  it("still trusts the engine's OWN lowConfidence flag when the count is unknown", () => {
    const summary = summarizeOutcomes([outcome({ totalPages: 0, lowConfidence: true })]);
    expect(isLowDensityOutcome({ hasOfficeFiles: true, summary, words: 3, chars: 20 })).toBe(true);
  });

  it("does not divide by zero when every page count is unknown", () => {
    const summary = summarizeOutcomes([outcome({ totalPages: 0 })]);
    expect(summary.totalAttemptedPages).toBe(0);
    expect(
      isLowDensityOutcome({ hasOfficeFiles: true, summary, words: 100, chars: 1000 }),
    ).toBe(false);
  });
});

describe("defect #6 — the retry-set selectors", () => {
  it("documentRetryOutcomes picks only whole-document retry candidates", () => {
    const a = outcome({ path: "a.pdf", wholeDocumentRetry: true });
    const b = outcome({ path: "b.pdf" });
    expect(documentRetryOutcomes([a, b])).toEqual([a]);
  });

  it("failedRetryPaths picks files with failed pages OR an empty outcome", () => {
    const failed = outcome({ path: "failed.pdf", failedPages: [1] });
    const empty = outcome({ path: "empty.pdf", text: "", skippedReason: "empty" });
    const ok = outcome({ path: "ok.pdf" });
    expect(failedRetryPaths([failed, empty, ok])).toEqual(["failed.pdf", "empty.pdf"]);
  });

  it("returns nothing to retry when every file is fine", () => {
    expect(failedRetryPaths([outcome(), outcome({ path: "b.pdf" })])).toEqual([]);
    expect(documentRetryOutcomes([outcome()])).toEqual([]);
  });
});

describe("defect #6 — the typed error → i18n map", () => {
  it("maps every code the extraction path can throw", () => {
    expect(extractErrorI18nKey("glm_rate_limited")).toBe("glmRateLimited");
    expect(extractErrorI18nKey("glm_busy")).toBe("glmBusy");
    expect(extractErrorI18nKey("glm_error")).toBe("glmError");
    expect(extractErrorI18nKey("glm_timeout")).toBe("glmTimeout");
    expect(extractErrorI18nKey("glm_model_unavailable")).toBe("glmUnavailable");
    expect(extractErrorI18nKey("glm_pages_exceeded")).toBe("glmPagesExceeded");
    expect(extractErrorI18nKey("glm_spend_cap")).toBe("glmSpendCap");
    expect(extractErrorI18nKey("canvas_unavailable")).toBe("canvasUnavailable");
    expect(extractErrorI18nKey("unsupported_file_type")).toBe("unsupportedType");
  });

  it("maps the new invalid_pdf code (defect #5)", () => {
    expect(extractErrorI18nKey("invalid_pdf")).toBe("invalidPdf");
  });

  it("returns null for a code the dialog does not know", () => {
    expect(extractErrorI18nKey("something_else")).toBeNull();
    expect(extractErrorI18nKey("")).toBeNull();
  });

  it("does not map a raw library message (never an untranslated passthrough)", () => {
    expect(extractErrorI18nKey("Invalid PDF structure.")).toBeNull();
  });
});

describe("outcomeText (defect #6 — the corpus builder's unit)", () => {
  it("prefers per-page text when the engine reports it", () => {
    expect(outcomeText(outcome({ text: "combined", pageTexts: ["a", "", "b"] }))).toBe("a\n\nb");
  });

  it("falls back to the combined text", () => {
    expect(outcomeText(outcome({ text: "  combined  " }))).toBe("combined");
  });

  it("returns empty for an outcome that contributed nothing", () => {
    expect(outcomeText(outcome({ text: "   ", pageTexts: ["", "  "] }))).toBe("");
  });
});
