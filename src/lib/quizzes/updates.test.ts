import { describe, it, expect } from "vitest";
import { buildQuizUpdates } from "./updates";

describe("buildQuizUpdates (U-M7..U-M13)", () => {
  it("U-M7 forces time_limit_sec to null when switching to practice mode", () => {
    const res = buildQuizUpdates({ mode: "practice" }, "assessment");
    expect(res).toEqual({ mode: "practice", time_limit_sec: null });
  });

  it("U-M8 forces time_limit_sec to null when mode is practice even if timeLimitSec supplied", () => {
    const res = buildQuizUpdates({ mode: "practice", timeLimitSec: 1800 }, "assessment");
    expect(res).toEqual({ mode: "practice", time_limit_sec: null });
  });

  it("U-M9 wipes time_limit_sec when mode is omitted but current quiz is practice", () => {
    const res = buildQuizUpdates({ timeLimitSec: 1800 }, "practice");
    expect(res).toEqual({ time_limit_sec: null });
  });

  it("U-M10 preserves timeLimitSec when mode is assessment", () => {
    const res = buildQuizUpdates({ mode: "assessment", timeLimitSec: 1800 }, "practice");
    expect(res).toEqual({ mode: "assessment", time_limit_sec: 1800 });
  });

  it("U-M11 allows setting untimed assessment (timeLimitSec: null)", () => {
    const res = buildQuizUpdates({ mode: "assessment", timeLimitSec: null }, "practice");
    expect(res).toEqual({ mode: "assessment", time_limit_sec: null });
  });

  it("U-M12 keeps mode and timeLimitSec untouched on title-only PATCH", () => {
    const res = buildQuizUpdates({ title: "Updated Title" }, "assessment");
    expect(res).toEqual({ title: "Updated Title" });
    expect(res.mode).toBeUndefined();
    expect(res.time_limit_sec).toBeUndefined();
  });

  it("U-M13 returns an immutable object unaffected by subsequent caller mutations", () => {
    const input = { title: "Original", mode: "assessment" as const, timeLimitSec: 600 };
    const updates = buildQuizUpdates(input, "assessment");
    input.title = "Mutated";
    expect(updates.title).toBe("Original");
  });

  it("U-M13b strips extraneous injected properties from update object (prototype pollution & mass assignment defense)", () => {
    const untrustedInput = {
      title: "Safe Title",
      mode: "assessment" as const,
      timeLimitSec: 300,
      status: "live",
      created_by: "00000000-0000-4000-8000-000000000099",
      source_file_url: "https://evil.com/malicious.pdf",
    };

    const updates = buildQuizUpdates(untrustedInput, "practice");
    expect(updates).toEqual({
      title: "Safe Title",
      mode: "assessment",
      time_limit_sec: 300,
    });
    expect((updates as Record<string, unknown>).status).toBeUndefined();
    expect((updates as Record<string, unknown>).created_by).toBeUndefined();
    expect((updates as Record<string, unknown>).source_file_url).toBeUndefined();
  });
});
