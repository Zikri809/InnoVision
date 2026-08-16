import { describe, it, expect } from "vitest";
import { evaluateFaceCheck } from "./streak";

/**
 * U-F6 — FLAT 3-in-5 window.
 *  - F,P,F,P,F → flagged
 *  - continuous V/−V alternation → flagged at the 6th check
 *  - spread-over-8 (never 3 in a window of 5) → never flagged
 *  - pass never flags the current check
 *  - post-unlock single-fail re-flags (standing fails not cleared)
 * U-F7c — paused vs flagged boundary.
 */
describe("evaluateFaceCheck (FLAT last-5)", () => {
  it("3 consecutive fails → flagged", () => {
    // recentChecks = [F,F], current = F → window [F,F,F] → 3 fails → flagged
    expect(evaluateFaceCheck([false, false], false)).toEqual({ status: "flagged", streak: 3 });
  });

  it("2 fails → paused (blink-recoverable)", () => {
    expect(evaluateFaceCheck([false], false)).toEqual({ status: "paused", streak: 2 });
    expect(evaluateFaceCheck([], false)).toEqual({ status: "paused", streak: 1 });
  });

  it("U-F6: F,P,F,P,F → flagged (flat count, no pass truncation)", () => {
    // recent = [F,P,F,P] (most recent last), current = F → window F,P,F,P,F → 3 fails
    expect(evaluateFaceCheck([false, true, false, true], false)).toEqual({
      status: "flagged",
      streak: 3,
    });
  });

  it("U-F6: continuous V/−V alternation → hard-flagged at the 6th check", () => {
    // Alternation starting with a pass: checks 1..5 = P,F,P,F,P (each within a
    // 5-window has <= 2 fails → never flagged), then check 6 = F.
    // The window at check 6 = [F,P,F,P,F] (checks 2..6) → 3 fails → flagged.
    const recent4 = [false, true, false, true]; // checks 2..5 = F,P,F,P
    const check6 = evaluateFaceCheck(recent4, false);
    expect(check6).toEqual({ status: "flagged", streak: 3 });
  });

  it("U-F6: spread-over-8 → never flagged", () => {
    // Fails spread across 8 checks (positions 3 and 7) — never 3 in any
    // 5-window, so the session must never hard-flag.
    const spread = [true, true, false, true, true, true, false, true];
    const recent4 = spread.slice(-4); // [true, true, false, true] = [T,T,F,T]
    expect(evaluateFaceCheck(recent4, true).status).toBe("active");

    // A fail at the last position: window = [T,T,F,T,F] → 2 fails → paused.
    const resFail = evaluateFaceCheck(recent4, false);
    expect(resFail.status).toBe("paused");
    expect(resFail.streak).toBe(2);
  });

  it("U-F6: a pass never flags the current check", () => {
    expect(evaluateFaceCheck([false, false, false, false], true)).toEqual({
      status: "active",
      streak: 0,
    });
  });

  it("U-F6: post-unlock single-fail re-flags (standing fails not cleared)", () => {
    // After an unlock the window still holds prior fails; a single new fail
    // combined with 2 standing fails → flagged (integrity-conservative).
    const recent4 = [false, true, false, false]; // 2 standing fails + 1 pass + 1 fail
    const res = evaluateFaceCheck(recent4, false);
    // window = [true,false,false,false,false]? recent4.slice(-4) = [F,T,F,F], + current F
    // → F,T,F,F,F → 4 fails → flagged
    expect(res.status).toBe("flagged");
  });

  it("U-F7c: exactly 2 fails in a 5-window → paused, not flagged", () => {
    // [true, true, false, true] + false = T,T,F,T,F → 2 fails → paused.
    const res = evaluateFaceCheck([true, true, false, true], false);
    expect(res).toEqual({ status: "paused", streak: 2 });
  });
});
