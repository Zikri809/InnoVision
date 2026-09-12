import { describe, it, expect } from "vitest";
import { shouldFlushIncident, incidentClipReason } from "./incident-transition";

/**
 * Incident-recorder privacy contract, pinned as a pure predicate (0044).
 *
 * The audit (2026-09) found the hook's flush branch was DEAD CODE: the
 * previous status was kept in a ref the effect cleanup nulled on every
 * dependency change, so `prev` was always null at effect entry and NO
 * incident clip was ever uploaded. These tests pin the transition table the
 * hook must follow — the privacy contract ("nothing uploaded unless an
 * incident happens") lives here now.
 */
describe("shouldFlushIncident", () => {
  it("flushes on verified→incident edges (ready → paused/flagged/unavailable)", () => {
    expect(shouldFlushIncident("ready", "paused")).toBe(true);
    expect(shouldFlushIncident("ready", "flagged")).toBe(true);
    expect(shouldFlushIncident("ready", "unavailable")).toBe(true);
  });

  it("flushes from 'recovering' too (unlock re-verify routes flagged→recovering→paused)", () => {
    expect(shouldFlushIncident("recovering", "paused")).toBe(true);
    expect(shouldFlushIncident("recovering", "flagged")).toBe(true);
    expect(shouldFlushIncident("recovering", "unavailable")).toBe(true);
  });

  it("never flushes when the previous status is not a verified origin", () => {
    expect(shouldFlushIncident(null, "paused")).toBe(false); // first observation
    expect(shouldFlushIncident("paused", "flagged")).toBe(false);
    expect(shouldFlushIncident("flagged", "paused")).toBe(false);
    expect(shouldFlushIncident("unavailable", "paused")).toBe(false);
  });

  it("never flushes on arm/resume (→ ready is a START, not an incident)", () => {
    expect(shouldFlushIncident("ready", "ready")).toBe(false);
    expect(shouldFlushIncident("paused", "ready")).toBe(false);
    expect(shouldFlushIncident("recovering", "ready")).toBe(false);
    expect(shouldFlushIncident(null, "ready")).toBe(false);
  });

  it("the regression shape: prev=null (stale-cleanup bug) must NOT flush", () => {
    // This is the exact dead-branch failure mode — a null prev silently
    // ate every ready→paused edge for the life of the feature.
    expect(shouldFlushIncident(null, "paused")).toBe(false);
    expect(shouldFlushIncident(null, "flagged")).toBe(false);
  });
});

describe("incidentClipReason", () => {
  it("labels a paused incident with its CAUSE, not the bare status", () => {
    expect(incidentClipReason("paused", "focus_lost")).toBe("focus_lost");
    expect(incidentClipReason("paused", "fullscreen_exit")).toBe("fullscreen_exit");
    expect(incidentClipReason("paused", "face")).toBe("face");
  });

  it("keeps the status token for flagged/unavailable incidents", () => {
    expect(incidentClipReason("flagged", "face")).toBe("flagged");
    expect(incidentClipReason("unavailable", "face")).toBe("unavailable");
  });
});
