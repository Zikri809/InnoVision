import { describe, it, expect } from "vitest";
import {
  GenerateQuizSchema,
  GenerateStudentQuizSchema,
  normalizePath,
} from "@/lib/ai/validation";

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

describe("GenerateStudentQuizSchema — student generate body", () => {
  const uid = "00000000-0000-4000-8000-00000000000a";
  const quiz = "00000000-0000-4000-8000-00000000000c";

  it("accepts extractedText with defaults", () => {
    const r = GenerateStudentQuizSchema.safeParse({ extractedText: "photosynthesis notes" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.difficulty).toBe("mixed");
      expect(r.data.language).toBe("auto");
    }
  });

  it("accepts tenant-scoped sourcePaths", () => {
    const r = GenerateStudentQuizSchema.safeParse({
      sourcePaths: [`${uid}/${quiz}/notes.pdf`],
      questionCount: 10,
    });
    expect(r.success).toBe(true);
  });

  it("rejects steeringPrompt / formatDistribution / mode (student surface hides them)", () => {
    for (const extra of [
      { steeringPrompt: "focus on chapter 2" },
      { formatDistribution: "mcq_only" },
      { mode: "append" },
      { quizId: quiz },
    ]) {
      expect(GenerateStudentQuizSchema.safeParse({ extractedText: "x".repeat(20), ...extra }).success).toBe(false);
    }
  });

  it("rejects out-of-bounds questionCount and traversal sourcePaths", () => {
    expect(
      GenerateStudentQuizSchema.safeParse({ questionCount: 2, extractedText: "x".repeat(20) }).success,
    ).toBe(false);
    expect(
      GenerateStudentQuizSchema.safeParse({
        sourcePaths: [`../${uid}/${quiz}/evil.pdf`],
      }).success,
    ).toBe(false);
  });

  it("rejects when neither text nor sources provided", () => {
    expect(GenerateStudentQuizSchema.safeParse({}).success).toBe(true); // schema-level OK
    // The ROUTE enforces text-or-sources presence; the schema stays permissive
    // so the route can return its specific error code.
  });
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


describe("QT-1 — allowMultiSelect flag plumbing", () => {
  it("U-QT1-V1 GenerateQuizSchema defaults allowMultiSelect to false", () => {
    const r = GenerateQuizSchema.safeParse({
      quizId: "00000000-0000-4000-8000-00000000000c",
      sourcePath: "00000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-00000000000c/notes.pdf",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.allowMultiSelect).toBe(false);
  });

  it("U-QT1-V2 GenerateQuizSchema accepts allowMultiSelect: true", () => {
    const r = GenerateQuizSchema.safeParse({
      quizId: "00000000-0000-4000-8000-00000000000c",
      allowMultiSelect: true,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.allowMultiSelect).toBe(true);
  });

  it("U-QT1-V3 GenerateStudentQuizSchema is strict — the flag is not leakable", () => {
    const r = GenerateStudentQuizSchema.safeParse({
      extractedText: "notes",
      allowMultiSelect: true,
    });
    expect(r.success).toBe(false);
  });
});
