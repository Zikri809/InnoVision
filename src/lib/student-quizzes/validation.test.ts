import { describe, it, expect } from "vitest";
import {
  CreateStudentQuizSchema,
  UpdateStudentQuizSchema,
  stripBidiControls,
} from "./validation";

describe("stripBidiControls", () => {
  it("removes bidi overrides / zero-width / soft-hyphen characters", () => {
    const dirty = "\u202EReverse\u202C\u200B\uFEFF\u00ADtitle";
    expect(stripBidiControls(dirty)).toBe("Reversetitle");
  });

  it("leaves normal text untouched", () => {
    expect(stripBidiControls("Chapter 5 — Circuits")).toBe("Chapter 5 — Circuits");
  });
});

describe("CreateStudentQuizSchema", () => {
  it("accepts title + optional description and trims", () => {
    const r = CreateStudentQuizSchema.safeParse({ title: "  My Quiz  " });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.title).toBe("My Quiz");
      expect(r.data.description).toBeFalsy();
    }
  });

  it("sanitizes bidi characters out of the title before length checks", () => {
    const r = CreateStudentQuizSchema.safeParse({ title: "\u202EMy\u202C Quiz" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.title).toBe("My Quiz");
  });

  it("rejects empty-after-trim titles and >500 descriptions", () => {
    expect(CreateStudentQuizSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(
      CreateStudentQuizSchema.safeParse({
        title: "T",
        description: "x".repeat(501),
      }).success,
    ).toBe(false);
  });
});

describe("UpdateStudentQuizSchema", () => {
  it("allows each field independently incl. share actions", () => {
    expect(UpdateStudentQuizSchema.safeParse({ action: "share" }).success).toBe(true);
    expect(UpdateStudentQuizSchema.safeParse({ action: "unshare" }).success).toBe(true);
    expect(UpdateStudentQuizSchema.safeParse({ action: "regenerate" }).success).toBe(true);
    expect(UpdateStudentQuizSchema.safeParse({ title: "New" }).success).toBe(true);
    expect(UpdateStudentQuizSchema.safeParse({ description: null }).success).toBe(true);
  });

  it("rejects unknown actions and empty updates", () => {
    expect(UpdateStudentQuizSchema.safeParse({ action: "nuke" }).success).toBe(false);
    expect(UpdateStudentQuizSchema.safeParse({}).success).toBe(false);
  });

  it("rejects mixing a share action with content edits (exclusive payloads)", () => {
    expect(
      UpdateStudentQuizSchema.safeParse({ action: "unshare", title: "New" }).success,
    ).toBe(false);
    expect(
      UpdateStudentQuizSchema.safeParse({ action: "share", description: "d" }).success,
    ).toBe(false);
  });
});
