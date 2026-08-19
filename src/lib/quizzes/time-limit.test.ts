import { describe, it, expect, vi } from "vitest";
import { secondsToHm, hmToSeconds, HOURS_MAX, MINUTES_MAX } from "./time-limit";
import { formatDuration } from "@/lib/format/duration";

describe("time-limit utilities (U-M14..U-M18)", () => {
  it("U-M14 converts valid seconds to {hours, minutes}", () => {
    expect(secondsToHm(null)).toEqual({ hours: 0, minutes: 0 });
    expect(secondsToHm(-100)).toEqual({ hours: 0, minutes: 0 }); // Negative clamped to 0
    expect(secondsToHm(NaN)).toEqual({ hours: 0, minutes: 0 }); // NaN clamped to 0
    expect(secondsToHm(60)).toEqual({ hours: 0, minutes: 1 });
    expect(secondsToHm(4500)).toEqual({ hours: 1, minutes: 15 });
    expect(secondsToHm(7200)).toEqual({ hours: 2, minutes: 0 });
    expect(secondsToHm(59)).toEqual({ hours: 0, minutes: 0 }); // Sub-minute floor
  });

  it("U-M15 clamps out-of-bounds seconds and logs warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(secondsToHm(9000)).toEqual({ hours: 2, minutes: 0 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("exceeds 7200"));
    warnSpy.mockRestore();
  });

  it("U-M16 converts hours and minutes to seconds", () => {
    expect(hmToSeconds(0, 0)).toBeNull();
    expect(hmToSeconds(0, 1)).toBe(60);
    expect(hmToSeconds(1, 15)).toBe(4500);
    expect(hmToSeconds(2, 0)).toBe(7200);
  });

  it("U-M17 performs lossless conversion without premature clamping", () => {
    expect(hmToSeconds(2, 30)).toBe(9000);
    expect(hmToSeconds(1.9, 30.8)).toBe(5400); // Truncates floats
    expect(hmToSeconds(NaN, 5)).toBeNull();
    expect(hmToSeconds(-1, -10)).toBeNull();
    expect(HOURS_MAX).toBe(2);
    expect(MINUTES_MAX).toBe(59);
  });

  it("U-M18 maintains alignment between form state and formatDuration", () => {
    expect(secondsToHm(60)).toEqual({ hours: 0, minutes: 1 });
    expect(formatDuration(60)).toBe("1m");
    expect(secondsToHm(7200)).toEqual({ hours: 2, minutes: 0 });
    expect(formatDuration(7200)).toBe("2h");
  });
});
