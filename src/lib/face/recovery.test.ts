import { describe, it, expect } from "vitest";
import { recoverFlow, recoveryLanding } from "./recovery";

/**
 * U-F7 — recovery flow: a passed blink recovers; a failed blink re-offers.
 * U-F7b — recovery landing: after a gate verify → ready; before any gate
 * verify → gate (the assessment gate must be re-run).
 */
describe("recovery", () => {
  it("U-F7: passed blink → recovered", () => {
    expect(recoverFlow("passed")).toBe("recovered");
  });

  it("U-F7: failed blink → failed (re-offer)", () => {
    expect(recoverFlow("failed")).toBe("failed");
  });

  it("U-F7b: landing after a start verify → ready", () => {
    expect(recoveryLanding(true)).toBe("ready");
  });

  it("U-F7b: landing with no start verify yet → gate", () => {
    expect(recoveryLanding(false)).toBe("gate");
  });
});
