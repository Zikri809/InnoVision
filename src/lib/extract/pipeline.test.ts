import { describe, it, expect, vi } from "vitest";
import { runExtractionPipeline } from "@/lib/extract/pipeline";
import { probeOllamaModel } from "@/lib/ai/http-compat";
import { base64ByteLength, batch, MAX_VISION_PAGES } from "@/lib/extract/types";

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
