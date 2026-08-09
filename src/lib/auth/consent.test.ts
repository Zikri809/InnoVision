import { describe, it, expect } from "vitest";
import { isSameTimestamp } from "@/lib/auth/consent";

describe("isSameTimestamp", () => {
  it("matches identical instants across Z and +00:00 serializations", () => {
    const expected = "2026-08-09T05:12:35.862Z";
    // What PostgREST returns for the same timestamptz.
    const stored = "2026-08-09T05:12:35.862+00:00";
    expect(isSameTimestamp(stored, expected)).toBe(true);
  });

  it("matches when both are Z-form", () => {
    const expected = "2026-08-09T05:12:35.862Z";
    expect(isSameTimestamp(expected, expected)).toBe(true);
  });

  it("returns false for different instants", () => {
    expect(
      isSameTimestamp("2026-08-09T05:12:35.862Z", "2026-08-09T05:12:36.862Z"),
    ).toBe(false);
  });

  it("returns false for null/undefined/invalid stored values", () => {
    expect(isSameTimestamp(null, "2026-08-09T05:12:35.862Z")).toBe(false);
    expect(isSameTimestamp(undefined, "2026-08-09T05:12:35.862Z")).toBe(false);
    expect(isSameTimestamp("not-a-date", "2026-08-09T05:12:35.862Z")).toBe(false);
  });
});
