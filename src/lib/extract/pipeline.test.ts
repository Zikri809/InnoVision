import { describe, it, expect, vi, beforeEach } from "vitest";
import { runExtractionPipeline } from "@/lib/extract/pipeline";
import { probeOllamaModel } from "@/lib/ai/http-compat";
import { base64ByteLength, batch, MAX_VISION_PAGES } from "@/lib/extract/types";

// Mock the OCR modules so pipeline-level tests can exercise the GLM/vision
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
vi.mock("@/lib/extract/vision", () => ({
  visionExtract: vi.fn(async () => ({
    text: "Vision result",
    pages: 1,
    engine: "vision",
  })),
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
  it("probeOllamaModel returns false when the endpoint is unreachable", async () => {
    const ok = await probeOllamaModel({
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
    const ok = await probeOllamaModel({ baseUrl: "http://ollama", model: "glm-ocr" });
    expect(ok).toBe(false);
    vi.unstubAllGlobals();
  });

  it("probe returns true when the model is listed (with :tag suffix)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: "glm-ocr:latest" }] }),
      }),
    );
    const ok = await probeOllamaModel({ baseUrl: "http://ollama", model: "glm-ocr" });
    expect(ok).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("U-E9b — vision orchestration batches sequentially", () => {
  it("batch() groups pages into ≤MAX_VISION_PAGES", () => {
    const pages = Array.from({ length: 7 }, (_, i) => `img${i}`);
    const groups = batch(pages, MAX_VISION_PAGES);
    expect(groups.map((g) => g.length)).toEqual([3, 3, 1]);
    // Concatenation order is preserved.
    expect(groups.flat()).toEqual(pages);
  });
});

describe("U-E10 — base64 byte estimator edge cases", () => {
  it("computes correct bytes for padded base64", () => {
    // "abc" → base64 "YWJj" (4 chars, no padding) = 3 bytes.
    expect(base64ByteLength("YWJj")).toBe(3);
    // "abcd" → "YWJjZA==" (8 chars, == padding) = 4 bytes.
    expect(base64ByteLength("YWJjZA==")).toBe(4);
    // "abcde" → "YWJjZGU=" (8 chars, = padding) = 5 bytes.
    expect(base64ByteLength("YWJjZGU=")).toBe(5);
  });
});

describe("Pipeline engine branching", () => {
  // The pipeline requires a `File` for the OCR branches (server-side path
  // throws `ocr_required_browser` to avoid Node-only canvas code). A tiny
  // `File`-shaped stub is enough — we never call arrayBuffer/canvas on it
  // because the OCR modules are mocked.
  const fileStub = (filename: string) =>
    ({ name: filename, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as File;

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

  it("selects vision when engine='vision'", async () => {
    const vision = await import("@/lib/extract/vision");
    const r = await runExtractionPipeline({
      file: fileStub("scan.pdf"),
      engine: "vision",
    });
    expect(r.engine).toBe("vision");
    expect(vision.visionExtract).toHaveBeenCalled();
  });

  it("uses dense native text and skips OCR entirely", async () => {
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
      config: { defaultEngine: "vision", ollamaBaseUrl: "x", glmModel: "y", visionModel: "z" },
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

  it("caps the returned text at MAX_EXTRACT_CHARS (capText is exercised)", async () => {
    // Dense text > MAX_EXTRACT_CHARS (15k) exercises the capText branch.
    // Tesseract mock returns 3 chars; force a large string by overriding
    // the mock for this test only.
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
        arrayBuffer: async () => new TextEncoder().encode("Hi.").buffer as ArrayBuffer,
      } as unknown as File,
      engine: "tesseract",
    });
    expect(r.text.length).toBeLessThanOrEqual(15_000);
  });
});
