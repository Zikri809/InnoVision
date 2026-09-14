import { describe, it, expect } from "vitest";
import {
  isAllowedExtension,
  sanitizeStorageFilename,
  base64ByteLength,
  batch,
  MAX_OCR_PAGES,
  MAX_OCR_PAGES_REMOTE,
  MAX_FILE_BYTES,
  UNKNOWN_MAX_PAGES,
} from "@/lib/extract/types";
import type { ExtractionResult, GlmEngineInfo, OcrProvider } from "@/lib/extract/types";

describe("isAllowedExtension", () => {
  it("accepts allowed extensions case-insensitively", () => {
    expect(isAllowedExtension("chapter.PDF")).toBe(true);
    expect(isAllowedExtension("notes.docx")).toBe(true);
    expect(isAllowedExtension("slide.png")).toBe(true);
  });

  it("rejects disallowed and extensionless files", () => {
    expect(isAllowedExtension("script.exe")).toBe(false);
    expect(isAllowedExtension("noext")).toBe(false);
  });
});

describe("sanitizeStorageFilename", () => {
  it("strips path separators and parent-directory references", () => {
    expect(sanitizeStorageFilename("../../victim/file.pdf")).toBe("victimfile.pdf");
    expect(sanitizeStorageFilename("a\\b\\c.txt")).toBe("abc.txt");
    expect(sanitizeStorageFilename("..\\..\\evil.pdf")).toBe("evil.pdf");
  });

  it("preserves a normal filename", () => {
    expect(sanitizeStorageFilename("chapter.2024.notes.pdf")).toBe("chapter.2024.notes.pdf");
  });

  it("falls back to a timestamped name when nothing safe remains", () => {
    const out = sanitizeStorageFilename("..");
    expect(out).toMatch(/^file-\d+$/);
  });

  it("preserves a valid extension for dot-only names (audit-3 INJ-F3)", () => {
    // `.pdf` passes isAllowedExtension but the stripping rules delete the
    // leading dot, leaving `<uuid>-pdf` — an extensionless stem that
    // detectNativeType rejects. Keep the extension so the API-only path
    // degrades sanely instead of throwing unsupported_file_type.
    const out = sanitizeStorageFilename(".pdf");
    expect(out).toMatch(/^file-\d+\.pdf$/);
    expect(out.split(".").pop()).toBe("pdf");
    expect(isAllowedExtension(out)).toBe(true);
  });

  it("does not fabricate an allowed extension for a dot-only disallowed name", () => {
    // `.exe` fails isAllowedExtension (the upload gate rejects it), so the
    // INJ-F3 preservation rule must not apply — no `.exe` extension is minted.
    expect(sanitizeStorageFilename(".exe")).toBe("exe");
  });
});

describe("base64ByteLength", () => {
  it("computes decoded bytes for a data URL", () => {
    // "hello" = 5 bytes → base64 "aGVsbG8=" (8 chars, 1 padding).
    expect(base64ByteLength("data:image/png;base64,aGVsbG8=")).toBe(5);
  });

  it("handles padding-free base64", () => {
    // "abc" = 3 bytes → "YWJj" (no padding).
    expect(base64ByteLength("YWJj")).toBe(3);
  });
});

