import { describe, expect, it } from "vitest";

import {
  QUESTION_ORDER_SCOPE,
  applyBreakdownShuffle,
  applyQuestionShuffle,
  optionScope,
  shufflePlan,
  toCanonical,
  toPresented,
} from "@/lib/sessions/shuffle";

// Golden vectors: fixed seeds must produce the EXACT same permutation in
// every engine (server RSC, route handler, browser). If one of these changes,
// resume/multi-device order agreement breaks — treat as a breaking contract.
describe("shufflePlan golden vectors", () => {
  const SESSION = "00000000-0000-4000-8000-000000000001";

  it("U-QT3-1 deterministic permutation for a known session+scope", () => {
    expect(shufflePlan(SESSION, QUESTION_ORDER_SCOPE, 5)).toEqual([0, 3, 2, 4, 1]);
  });

  it("U-QT3-2 deterministic option permutation for a known question scope", () => {
    const qid = "00000000-0000-4000-8000-00000000000a";
    expect(shufflePlan(SESSION, optionScope(qid), 4)).toEqual([3, 1, 2, 0]);
  });

  it("U-QT3-3 same inputs ⇒ same plan across repeated calls (cross-process determinism)", () => {
    const a = shufflePlan(SESSION, "questions", 30);
    const b = shufflePlan(SESSION, "questions", 30);
    expect(a).toEqual(b);
  });

  it("U-QT3-4 different session ⇒ (over a sweep) different plans", () => {
    const base = shufflePlan(SESSION, "questions", 6);
    const others = Array.from({ length: 50 }, (_, i) =>
      shufflePlan(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, "questions", 6),
    );
    // NOT all identical to the base plan — the session id must matter.
    expect(others.some((p) => !p.every((v, i) => v === base[i]))).toBe(true);
  });
});

