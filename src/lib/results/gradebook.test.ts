import { describe, it, expect } from "vitest";
import {
  buildGradebookModel,
  GRADEBOOK_QUIZ_LIMIT,
  type BuildGradebookInput,
  type GradebookQuiz,
} from "./gradebook";
import type { ExportSessionInput } from "./export";

function session(overrides: Partial<ExportSessionInput> & { id: string; student_id: string }): ExportSessionInput {
  return {
    status: "completed",
    score: null,
    started_at: "2026-08-01T10:00:00Z",
    submitted_at: "2026-08-01T10:30:00Z",
    last_activity_at: "2026-08-01T10:30:00Z",
    face_fail_streak: 0,
    focus_pause_count: 0,
    ...overrides,
  };
}

function quiz(overrides: Partial<GradebookQuiz> & { id: string }): GradebookQuiz {
  return {
    title: `Quiz ${overrides.id}`,
    status: "live",
    results_revealed_at: null,
    created_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function baseInput(overrides: Partial<BuildGradebookInput> = {}): BuildGradebookInput {
  return {
    className: "Section 01",
    roster: [{ student_id: "stu-1", full_name: "Ali", matric_no: "231001" }],
    quizzes: [quiz({ id: "qz-1" })],
    questionCounts: [{ quiz_id: "qz-1", count: 10 }],
    sessionsByQuiz: new Map([["qz-1", []]]),
    ...overrides,
  };
}

describe("buildGradebookModel — column policy", () => {
  it("sorts quiz columns chronologically (created_at ASC)", () => {
    const model = buildGradebookModel(
      baseInput({
        quizzes: [
          quiz({ id: "b", created_at: "2026-08-02T00:00:00Z" }),
          quiz({ id: "a", created_at: "2026-08-01T00:00:00Z" }),
        ],
      }),
    );
    expect(model.quizzes.map((q) => q.id)).toEqual(["a", "b"]);
  });

  it("caps columns at GRADEBOOK_QUIZ_LIMIT and sets truncated", () => {
    const quizzes = Array.from({ length: GRADEBOOK_QUIZ_LIMIT + 3 }, (_, i) =>
      quiz({ id: `q${i}`, created_at: new Date(Date.parse("2026-08-01T00:00:00Z") + i * 1000).toISOString() }),
    );
    const model = buildGradebookModel(baseInput({ quizzes }));
    expect(model.quizzes).toHaveLength(GRADEBOOK_QUIZ_LIMIT);
    expect(model.truncated).toBe(true);
  });

  it("flags rosterTruncated only when rows were actually dropped (B-F5)", () => {
    // Exactly ROSTER_LIMIT students is a FULL, untruncated roster — the old
    // `>=` off-by-one reported it as truncated. The flag is true only when
    // an uncapped feed actually exceeded the cap, or the caller passes the
    // roster read's own flag through.
    const full = Array.from({ length: 100 }, (_, i) => ({
      student_id: `s${i}`,
      full_name: `S ${i}`,
      matric_no: null,
    }));
    expect(buildGradebookModel(baseInput({ roster: full })).rosterTruncated).toBe(false);

    const over = Array.from({ length: 101 }, (_, i) => ({
      student_id: `s${i}`,
      full_name: `S ${i}`,
      matric_no: null,
    }));
    expect(buildGradebookModel(baseInput({ roster: over })).rosterTruncated).toBe(true);

    // The real callers feed an ALREADY-capped roster, so they pass the read's
    // flag explicitly (getClassRoster's truncated result).
    expect(
      buildGradebookModel(baseInput({ roster: full, rosterTruncated: true })).rosterTruncated,
    ).toBe(true);
  });
});

describe("buildGradebookModel — cells and representative sessions", () => {
  it("renders em-dash (null cell) for a never-attempted student", () => {
    const model = buildGradebookModel(baseInput());
    expect(model.rows[0].cells[0]).toBeNull();
    expect(model.rows[0].cumulativePercent).toBeNull();
  });

  it("picks the LATEST terminal attempt under the DESC feed order (retakes)", () => {
    const model = buildGradebookModel(
      baseInput({
        // Feed order started_at DESC, id DESC — attempt 2 first.
        sessionsByQuiz: new Map([
          [
            "qz-1",
            [
              session({ id: "s2", student_id: "stu-1", score: 9, attempt: 2, started_at: "2026-08-02T10:00:00Z" }),
              session({ id: "s1", student_id: "stu-1", score: 4, attempt: 1 }),
            ],
          ],
        ]),
      }),
    );
    expect(model.rows[0].cells[0]).toMatchObject({ score: 9, attempt: 2 });
    expect(model.rows[0].cumulativePercent).toBe(90);
  });

  it("prefers a terminal attempt over a newer non-terminal one regardless of feed position", () => {
    const model = buildGradebookModel(
      baseInput({
        sessionsByQuiz: new Map([
          [
            "qz-1",
            [
              session({ id: "s1", student_id: "stu-1", score: 6, attempt: 1 }),
              session({ id: "s2", student_id: "stu-1", status: "active", score: null, attempt: 2, started_at: "2026-08-02T10:00:00Z" }),
            ],
          ],
        ]),
      }),
    );
    expect(model.rows[0].cells[0]).toMatchObject({ score: 6, attempt: 1 });
  });

  it("flagged sessions are score-bearing (documented divergence from student card)", () => {
    const model = buildGradebookModel(
      baseInput({
        sessionsByQuiz: new Map([
          ["qz-1", [session({ id: "s1", student_id: "stu-1", status: "flagged", score: 7 })]],
        ]),
      }),
    );
    expect(model.rows[0].cells[0]).toMatchObject({ score: 7 });
  });

  it("null cell when the quiz has zero questions even with a scored session", () => {
    const model = buildGradebookModel(
      baseInput({
        questionCounts: [{ quiz_id: "qz-1", count: 0 }],
        sessionsByQuiz: new Map([
          ["qz-1", [session({ id: "s1", student_id: "stu-1", score: 5 })]],
        ]),
      }),
    );
    expect(model.rows[0].cells[0]).toBeNull();
  });

  it("cell with an unscored terminal session (score null) renders em-dash", () => {
    const model = buildGradebookModel(
      baseInput({
        sessionsByQuiz: new Map([
          ["qz-1", [session({ id: "s1", student_id: "stu-1", score: null })]],
        ]),
      }),
    );
    expect(model.rows[0].cells[0]).toBeNull();
  });

  it("appends orphan sessions as null-name rows and keeps the average consistent (B-F1)", () => {
    const model = buildGradebookModel(
      baseInput({
        sessionsByQuiz: new Map([
          ["qz-1", [session({ id: "s1", student_id: "ghost", score: 5 })]],
        ]),
      }),
    );
    // Roster row (no attempt) + appended orphan row.
    expect(model.rows).toHaveLength(2);
    expect(model.rows[0].cells[0]).toBeNull();
    expect(model.rows[1]).toMatchObject({ studentId: "ghost", fullName: null, matricNo: null });
    expect(model.rows[1].cells[0]).toMatchObject({ score: 5, percent: 50 });
    // The average already included the orphan — the displayed rows now do too.
    expect(model.quizzes[0].averagePercent).toBe(50);
  });

  it("orphan rows carry integrity counters (B-F1)", () => {
    const model = buildGradebookModel(
      baseInput({
        sessionsByQuiz: new Map([
          [
            "qz-1",
            [
              session({
                id: "s1",
                student_id: "ghost",
                score: 5,
                face_fail_count: 2,
                fullscreen_pause_count: 1,
                hand_pause_count: 3,
              }),
            ],
          ],
        ]),
      }),
    );
    expect(model.rows[1]).toMatchObject({
      studentId: "ghost",
      faceFails: 2,
      fullscreenPauses: 1,
      handPauses: 3,
    });
  });

  it("orphan rows are deterministic (sorted by student id) and deduped across quizzes", () => {
    const model = buildGradebookModel(
      baseInput({
        quizzes: [quiz({ id: "qz-1" }), quiz({ id: "qz-2", created_at: "2026-08-02T00:00:00Z" })],
        questionCounts: [
          { quiz_id: "qz-1", count: 10 },
          { quiz_id: "qz-2", count: 10 },
        ],
        sessionsByQuiz: new Map([
          ["qz-1", [session({ id: "s2", student_id: "ghost-b", score: 5 })]],
          ["qz-2", [session({ id: "s3", student_id: "ghost-a", score: 5 })]],
        ]),
      }),
    );
    expect(model.rows.map((r) => r.studentId)).toEqual(["stu-1", "ghost-a", "ghost-b"]);
  });
});

describe("buildGradebookModel — aggregates", () => {
  it("per-quiz average is over attempted cells only; null when nobody attempted", () => {
    const model = buildGradebookModel(
      baseInput({
        roster: [
          { student_id: "stu-1", full_name: "Ali", matric_no: "231001" },
          { student_id: "stu-2", full_name: "Beth", matric_no: "231002" },
        ],
        sessionsByQuiz: new Map([
          ["qz-1", [session({ id: "s1", student_id: "stu-1", score: 8 })]],
        ]),
      }),
    );
    expect(model.quizzes[0].averagePercent).toBe(80);
  });

  it("average null with zero attempted cells", () => {
    const model = buildGradebookModel(baseInput());
    expect(model.quizzes[0].averagePercent).toBeNull();
  });

  it("cumulative % divides by attempted quiz totals only", () => {
    const model = buildGradebookModel(
      baseInput({
        quizzes: [quiz({ id: "qz-1" }), quiz({ id: "qz-2", created_at: "2026-08-02T00:00:00Z" })],
        questionCounts: [
          { quiz_id: "qz-1", count: 10 },
          { quiz_id: "qz-2", count: 5 },
        ],
        sessionsByQuiz: new Map([
          ["qz-1", [session({ id: "s1", student_id: "stu-1", score: 10 })]],
          ["qz-2", []],
        ]),
      }),
    );
    // Only qz-1 attempted: 10/10 = 100%, NOT 10/15.
    expect(model.rows[0].cumulativePercent).toBe(100);
  });

  it("revealed flag follows results_revealed_at", () => {
    const model = buildGradebookModel(
      baseInput({
        quizzes: [
          quiz({ id: "qz-1", results_revealed_at: "2026-08-03T00:00:00Z" }),
          quiz({ id: "qz-2", results_revealed_at: null, created_at: "2026-08-02T00:00:00Z" }),
        ],
      }),
    );
    expect(model.quizzes.map((q) => q.revealed)).toEqual([true, false]);
  });
});

describe("buildGradebookModel — integrity sums (audit-1 P1-16)", () => {
  it("sums face-fail / fullscreen / hand counters over representative sessions", () => {
    const model = buildGradebookModel(
      baseInput({
        quizzes: [quiz({ id: "qz-1" }), quiz({ id: "qz-2", created_at: "2026-08-02T00:00:00Z" })],
        questionCounts: [
          { quiz_id: "qz-1", count: 10 },
          { quiz_id: "qz-2", count: 10 },
        ],
        sessionsByQuiz: new Map([
          [
            "qz-1",
            [
              session({
                id: "s-1",
                student_id: "stu-1",
                score: 8,
                face_fail_streak: 1,
                face_fail_count: 4,
                fullscreen_pause_count: 2,
                hand_pause_count: 0,
              }),
            ],
          ],
          [
            "qz-2",
            [
              session({
                id: "s-2",
                student_id: "stu-1",
                score: 9,
                face_fail_streak: 0,
                face_fail_count: 5,
                fullscreen_pause_count: 3,
                hand_pause_count: 1,
              }),
            ],
          ],
        ]),
      }),
    );
    // faceFails mirrors the per-quiz export: lifetime face_fail_count sum.
    expect(model.rows[0].faceFails).toBe(9);
    expect(model.rows[0].fullscreenPauses).toBe(5);
    expect(model.rows[0].handPauses).toBe(1);
  });

  it("counts a counter-bearing UNSCORED session even though its cell is an em dash", () => {
    // A sealed/scoreless terminal session em-dashes its cell (score null),
    // but its integrity counters are exactly what the lecturer must see.
    const model = buildGradebookModel(
      baseInput({
        sessionsByQuiz: new Map([
          [
            "qz-1",
            [
              session({
                id: "s-0",
                student_id: "stu-1",
                score: null,
                face_fail_count: 2,
                fullscreen_pause_count: 7,
                hand_pause_count: 3,
              }),
            ],
          ],
        ]),
      }),
    );
    expect(model.rows[0].cells[0]).toBeNull(); // score null → em dash cell
    expect(model.rows[0].faceFails).toBe(2);
    expect(model.rows[0].fullscreenPauses).toBe(7);
    expect(model.rows[0].handPauses).toBe(3);
  });
});

/**
 * X2-6/U-63 (PLAN_GESTURE_OFF_RICH_TYPES §4): the RESOLVED denominator.
 *
 * `quiz_sessions.score` became NUMERIC in 0053 (PostgREST serialises it as a
 * STRING) and the D10 score SUM EXCLUDES answers still awaiting an AI mark.
 * A cell that divided the coerced score by the FULL question count would read
 * a partially-marked attempt as a low score — these pin the three arms that
 * prevent it: coercion, the resolved denominator, and the pending state.
 */
describe("buildGradebookModel — NUMERIC score + resolved denominator", () => {
  it("coerces a STRING score (PostgREST NUMERIC serialisation)", () => {
    const model = buildGradebookModel(
      baseInput({
        sessionsByQuiz: new Map([
          ["qz-1", [session({ id: "s1", student_id: "stu-1", score: "0.5" as unknown as number })]],
        ]),
      }),
    );
    expect(model.rows[0].cells[0]?.score).toBe(0.5);
    expect(model.rows[0].cells[0]?.percent).toBe(5); // 0.5 / 10
  });

  it("divides by the RESOLVED count, not the full question count", () => {
    const model = buildGradebookModel(
      baseInput({
        sessionsByQuiz: new Map([
          [
            "qz-1",
            [session({ id: "s1", student_id: "stu-1", score: 5, pending_count: 5 })],
          ],
        ]),
      }),
    );
    const cell = model.rows[0].cells[0];
    expect(cell?.pendingCount).toBe(5);
    expect(cell?.resolved).toBe(5);
    // 5 / (10 - 5) = 100% — NOT 5/10 = 50%. The resolved arithmetic is the
    // model contract (plan §4); the SURFACES gate on pendingCount and render
    // the neutral chip instead (audit-4 M10).
    expect(cell?.percent).toBe(100);
  });

  it("resolved = 0 (every answer pending) → percent null, never a divide-by-zero", () => {
    const model = buildGradebookModel(
      baseInput({
        sessionsByQuiz: new Map([
          [
            "qz-1",
            [session({ id: "s1", student_id: "stu-1", score: 0, pending_count: 10 })],
          ],
        ]),
      }),
    );
    const cell = model.rows[0].cells[0];
    expect(cell?.resolved).toBe(0);
    expect(cell?.percent).toBeNull();
    expect(cell?.pendingCount).toBe(10);
  });

  it("a stale pending_count above the question count never goes negative", () => {
    const model = buildGradebookModel(
      baseInput({
        sessionsByQuiz: new Map([
          ["qz-1", [session({ id: "s1", student_id: "stu-1", score: 5, pending_count: 99 })]],
        ]),
      }),
    );
    expect(model.rows[0].cells[0]?.resolved).toBe(0);
  });

  it("excludes a pending cell from the class average", () => {
    const model = buildGradebookModel(
      baseInput({
        roster: [
          { student_id: "stu-1", full_name: "Ali", matric_no: null },
          { student_id: "stu-2", full_name: "Bee", matric_no: null },
        ],
        sessionsByQuiz: new Map([
          [
            "qz-1",
            [
              session({ id: "s1", student_id: "stu-1", score: 5, pending_count: 5 }),
              session({ id: "s2", student_id: "stu-2", score: 5, pending_count: 0 }),
            ],
          ],
        ]),
      }),
    );
    // audit-4 M11: stu-1's percent is provisional (partial denominator), so it
    // is excluded ENTIRELY — the footer must not leak what the cell hides.
    // Only stu-2 (50%) counts.
    expect(model.quizzes[0].averagePercent).toBe(50);
  });

  it("cumulative sums RESOLVED denominators and skips pending cells", () => {
    const model = buildGradebookModel(
      baseInput({
        quizzes: [
          quiz({ id: "qz-1", created_at: "2026-08-01T00:00:00Z" }),
          quiz({ id: "qz-2", created_at: "2026-08-02T00:00:00Z" }),
        ],
        questionCounts: [
          { quiz_id: "qz-1", count: 10 },
          { quiz_id: "qz-2", count: 4 },
        ],
        sessionsByQuiz: new Map([
          // qz-1 fully resolved: 5/10. qz-2 pending → excluded entirely.
          ["qz-1", [session({ id: "s1", student_id: "stu-1", score: 5, pending_count: 0 })]],
          ["qz-2", [session({ id: "s2", student_id: "stu-1", score: 2, pending_count: 2 })]],
        ]),
      }),
    );
    // 5 / 10 = 50% — the pending quiz contributes nothing.
    expect(model.rows[0].cumulativePercent).toBe(50);
  });

  it("no score at all still reads as not-attempted (null cell)", () => {
    const model = buildGradebookModel(
      baseInput({
        sessionsByQuiz: new Map([
          ["qz-1", [session({ id: "s1", student_id: "stu-1", score: null, pending_count: 3 })]],
        ]),
      }),
    );
    expect(model.rows[0].cells[0]).toBeNull();
  });
});
