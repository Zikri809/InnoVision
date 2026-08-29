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

  it("flags rosterTruncated when roster hits the read cap", () => {
    const roster = Array.from({ length: 100 }, (_, i) => ({
      student_id: `s${i}`,
      full_name: `S ${i}`,
      matric_no: null,
    }));
    const model = buildGradebookModel(baseInput({ roster }));
    expect(model.rosterTruncated).toBe(true);
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

  it("orphan sessions (student not in roster) do not crash and are simply absent", () => {
    const model = buildGradebookModel(
      baseInput({
        sessionsByQuiz: new Map([
          ["qz-1", [session({ id: "s1", student_id: "ghost", score: 5 })]],
        ]),
      }),
    );
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].cells[0]).toBeNull();
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
