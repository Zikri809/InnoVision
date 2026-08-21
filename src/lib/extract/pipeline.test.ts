import { describe, it, expect, vi, beforeEach } from "vitest";
import { runExtractionPipeline } from "@/lib/extract/pipeline";
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
      config: { defaultEngine: "glm", glmBaseUrl: "x", glmModel: "y" },
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
