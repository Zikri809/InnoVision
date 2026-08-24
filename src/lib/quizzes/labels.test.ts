import { describe, it, expect } from "vitest";
import {
  STATUS_LABEL,
  STATUS_CLASS,
  MODE_LABEL,
  MODE_CLASS,
  getStatusLabel,
  getModeLabel,
} from "./labels";

describe("labels constants and classes (U-M19..U-M20)", () => {
  it("U-M19 defines human-readable labels for all statuses and modes", () => {
    expect(STATUS_LABEL.draft).toBe("Draft");
    expect(STATUS_LABEL.live).toBe("Live");
    expect(STATUS_LABEL.closed).toBe("Closed");

    expect(MODE_LABEL.practice).toBe("Practice");
    expect(MODE_LABEL.assessment).toBe("Assessment");
  });

  it("U-M20 defines styling tokens with dark mode support and AAA contrast for statuses and modes", () => {
    expect(STATUS_CLASS.draft).toContain("border-border");
    expect(STATUS_CLASS.draft).toContain("text-stone-700");
    expect(STATUS_CLASS.draft).toContain("dark:text-stone-300");

    expect(STATUS_CLASS.live).toContain("border-emerald-300");
    expect(STATUS_CLASS.live).toContain("text-emerald-800");

    expect(STATUS_CLASS.closed).toContain("border-destructive");
    expect(STATUS_CLASS.closed).toContain("text-red-800");
    expect(STATUS_CLASS.closed).toContain("dark:text-red-300");

    expect(MODE_CLASS.practice).toContain("border-emerald-300");
    expect(MODE_CLASS.practice).toContain("text-emerald-800");
    expect(MODE_CLASS.practice).toContain("dark:border-emerald-700/50");

    expect(MODE_CLASS.assessment).toContain("border-blue-300");
    expect(MODE_CLASS.assessment).toContain("text-blue-900");
    expect(MODE_CLASS.assessment).toContain("dark:border-blue-700/50");
  });

  it("U-M21 getStatusLabel resolves English labels by default and for explicit en", () => {
    expect(getStatusLabel("draft")).toBe("Draft");
    expect(getStatusLabel("live")).toBe("Live");
    expect(getStatusLabel("closed")).toBe("Closed");
    expect(getStatusLabel("live", "en")).toBe("Live");
  });

  it("U-M21b getStatusLabel falls back to the raw status for unknown locales", () => {
    expect(getStatusLabel("live", "fr")).toBe("Live");
  });

  it("U-M22 getModeLabel resolves Malay labels and falls back to raw mode", () => {
    expect(getModeLabel("practice", "ms")).toBe("Latihan");
    expect(getModeLabel("assessment", "ms")).toBe("Penilaian");
    expect(getModeLabel("assessment", "xx")).toBe("Assessment");
  });

  it("U-M23 defensive fallback: unknown enum value echoes itself (never undefined)", () => {
    const bogus = "archived" as Parameters<typeof getStatusLabel>[0];
    expect(getStatusLabel(bogus)).toBe("archived");
    expect(getStatusLabel(bogus, "ms")).toBe("archived");
    const bogusMode = "quiz" as Parameters<typeof getModeLabel>[0];
    expect(getModeLabel(bogusMode)).toBe("quiz");
    expect(getModeLabel(bogusMode, "ms")).toBe("quiz");
  });
});