describe("batch", () => {
  it("splits into sequential batches of at most size", () => {
    expect(batch([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns a single batch when size exceeds length", () => {
    expect(batch([1, 2], 5)).toEqual([[1, 2]]);
  });
});

describe("provider-aware page caps (gate G3/G6)", () => {
  it("keeps the local cap at 200 and the remote cap at the interim 30", () => {
    // The LOCAL rasterizer's CPU bound must not move when the remote cap lands:
    // the two legs are capped independently and a shared constant would let one
    // leg's change silently alter the other's behaviour.
    expect(MAX_OCR_PAGES).toBe(200);
    expect(MAX_OCR_PAGES_REMOTE).toBe(30);
  });

  it("keeps the remote cap below the local cap", () => {
    // The remote leg is billed per token and is the binding constraint; if a
    // future edit inverts this, the client pre-flight would be the looser gate.
    expect(MAX_OCR_PAGES_REMOTE).toBeLessThan(MAX_OCR_PAGES);
  });

  it("the client upload cap stays under the remote PDF allowance", () => {
    // Documented residual: MAX_FILE_BYTES (25 MB) < the remote 50 MB allowance,
    // so the UI can never reach the full remote PDF allowance.
    expect(MAX_FILE_BYTES).toBeLessThan(50 * 1024 * 1024);
  });
});

describe("remote result contract (gate G6 — types only, compile-time pins)", () => {
  it("allows a remote result with wholeDocumentRetry and NO pageTexts", () => {
    // The load-bearing shape: the remote leg must be expressible WITHOUT
    // pageTexts, because md_results has no page boundaries. If a future change
    // makes `pageTexts` required, this stops compiling.
    const remote: ExtractionResult = {
      text: "| a | b |",
      pages: 12,
      engine: "glm",
      provider: "remote",
      wholeDocumentRetry: true,
      lowConfidence: true,
      totalPages: 12,
      pagesAttempted: 12,
    };
    expect(remote.pageTexts).toBeUndefined();
    expect(remote.provider).toBe<OcrProvider>("remote");
  });

  it("allows a local result with per-page text and no retry flag", () => {
    const local: ExtractionResult = {
      text: "page one\n\npage two",
      pages: 2,
      engine: "glm",
      pageTexts: ["page one", "page two"],
      totalPages: 2,
      pagesAttempted: 2,
    };
    expect(local.pageTexts).toHaveLength(2);
    expect(local.wholeDocumentRetry).toBeUndefined();
  });

  it("a probe payload carries the provider and all three caps", () => {
    const info: GlmEngineInfo = {
      available: true,
      reason: "ok",
      provider: "remote",
      maxPages: 30,
      maxImageBytes: 10 * 1024 * 1024,
      maxPdfBytes: 50 * 1024 * 1024,
    };
    expect(Object.keys(info).sort()).toEqual([
      "available",
      "maxImageBytes",
      "maxPages",
      "maxPdfBytes",
      "provider",
      "reason",
    ]);
  });
});

describe("OcrProvider union (defect #1 — other agents' code reads this)", () => {
  it("is exactly local | remote | unknown", () => {
    // Pinned as a compile-time + runtime contract: `unknown` is the honest
    // state for a probe that could not identify the leg, and NO code may
    // assume it is one of the two real legs.
    const providers: OcrProvider[] = ["local", "remote", "unknown"];
    expect(providers).toEqual(["local", "remote", "unknown"]);
    expect(providers).toHaveLength(3);
  });

  it("lets an unknown provider be expressed on a probe payload", () => {
    // A failed probe: unavailable, unidentified, and NO fabricated local cap.
    const info: GlmEngineInfo = {
      available: false,
      reason: "unreachable",
      provider: "unknown",
      maxPages: UNKNOWN_MAX_PAGES,
      maxImageBytes: 0,
      maxPdfBytes: 0,
    };
    expect(info.provider).toBe<OcrProvider>("unknown");
    expect(info.maxPages).toBe(0);
    // The local cap is deliberately NOT what an unknown leg reports.
    expect(info.maxPages).not.toBe(MAX_OCR_PAGES);
  });

  it("keeps UNKNOWN_MAX_PAGES out of the real cap range", () => {
    // 0 cannot be confused with a legitimate cap: both legs enforce >= 1 page.
    expect(UNKNOWN_MAX_PAGES).toBe(0);
    expect(UNKNOWN_MAX_PAGES).toBeLessThan(1);
  });

  it("lets an unknown page count be expressed on a result (defect #7)", () => {
    // The remote leg reports `numPages: null` / `pages: null` when the count is
    // genuinely unknown. `pages: 0` + `pageCountKnown: false` is the honest
    // shape — never a fabricated 1.
    const remote: ExtractionResult = {
      text: "whole doc markdown",
      pages: 0,
      engine: "glm",
      provider: "remote",
      totalPages: 0,
      pagesAttempted: 0,
      pageCountKnown: false,
    };
    expect(remote.pages).toBe(0);
    expect(remote.pageCountKnown).toBe(false);
    expect(remote.pages).not.toBe(1);
  });
});
