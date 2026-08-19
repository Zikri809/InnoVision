import { describe, it, expect } from "vitest";
import {
  STATUS_LABEL,
  STATUS_CLASS,
  MODE_LABEL,
  MODE_CLASS,
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
});
