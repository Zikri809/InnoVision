import { describe, it, expect } from "vitest";
import {
  PRACTICE_ORACLE_LIMIT,
  practiceAttemptKey,
  readPracticeAttempts,
  bumpPracticeAttempts,
  isPracticeOracleExhausted,
  clearPracticeAttempts,
  type AttemptStore,
} from "./practice-oracle";

/** In-memory stand-in for `localStorage` (Node has no DOM in the unit suite). */
function makeStore(seed: Record<string, string> = {}): AttemptStore & {
  dump(): Record<string, string>;
} {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

const QUIZ = "quiz-1";
const Q1 = "q-1";
const Q2 = "q-2";

describe("U-58 — practice oracle counter (E-58)", () => {
  it("U-58-1 a fresh pair reads 0", () => {
    expect(readPracticeAttempts(makeStore(), QUIZ, Q1)).toBe(0);
  });

  it("U-58-2 bump increments and persists, returning the NEW value", () => {
    const store = makeStore();
    expect(bumpPracticeAttempts(store, QUIZ, Q1)).toBe(1);
    expect(bumpPracticeAttempts(store, QUIZ, Q1)).toBe(2);
    expect(readPracticeAttempts(store, QUIZ, Q1)).toBe(2);
  });

  it("U-58-3 counters are per-question (a sibling question is unaffected)", () => {
    const store = makeStore();
    bumpPracticeAttempts(store, QUIZ, Q1);
    bumpPracticeAttempts(store, QUIZ, Q1);
    bumpPracticeAttempts(store, QUIZ, Q2);
    expect(readPracticeAttempts(store, QUIZ, Q1)).toBe(2);
    expect(readPracticeAttempts(store, QUIZ, Q2)).toBe(1);
  });

  it("U-58-4 counters are per-quiz (the key carries both ids)", () => {
    expect(practiceAttemptKey("a", "b")).toBe("innovision:practice-attempts:a:b");
    const store = makeStore();
    bumpPracticeAttempts(store, "quiz-A", Q1);
    expect(readPracticeAttempts(store, "quiz-B", Q1)).toBe(0);
  });

  it("U-58-5 the limit trips AT PRACTICE_ORACLE_LIMIT, not before", () => {
    expect(isPracticeOracleExhausted(0)).toBe(false);
    expect(isPracticeOracleExhausted(PRACTICE_ORACLE_LIMIT - 1)).toBe(false);
    expect(isPracticeOracleExhausted(PRACTICE_ORACLE_LIMIT)).toBe(true);
    expect(isPracticeOracleExhausted(PRACTICE_ORACLE_LIMIT + 5)).toBe(true);
  });

  it("U-58-6 a null store degrades to 0 / still increments in-page", () => {
    expect(readPracticeAttempts(null, QUIZ, Q1)).toBe(0);
    expect(bumpPracticeAttempts(null, QUIZ, Q1)).toBe(1);
  });

  it("U-58-7 a corrupt entry reads as 0 and never throws", () => {
    for (const bad of ["", "abc", "-3", "2.5", "NaN", "null"]) {
      const store = makeStore({ [practiceAttemptKey(QUIZ, Q1)]: bad });
      expect(readPracticeAttempts(store, QUIZ, Q1), `raw=${JSON.stringify(bad)}`).toBe(0);
    }
  });

  it("U-58-8 a throwing store never breaks the quiz", () => {
    const hostile: AttemptStore = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(readPracticeAttempts(hostile, QUIZ, Q1)).toBe(0);
    // The bump still reports the in-page value even though it cannot persist.
    expect(bumpPracticeAttempts(hostile, QUIZ, Q1)).toBe(1);
  });

  it("U-58-9 clearPracticeAttempts REMOVES every question of ONE quiz only", () => {
    const store = makeStore();
    bumpPracticeAttempts(store, QUIZ, Q1);
    bumpPracticeAttempts(store, QUIZ, Q2);
    bumpPracticeAttempts(store, "other-quiz", Q1);

    // `clearPracticeAttempts` needs the enumeration surface of real Storage.
    const withEnum = Object.assign(store, {
      get length() {
        return Object.keys(store.dump()).length;
      },
      key: (i: number) => Object.keys(store.dump())[i] ?? null,
    });
    clearPracticeAttempts(withEnum, QUIZ);

    expect(readPracticeAttempts(store, QUIZ, Q1)).toBe(0);
    expect(readPracticeAttempts(store, QUIZ, Q2)).toBe(0);
    // n24: the keys are GONE — no `"0"` tombstones linger in storage.
    expect(store.dump()).not.toHaveProperty(practiceAttemptKey(QUIZ, Q1));
    expect(store.dump()).not.toHaveProperty(practiceAttemptKey(QUIZ, Q2));
    // A different quiz's counter survives.
    expect(readPracticeAttempts(store, "other-quiz", Q1)).toBe(1);
  });

  it("U-58-9b a store WITHOUT removeItem falls back to the tombstone write (reads 0)", () => {
    const full = makeStore();
    bumpPracticeAttempts(full, QUIZ, Q1);
    const { removeItem: _omit, ...noRemove } = full as AttemptStore & { removeItem?: unknown };
    void _omit;
    const withEnum = Object.assign(noRemove, {
      get length() {
        return Object.keys(full.dump()).length;
      },
      key: (i: number) => Object.keys(full.dump())[i] ?? null,
    });
    clearPracticeAttempts(withEnum, QUIZ);
    expect(readPracticeAttempts(full, QUIZ, Q1)).toBe(0);
  });

  it("U-58-10 clearPracticeAttempts on a store without enumeration is a no-op", () => {
    const store = makeStore();
    bumpPracticeAttempts(store, QUIZ, Q1);
    expect(() => clearPracticeAttempts(store, QUIZ)).not.toThrow();
    expect(readPracticeAttempts(store, QUIZ, Q1)).toBe(1);
  });
});
