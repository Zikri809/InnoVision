import { describe, it, expect } from "vitest";
import {
  normalizeMatric,
  normalizeMatricShape,
  isSystemAssignedMatric,
  sanitizeFilenamePart,
} from "./matric";

describe("normalizeMatric (6-digit contract)", () => {
  it("accepts an exact 6-digit matric", () => {
    expect(normalizeMatric("231456")).toEqual({ ok: true, value: "231456" });
  });

  it("deletes surrounding and internal whitespace before validating", () => {
    expect(normalizeMatric(" 231456 ")).toEqual({ ok: true, value: "231456" });
    expect(normalizeMatricShape("23\t14\n56")).toBe("231456");
    expect(normalizeMatric("2 3 1 4 5 6")).toEqual({ ok: true, value: "231456" });
  });

  it("rejects empty after normalization", () => {
    expect(normalizeMatric("   ").ok).toBe(false);
    expect(normalizeMatric("").ok).toBe(false);
  });

  it("rejects wrong digit counts (5 and 7)", () => {
    expect(normalizeMatric("23145")).toMatchObject({ ok: false, reason: "invalid" });
    expect(normalizeMatric("2314567")).toMatchObject({ ok: false, reason: "too_long" });
  });

  it("rejects letters, dashes, and other characters outright", () => {
    expect(normalizeMatric("A23456")).toMatchObject({ ok: false, reason: "invalid" });
    expect(normalizeMatric("23-1456")).toMatchObject({ ok: false, reason: "invalid" });
    expect(normalizeMatric("23.456")).toMatchObject({ ok: false, reason: "invalid" });
    expect(normalizeMatric("٢٣١٤٥٦")).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("rejects the reserved system 99xxxx range", () => {
    expect(normalizeMatric("990001")).toMatchObject({ ok: false, reason: "reserved" });
    expect(normalizeMatric("999999")).toMatchObject({ ok: false, reason: "reserved" });
    // A different leading pair is an ordinary student number.
    expect(normalizeMatric("981234").ok).toBe(true);
  });

  it("rejects non-string input defensively", () => {
    // @ts-expect-error runtime guard for untrusted input
    expect(normalizeMatric(null).ok).toBe(false);
    // @ts-expect-error runtime guard for untrusted input
    expect(normalizeMatric(undefined).ok).toBe(false);
  });
});

describe("isSystemAssignedMatric", () => {
  it("detects generated backfill numbers", () => {
    expect(isSystemAssignedMatric("990001")).toBe(true);
    expect(isSystemAssignedMatric("997512")).toBe(true);
  });

  it("does not flag real or missing matrics", () => {
    expect(isSystemAssignedMatric("981234")).toBe(false);
    expect(isSystemAssignedMatric(null)).toBe(false);
    expect(isSystemAssignedMatric(undefined)).toBe(false);
    expect(isSystemAssignedMatric("")).toBe(false);
  });
});

describe("sanitizeFilenamePart", () => {
  it("passes clean titles through", () => {
    expect(sanitizeFilenamePart("Quiz 3 - Photosynthesis")).toBe("Quiz 3 - Photosynthesis");
  });

  it("strips CRLF, quotes, backslashes, and formula leads", () => {
    expect(sanitizeFilenamePart('=cmd|"/C calc"')).not.toMatch(/[=|"\\/]/);
    expect(sanitizeFilenamePart("Bad\r\ntitle")).not.toMatch(/[\r\n]/);
    expect(sanitizeFilenamePart("back\\slash")).not.toMatch(/\\/);
  });

  it("falls back to quiz when nothing survives", () => {
    expect(sanitizeFilenamePart("===+++@@@")).toBe("quiz");
    expect(sanitizeFilenamePart(null)).toBe("quiz");
    expect(sanitizeFilenamePart(undefined)).toBe("quiz");
    expect(sanitizeFilenamePart("")).toBe("quiz");
  });

  it("caps length at 80 chars without trailing separators", () => {
    const long = "Q".repeat(120) + "-";
    const out = sanitizeFilenamePart(long);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("-") || out.endsWith(" ")).toBe(false);
  });
});
