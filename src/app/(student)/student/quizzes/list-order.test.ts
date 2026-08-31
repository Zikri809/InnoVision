import { describe, expect, it } from "vitest";
import { filterByClass, sortByDeadline } from "./list-order";

const NOW = Date.parse("2026-09-01T10:00:00.000Z");
const HOUR = 3_600_000;

function q(overrides: {
  id: string;
  closes_at?: string | null;
  created_at?: string;
  class_id?: string;
}) {
  return {
    id: overrides.id,
    closes_at: overrides.closes_at ?? null,
    created_at: overrides.created_at ?? "2026-08-01T00:00:00.000Z",
    class_id: overrides.class_id ?? "class-1",
  };
}

describe("SQ-1 — sortByDeadline", () => {
  it("orders future deadlines closing-soonest first", () => {
    const rows = [
      q({ id: "far", closes_at: new Date(NOW + 72 * HOUR).toISOString() }),
      q({ id: "near", closes_at: new Date(NOW + 2 * HOUR).toISOString() }),
      q({ id: "mid", closes_at: new Date(NOW + 24 * HOUR).toISOString() }),
    ];
    expect(sortByDeadline(rows, NOW).map((r) => r.id)).toEqual(["near", "mid", "far"]);
  });

  it("places undated quizzes AFTER dated ones, newest-created first", () => {
    const rows = [
      q({ id: "undated-old", created_at: "2026-08-01T00:00:00.000Z" }),
      q({ id: "dated", closes_at: new Date(NOW + HOUR).toISOString() }),
      q({ id: "undated-new", created_at: "2026-08-30T00:00:00.000Z" }),
    ];
    expect(sortByDeadline(rows, NOW).map((r) => r.id)).toEqual([
      "dated",
      "undated-new",
      "undated-old",
    ]);
  });

  it("sinks past closes_at (cron-lag closed) below every future deadline", () => {
    const rows = [
      q({ id: "past", closes_at: new Date(NOW - HOUR).toISOString() }),
      q({ id: "undated" }),
      q({ id: "future", closes_at: new Date(NOW + HOUR).toISOString() }),
    ];
    // "past" carries no weight in the deadline ordering — it competes with the
    // undated row via the created_at tie-break (both keys are Infinity), and
    // its later created_at wins. Only its position AFTER "future" is pinned.
    const sorted = sortByDeadline(rows, NOW).map((r) => r.id);
    expect(sorted[0]).toBe("future");
    expect(sorted).toContain("past");
    expect(sorted).toContain("undated");
  });

  it("treats unparseable closes_at as undated and does not mutate the input", () => {
    const rows = [
      q({ id: "bad", closes_at: "not-a-date" }),
      q({ id: "future", closes_at: new Date(NOW + HOUR).toISOString() }),
    ];
    const sorted = sortByDeadline(rows, NOW);
    expect(sorted.map((r) => r.id)).toEqual(["future", "bad"]);
    expect(rows.map((r) => r.id)).toEqual(["bad", "future"]);
  });

  it("breaks deadline ties by created_at DESC (stable recency)", () => {
    const rows = [
      q({ id: "older", closes_at: new Date(NOW + HOUR).toISOString(), created_at: "2026-08-10T00:00:00.000Z" }),
      q({ id: "newer", closes_at: new Date(NOW + HOUR).toISOString(), created_at: "2026-08-20T00:00:00.000Z" }),
    ];
    expect(sortByDeadline(rows, NOW).map((r) => r.id)).toEqual(["newer", "older"]);
  });
});

describe("SQ-4 — filterByClass", () => {
  it("keeps only the requested class's quizzes", () => {
    const rows = [
      q({ id: "a", class_id: "class-1" }),
      q({ id: "b", class_id: "class-2" }),
      q({ id: "c", class_id: "class-1" }),
    ];
    expect(filterByClass(rows, "class-1").map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("is a no-op without a filter (null/empty)", () => {
    const rows = [q({ id: "a" }), q({ id: "b" })];
    expect(filterByClass(rows, null)).toHaveLength(2);
    expect(filterByClass(rows, "")).toHaveLength(2);
  });

  it("yields an empty list for an unknown class id (RLS backstops visibility)", () => {
    expect(filterByClass([q({ id: "a" })], "nope")).toEqual([]);
  });
});
