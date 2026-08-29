import { describe, it, expect, afterEach, vi } from "vitest";
import { isFakeFaceSeamEnabled } from "./seam-gate";
import { getFakeFaceTracker } from "./fake-seam";

/**
 * Seam-gate default-off posture: the fake tracker seams must be INERT unless
 * the Playwright harness explicitly opts in (NEXT_PUBLIC_E2E_FAKE_SEAM=1 in
 * playwright.config.ts webServer env). A production deployment never sets it,
 * so a stray global injection is still inert.
 */
describe("seam gate (default-off)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as Record<string, unknown>)[
      "__INNOVISION_FAKE_FACE_TRACKER__"
    ];
  });

  it("is OFF when the harness flag is unset", () => {
    delete process.env.NEXT_PUBLIC_E2E_FAKE_SEAM;
    expect(isFakeFaceSeamEnabled()).toBe(false);
  });

  it("is ON only for the exact harness value", () => {
    process.env.NEXT_PUBLIC_E2E_FAKE_SEAM = "1";
    expect(isFakeFaceSeamEnabled()).toBe(true);
    process.env.NEXT_PUBLIC_E2E_FAKE_SEAM = "true";
    expect(isFakeFaceSeamEnabled()).toBe(false);
    process.env.NEXT_PUBLIC_E2E_FAKE_SEAM = "";
    expect(isFakeFaceSeamEnabled()).toBe(false);
  });

  it("a well-shaped injected global is still INERT without the flag", () => {
    // Simulate an extension/3P script planting the fake tracker global in a
    // production page: the gate keeps getFakeFaceTracker() out of the boot
    // path (the hook consults the gate BEFORE the accessor).
    delete process.env.NEXT_PUBLIC_E2E_FAKE_SEAM;
    (globalThis as Record<string, unknown>)["__INNOVISION_FAKE_FACE_TRACKER__"] = {
      start: () => {},
      stop: () => {},
      captureFrame: async () => null,
      waitForBlink: async () => "passed" as const,
    };
    // The accessor itself is shape-based; the GATE is what the boot effect
    // consults first — assert the gate stays closed.
    expect(isFakeFaceSeamEnabled()).toBe(false);
    // Documented contract: boot code is `gate && accessor()`.
    expect(isFakeFaceSeamEnabled() ? getFakeFaceTracker() : undefined).toBeUndefined();
  });
});
