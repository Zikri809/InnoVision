import { describe, expect, it } from "vitest";
import {
  DISPLAY_TIME_ZONE,
  formatWindow,
  windowIsoToLocalInput,
  windowLocalInputToIso,
} from "./window";

describe("windowLocalInputToIso", () => {
  it("parses a datetime-local value as a UTC instant", () => {
    expect(windowLocalInputToIso("2026-09-01T14:30")).toBe("2026-09-01T14:30:00.000Z");
  });

  it("parses seconds precision", () => {
    expect(windowLocalInputToIso("2026-09-01T14:30:45")).toBe("2026-09-01T14:30:45.000Z");
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
});

describe("windowIsoToLocalInput", () => {
  it("round-trips with the parse side", () => {
    const iso = "2026-09-01T14:30:00.000Z";
    expect(windowIsoToLocalInput(iso)).toBe("2026-09-01T14:30");
    expect(windowLocalInputToIso(windowIsoToLocalInput(iso))).toBe(iso);
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