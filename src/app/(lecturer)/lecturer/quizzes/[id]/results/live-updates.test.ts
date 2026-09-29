import { describe, it, expect } from "vitest";
import { LIVE_REFRESH_MS, shouldLiveRefresh } from "./live-updates";

describe("shouldLiveRefresh (A4 live-updates predicate)", () => {
  it("refreshes when visible, no dialog, nothing busy", () => {
    expect(shouldLiveRefresh({ hidden: false, dialogOpen: false, busy: false })).toBe(true);
  });

  it("pauses while the tab is hidden", () => {
    expect(shouldLiveRefresh({ hidden: true, dialogOpen: false, busy: false })).toBe(false);
  });

  it("pauses while any dialog is open (reveal/close/exempt/reset)", () => {
    expect(shouldLiveRefresh({ hidden: false, dialogOpen: true, busy: false })).toBe(false);
  });

  it("pauses while a row action is busy (unlock/exempt/reset/reveal/close/export)", () => {
    expect(shouldLiveRefresh({ hidden: false, dialogOpen: false, busy: true })).toBe(false);
  });

  it("pins the 8s cadence", () => {
    expect(LIVE_REFRESH_MS).toBe(8000);
  });
});
