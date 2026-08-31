import { describe, expect, it } from "vitest";
import { ALL_MILESTONES, ASSERTIVE_THRESHOLD_MS, milestoneFor } from "./timer-milestones";
// Import the ACTUAL HUD constant (not a duplicate literal): the s30 boundary
// and the red flip must move together.
import { WARNING_THRESHOLD_MS } from "@/components/quiz/progress-hud";

describe("AX-3 — milestoneFor", () => {
  it("returns null above the first milestone and at/under zero", () => {
    expect(milestoneFor(601_000)).toBeNull();
    expect(milestoneFor(0)).toBeNull();
    expect(milestoneFor(-1_000)).toBeNull();
  });

  it("fires each milestone at its inclusive upper bound", () => {
    expect(milestoneFor(600_000)).toBe("m10");
    expect(milestoneFor(599_000)).toBe("m10");
    expect(milestoneFor(300_000)).toBe("m5");
    expect(milestoneFor(60_000)).toBe("m1");
    expect(milestoneFor(30_000)).toBe("s30");
    expect(milestoneFor(1_000)).toBe("s30");
  });

  it("keeps s30 across the whole final band (single assertive window)", () => {
    expect(milestoneFor(29_999)).toBe("s30");
    expect(milestoneFor(15_000)).toBe("s30");
  });

  it("aligns the s30 boundary with the HUD's red-flip threshold (30s)", () => {
    // progress-hud's WARNING_THRESHOLD_MS (imported, not duplicated) must
    // equal the assertive milestone's boundary — the urgent warning and the
    // visual red flip coincide. If the HUD ever moves its threshold, this
    // fails to force a re-look.
    expect(ASSERTIVE_THRESHOLD_MS).toBe(WARNING_THRESHOLD_MS);
  });

  it("exposes the full milestone set for announced-set seeding", () => {
    expect(ALL_MILESTONES).toEqual(["m10", "m5", "m1", "s30"]);
  });
});
