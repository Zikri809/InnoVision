import { describe, it, expect } from "vitest";
import { applyOptionDraftOp, type OptionDraftState } from "./question-draft";

function state(options: string[], correctIndex: number): OptionDraftState {
  return { options, correctIndex };
}

describe("applyOptionDraftOp — set", () => {
  it("updates one option in place, keeping correctIndex", () => {
    const s = state(["A", "B", "C"], 2);
    const next = applyOptionDraftOp(s, { kind: "set", index: 0, value: "Z" });
    expect(next.options).toEqual(["Z", "B", "C"]);
    expect(next.correctIndex).toBe(2);
  });

  it("ignores out-of-range indices", () => {
    const s = state(["A", "B"], 0);
    expect(applyOptionDraftOp(s, { kind: "set", index: 5, value: "Z" })).toBe(s);
    expect(applyOptionDraftOp(s, { kind: "set", index: -1, value: "Z" })).toBe(s);
  });
});

describe("applyOptionDraftOp — add", () => {
  it("appends a blank option up to the max of 5", () => {
    let s = state(["A", "B"], 0);
    s = applyOptionDraftOp(s, { kind: "add" });
    expect(s.options).toEqual(["A", "B", ""]);
    s = applyOptionDraftOp(s, { kind: "add" });
    s = applyOptionDraftOp(s, { kind: "add" });
    expect(s.options).toHaveLength(5);
    // Cap: the 6th add is a no-op.
    s = applyOptionDraftOp(s, { kind: "add" });
    expect(s.options).toHaveLength(5);
  });
});

describe("applyOptionDraftOp — remove", () => {
  it("never drops below 2 options", () => {
    const s = state(["A", "B"], 0);
    expect(applyOptionDraftOp(s, { kind: "remove", index: 0 })).toBe(s);
  });

  it("shifts correctIndex left when a preceding option is removed", () => {
    const next = applyOptionDraftOp(state(["A", "B", "C"], 2), { kind: "remove", index: 0 });
    expect(next.options).toEqual(["B", "C"]);
    expect(next.correctIndex).toBe(1); // marked answer followed its option
  });

  it("resets to 0 when the CORRECT option itself is removed", () => {
    const next = applyOptionDraftOp(state(["A", "B", "C"], 1), { kind: "remove", index: 1 });
    expect(next.correctIndex).toBe(0);
  });

  it("is a no-op when removing would drop below the 2-option floor", () => {
    const s = state(["A", "B"], 1);
    expect(applyOptionDraftOp(s, { kind: "remove", index: 1 })).toBe(s);
  });
});

describe("applyOptionDraftOp — move", () => {
  it("moves an option and its correctness mark together", () => {
    const next = applyOptionDraftOp(state(["A", "B", "C"], 0), { kind: "move", from: 0, to: 2 });
    expect(next.options).toEqual(["B", "C", "A"]);
    expect(next.correctIndex).toBe(2); // 'A' still marked
  });

  it("adjusts correctIndex when a NON-correct option jumps over it", () => {
    // correct is at 0 ('A'); moving B (1→0) shifts A right.
    const next = applyOptionDraftOp(state(["A", "B"], 0), { kind: "move", from: 1, to: 0 });
    expect(next.options).toEqual(["B", "A"]);
    expect(next.correctIndex).toBe(1);
    // And back:
    const back = applyOptionDraftOp(next, { kind: "move", from: 0, to: 1 });
    expect(back.options).toEqual(["A", "B"]);
    expect(back.correctIndex).toBe(0);
  });

  it("ignores no-op or out-of-range moves", () => {
    const s = state(["A", "B"], 1);
    expect(applyOptionDraftOp(s, { kind: "move", from: 0, to: 0 })).toBe(s);
    expect(applyOptionDraftOp(s, { kind: "move", from: -1, to: 0 })).toBe(s);
    expect(applyOptionDraftOp(s, { kind: "move", from: 0, to: 9 })).toBe(s);
  });
});


describe("QT-1 — set-aware correctIndices ops", () => {
  it("remove filters the removed index and shifts higher members down", () => {
    const s: OptionDraftState = { options: ["A", "B", "C", "D"], correctIndices: [0, 2] };
    const next = applyOptionDraftOp(s, { kind: "remove", index: 1 });
    expect(next.options).toEqual(["A", "C", "D"]);
    expect(next.correctIndices).toEqual([0, 1]);
  });

  it("remove of a marked member just drops it (stays sorted+distinct)", () => {
    const s: OptionDraftState = { options: ["A", "B", "C"], correctIndices: [0, 2] };
    const next = applyOptionDraftOp(s, { kind: "remove", index: 2 });
    expect(next.correctIndices).toEqual([0]);
  });

  it("move re-maps every set member through the permutation", () => {
    const s: OptionDraftState = { options: ["A", "B", "C", "D"], correctIndices: [0, 2] };
    const next = applyOptionDraftOp(s, { kind: "move", from: 0, to: 3 });
    expect(next.options).toEqual(["B", "C", "D", "A"]);
    // A (was 0) lands at 3; C (was 2) shifts down to 1.
    expect(next.correctIndices).toEqual([1, 3]);
  });

  it("single-answer ops are untouched (no correctIndices key)", () => {
    const s = state(["A", "B", "C"], 1);
    const next = applyOptionDraftOp(s, { kind: "remove", index: 0 });
    expect(next.correctIndex).toBe(0);
    expect("correctIndices" in next).toBe(false);
  });
});