describe("shufflePlan contract", () => {
  it("U-QT3-5 is a bijection for representative sizes (options 2..5, questions 3..30)", () => {
    for (const n of [2, 3, 4, 5, 30]) {
      const plan = shufflePlan("s1", "questions", n);
      expect([...plan].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });

  it("U-QT3-6 n<2 is the identity (1-question quizzes, degenerate scopes)", () => {
    expect(shufflePlan("s1", "questions", 0)).toEqual([]);
    expect(shufflePlan("s1", "questions", 1)).toEqual([0]);
  });

  it("U-QT3-7 permutation-uniformity sweep: all n! orders occur across seeds (n=3, n=4)", () => {
    for (const n of [3, 4]) {
      const seen = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const plan = shufflePlan(`session-${i}`, "questions", n);
        seen.add(plan.join(","));
      }
      const expected = Array.from({ length: n }, (_, i) => i + 1).reduce(
        (acc, cur) => acc * cur,
        1,
      );
      expect(seen.size).toBe(expected); // n! — every order must be reachable
    }
  });

  it("U-QT3-8 scope independence: different scopes differ across a seed sweep", () => {
    // The "questions" scope and a question's option scope must not produce
    // correlated permutations for the same n.
    let differed = 0;
    for (let i = 0; i < 100; i++) {
      const a = shufflePlan(`session-${i}`, "questions", 4);
      const b = shufflePlan(`session-${i}`, optionScope(`q-${i}`), 4);
      if (a.some((v, idx) => v !== b[idx])) differed++;
    }
    expect(differed).toBeGreaterThan(80);
  });
});

describe("index translation", () => {
  const plan = [2, 0, 3, 1]; // presented 0 shows canonical 2, etc.

  it("U-QT3-9 round-trips presented→canonical→presented", () => {
    for (let i = 0; i < plan.length; i++) {
      expect(toPresented(toCanonical(i, plan), plan)).toBe(i);
    }
  });

  it("U-QT3-10 round-trips canonical→presented→canonical", () => {
    for (let i = 0; i < plan.length; i++) {
      expect(toCanonical(toPresented(i, plan), plan)).toBe(i);
    }
  });

  it("U-QT3-11 passes null through unchanged (unanswered breakdown rows)", () => {
    expect(toCanonical(null, plan)).toBeNull();
    expect(toPresented(null, plan)).toBeNull();
  });

  it("U-QT3-12 passes out-of-range indices through unchanged (defensive)", () => {
    expect(toCanonical(99, plan)).toBe(99);
    expect(toPresented(-1, plan)).toBe(-1);
  });
});

describe("applyQuestionShuffle", () => {
  const SESSION = "00000000-0000-4000-8000-000000000002";
  const questions = [
    { id: "q-a", order_index: 0, options: ["a1", "a2", "a3"], prompt: "A" },
    { id: "q-b", order_index: 1, options: ["b1", "b2"], prompt: "B" },
    { id: "q-c", order_index: 2, options: ["c1", "c2", "c3", "c4"], prompt: "C" },
  ];

  it("U-QT3-13 reorders questions and options, preserving every row's other fields", () => {
    const presented = applyQuestionShuffle(SESSION, questions);
    expect(presented.map((q) => q.id)).not.toEqual(["q-a", "q-b", "q-c"]); // actually permuted
    // Multiset invariant: per question, the presented options are exactly the
    // canonical ones (order may differ) — sorted-by-id rows sorted contents.
    const presentedSorted = [...presented]
      .sort((x, y) => x.id.localeCompare(y.id))
      .map((q) => [...q.options].sort());
    expect(presentedSorted).toEqual([
      ["a1", "a2", "a3"],
      ["b1", "b2"],
      ["c1", "c2", "c3", "c4"],
    ]);
    for (const q of presented) {
      const original = questions.find((x) => x.id === q.id)!;
      expect(q.prompt).toBe(original.prompt);
      expect(q.order_index).toBe(original.order_index);
    }
  });

  it("U-QT3-14 presented options are exactly the canonical options permuted by the derived plan", () => {
    const presented = applyQuestionShuffle(SESSION, questions);
    for (const q of presented) {
      const plan = shufflePlan(SESSION, optionScope(q.id), q.options.length);
      const original = questions.find((x) => x.id === q.id)!;
      expect(q.options).toEqual(plan.map((oi) => original.options[oi]));
    }
  });

  it("U-QT3-15 same session ⇒ same envelope across calls", () => {
    expect(applyQuestionShuffle(SESSION, questions)).toEqual(applyQuestionShuffle(SESSION, questions));
  });
});

describe("applyBreakdownShuffle", () => {
  const SESSION = "00000000-0000-4000-8000-000000000003";
  const canonicalQuestions = [
    { id: "q-a", options: ["a1", "a2", "a3"] },
    { id: "q-b", options: ["b1", "b2"] },
    { id: "q-c", options: ["c1", "c2", "c3", "c4"] },
  ];

  function canonicalRows() {
    return [
      { question_id: "q-a", order_index: 0, options: ["a1", "a2", "a3"], selected_index: 0, correct_index: 0 },
      { question_id: "q-b", order_index: 1, options: ["b1", "b2"], selected_index: null, correct_index: 1 },
      { question_id: "q-c", order_index: 2, options: ["c1", "c2", "c3", "c4"], selected_index: 3, correct_index: 2 },
    ];
  }

  it("U-QT3-16 rows follow the presented question order with renumbered positions", () => {
    const presentedQuestions = applyQuestionShuffle(SESSION, canonicalQuestions);
    const rows = applyBreakdownShuffle(
      SESSION,
      presentedQuestions.map((q) => q.id),
      canonicalRows(),
    );
    expect(rows.map((r) => r.question_id)).toEqual(presentedQuestions.map((q) => q.id));
    rows.forEach((r, i) => expect(r.order_index).toBe(i));
  });

  it("U-QT3-17 selected/correct indices translate so highlights match presented options", () => {
    const presentedQuestions = applyQuestionShuffle(SESSION, canonicalQuestions);
    const canonical = canonicalRows();
    const rows = applyBreakdownShuffle(
      SESSION,
      presentedQuestions.map((q) => q.id),
      canonical,
    );
    rows.forEach((row) => {
      const orig = canonical.find((r) => r.question_id === row.question_id)!;
      const plan = shufflePlan(SESSION, optionScope(row.question_id), row.options.length);
      expect(row.options).toEqual(plan.map((oi) => orig.options[oi]));
      if (orig.selected_index !== null) {
        expect(toCanonical(row.selected_index, plan)).toBe(orig.selected_index);
      } else {
        expect(row.selected_index).toBeNull(); // unanswered stays null
      }
      expect(toCanonical(row.correct_index, plan)).toBe(orig.correct_index);
    });
  });

  it("U-QT3-18 passes null selected_index through and appends unknown rows untranslated", () => {
    const rows = applyBreakdownShuffle(SESSION, ["q-a"], canonicalRows());
    expect(rows.map((r) => r.question_id)).toEqual(["q-a", "q-b", "q-c"]);
    const b = rows.find((r) => r.question_id === "q-b")!;
    expect(b.selected_index).toBeNull();
    expect(b.order_index).toBe(1); // unknown rows keep canonical data
  });
});
