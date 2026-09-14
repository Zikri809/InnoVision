import { describe, it, expect } from "vitest";
import {
  isAllowedExtension,
  sanitizeStorageFilename,
  base64ByteLength,
  batch,
} from "@/lib/extract/types";

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
