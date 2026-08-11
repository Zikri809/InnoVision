import { describe, it, expect } from "vitest";
import { GenerateQuizSchema, normalizePath } from "@/lib/ai/validation";

describe("sourcePath — accepts valid storage paths", () => {
  it("accepts a simple path", () => {
    const r = GenerateQuizSchema.safeParse({
      quizId: "00000000-0000-4000-8000-00000000000c",
      sourcePath: "00000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-00000000000c/chapter.pdf",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a multi-dot filename like v2.1.notes.pdf", () => {
    const r = GenerateQuizSchema.safeParse({
      quizId: "00000000-0000-4000-8000-00000000000c",
      sourcePath: "00000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-00000000000c/v2.1.notes.pdf",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a filename with internal hyphens and underscores", () => {
    const r = GenerateQuizSchema.safeParse({
      quizId: "00000000-0000-4000-8000-00000000000c",
      sourcePath: "00000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-00000000000c/Chapter_2024-final-v3.docx",
    });
    expect(r.success).toBe(true);
  });
});

describe("sourcePath — rejects traversal and malformed paths", () => {
  const bad: Array<[string, string]> = [
    ["Classic `../` traversal", "../00000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-00000000000c/secret.pdf"],
    ["`../` embedded mid-path", "00000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-00000000000c/a/../b.pdf"],
    ["URL-encoded `..`", "00000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-00000000000c/%2e%2e/x.pdf"],
    ["Double slash (empty segment)", "00000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-00000000000c//double.pdf"],
    ["Leading-slash escape", "../00000000-0000-4000-8000-00000000000a/x.pdf"],
    ["Dot-only segment", "00000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-00000000000c/./x.pdf"],
  ];
  for (const [name, sample] of bad) {
    it(`rejects: ${name}`, () => {
      const r = GenerateQuizSchema.safeParse({
        quizId: "00000000-0000-4000-8000-00000000000c",
        sourcePath: sample,
      });
      expect(r.success).toBe(false);
    });
  }
});

describe("normalizePath — POSIX path normalizer", () => {
  it("returns input unchanged when already canonical", () => {
    expect(normalizePath("a/b/c")).toBe("a/b/c");
  });

  it("preserves a leading slash", () => {
    expect(normalizePath("/a/b/c")).toBe("/a/b/c");
  });

  it("collapses `.` segments", () => {
    expect(normalizePath("a/./b/./c")).toBe("a/b/c");
  });

  it("collapses `..` segments", () => {
    expect(normalizePath("a/b/../c")).toBe("a/c");
  });

  it("collapses a trailing empty segment", () => {
    // The normalizer's `split("/")` skips empty segments, so a trailing
    // slash is collapsed — the regex already rejects trailing slashes, so
    // this just documents the normalizer's behavior.
    expect(normalizePath("a/b/")).toBe("a/b");
  });
});
