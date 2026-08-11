import { describe, it, expect } from "vitest";
import { sanitizeGlmText } from "@/lib/extract/glm-ocr";

describe("sanitizeGlmText", () => {
  it("collapses a long run of markdown-fence noise to a single fence", () => {
    const noisy =
      "Velocity is the rate of change of displacement.\n" +
      "``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ``` ```";
    const out = sanitizeGlmText(noisy);
    expect(out).toContain("Velocity is the rate of change of displacement.");
    // The fence run is collapsed to a single fence (not dozens).
    expect(out.match(/```/g)?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it("leaves clean text unchanged", () => {
    const clean = "Force equals mass times acceleration.";
    expect(sanitizeGlmText(clean)).toBe(clean);
  });

  it("leaves a single legitimate code fence intact", () => {
    const fenced = "```\nVelocity is the rate of change of displacement.\n```";
    expect(sanitizeGlmText(fenced)).toBe(fenced);
  });
});
