import { describe, expect, it } from "vitest";
import {
  DISPLAY_TIME_ZONE,
  formatDue,
  formatWindow,
  windowIsoToLocalInput,
  windowLocalInputToIso,
} from "./window";

describe("windowLocalInputToIso", () => {
  it("parses a datetime-local value as a wall-clock in DISPLAY_TIME_ZONE (KL, UTC+8)", () => {
    // audit-3 C-F3: the input and the display surfaces share ONE zone, so
    // "14:30" typed by a lecturer means 14:30 KL = 06:30Z.
    expect(windowLocalInputToIso("2026-09-01T14:30")).toBe("2026-09-01T06:30:00.000Z");
  });

  it("parses seconds precision", () => {
    expect(windowLocalInputToIso("2026-09-01T14:30:45")).toBe("2026-09-01T06:30:45.000Z");
  });

  it("empty / whitespace → null (unbounded endpoint)", () => {
    expect(windowLocalInputToIso("")).toBeNull();
    expect(windowLocalInputToIso("   ")).toBeNull();
    expect(windowLocalInputToIso(null)).toBeNull();
    expect(windowLocalInputToIso(undefined)).toBeNull();
  });

  it("garbage → null (never throws)", () => {
    expect(windowLocalInputToIso("not-a-date")).toBeNull();
    expect(windowLocalInputToIso("2026-13-99T99:99")).toBeNull();
    expect(windowLocalInputToIso("2026-09-01")).toBeNull();
  });

  it("rejects calendar overflow instead of rolling it over", () => {
    expect(windowLocalInputToIso("2026-02-30T10:00")).toBeNull();
    expect(windowLocalInputToIso("2026-04-31T10:00")).toBeNull();
  });
});

describe("windowIsoToLocalInput", () => {
  it("round-trips with the parse side", () => {
    const iso = "2026-09-01T06:30:00.000Z";
    expect(windowIsoToLocalInput(iso)).toBe("2026-09-01T14:30");
    expect(windowLocalInputToIso(windowIsoToLocalInput(iso))).toBe(iso);
  });

  it("renders the instant in DISPLAY_TIME_ZONE, not UTC", () => {
    // 02:00Z = 10:00 KL — the same wall-clock formatWindow shows.
    expect(windowIsoToLocalInput("2026-09-01T02:00:00.000Z")).toBe("2026-09-01T10:00");
  });

  it("null/unparseable → empty input", () => {
    expect(windowIsoToLocalInput(null)).toBe("");
    expect(windowIsoToLocalInput("junk")).toBe("");
  });
});

describe("formatWindow", () => {
  it("renders both endpoints joined by an en dash", () => {
    const line = formatWindow("2026-09-01T02:00:00.000Z", "2026-09-01T06:00:00.000Z", "en");
    // Display tz is fixed KL (UTC+8): 02:00Z = 10:00 local.
    expect(line).toMatch(/Sep 1/);
    expect(line).toMatch(/10:00 AM/);
    expect(line).toMatch(/2:00 PM/);
    expect(line).toContain("–");
  });

  it("renders one endpoint only", () => {
    const only = formatWindow(null, "2026-09-01T06:00:00.000Z", "en");
    expect(only).not.toContain("–");
    expect(only).toMatch(/2:00 PM/);
  });

  it("returns '' when both endpoints are absent", () => {
    expect(formatWindow(null, null, "en")).toBe("");
    expect(formatWindow(undefined, undefined, "en")).toBe("");
  });

  it("ms locale tags the Malay formatter", () => {
    const msLine = formatWindow("2026-09-01T02:00:00.000Z", null, "ms");
    expect(msLine.length).toBeGreaterThan(0);
  });

  it("pins the display timezone constant (house convention)", () => {
    expect(DISPLAY_TIME_ZONE).toBe("Asia/Kuala_Lumpur");
  });

  it("unparseable input is dropped, not thrown", () => {
    expect(formatWindow("junk", "2026-09-01T06:00:00.000Z", "en")).not.toContain("junk");
  });
});

describe("formatDue", () => {
  it("renders weekday + date + time in Asia/Kuala_Lumpur for en locale", () => {
    const line = formatDue("2026-09-01T06:00:00.000Z", "en");
    expect(line).not.toBeNull();
    expect(line).toMatch(/Tue/);
    expect(line).toMatch(/Sep/);
    expect(line).toMatch(/1/);
    expect(line).toMatch(/2:00 PM/);
  });

  it("ms locale tags the Malay weekday/month format", () => {
    const msLine = formatDue("2026-09-01T06:00:00.000Z", "ms");
    expect(msLine).not.toBeNull();
    expect(msLine?.length).toBeGreaterThan(0);
    expect(msLine).toMatch(/Sel/);
  });

  it("null, undefined, or empty returns null", () => {
    expect(formatDue(null)).toBeNull();
    expect(formatDue(undefined)).toBeNull();
    expect(formatDue("")).toBeNull();
  });

  it("unparseable input returns null without throwing", () => {
    expect(formatDue("garbage-date")).toBeNull();
  });
});