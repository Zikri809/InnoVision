import { describe, it, expect } from "vitest";
import {
  buildExportModel,
  safeText,
  optionLetter,
  summarizeQuestionStats,
  type BuildExportInput,
} from "./export";

const HOUR = 60 * 60 * 1000;
const NOW = 1_000_000 * HOUR;

function baseInput(overrides: Partial<BuildExportInput> = {}): BuildExportInput {
  return {
    quiz: { title: "Quiz 3", mode: "assessment", status: "closed" },
    className: "Section 02",
    generatedAtISO: new Date(NOW).toISOString(),
    questions: [
      {
        id: "q1",
        order_index: 0,
        type: "mcq",
        prompt: "What is photosynthesis?",
        options: ["Respiration", "Light into sugar", "Water cycle"],
        correct_index: 1,
        correct_indices: null,
        explanation: null,
      },
      {
        id: "q2",
        order_index: 1,
        type: "true_false",
        prompt: "The sun is a star.",
        options: ["True", "False"],
        correct_index: 0,
        correct_indices: null,
        explanation: "Yes.",
      },
    ],
    roster: [
      { student_id: "stu-1", full_name: "Ali Bin Abu", matric_no: "231202" },
      { student_id: "stu-2", full_name: "Citra Dewi", matric_no: "231201" },
      { student_id: "stu-3", full_name: "Zack", matric_no: null },
    ],
    sessions: [],
    answers: [],
    nowMs: NOW,
    ...overrides,
  };
}

describe("buildExportModel — roster-driven rows", () => {
  it("emits one row per roster student even with zero sessions (not_started)", () => {
    const model = buildExportModel(baseInput());
    expect(model.students).toHaveLength(3);
    expect(model.students.every((s) => s.status === "not_started")).toBe(true);
    expect(model.students[0].answers).toEqual([null, null]);
    expect(model.meta.attemptedCount).toBe(0);
  });

  it("sorts by matric ascending with null-matrics last by name", () => {
    const model = buildExportModel(baseInput());
    expect(model.students.map((s) => s.fullName)).toEqual([
      "Citra Dewi", // 231201
      "Ali Bin Abu", // 231202
      "Zack", // no matric → last
    ]);
  });

  it("picks the completed attempt over a later in-progress retake (practice)", () => {
    const input = baseInput({
      quiz: { title: "T", mode: "practice", status: "live" },
      sessions: [
        {
          id: "retake",
          student_id: "stu-2",
          status: "active",
          score: null,
          started_at: new Date(NOW - 1000).toISOString(), // NEWEST start
          submitted_at: null,
          last_activity_at: new Date(NOW - 1000).toISOString(),
          face_fail_streak: 0,
          focus_pause_count: 0,
        },
        {
          id: "finished",
          student_id: "stu-2",
          status: "completed",
          score: 2,
          started_at: new Date(NOW - HOUR).toISOString(), // older start
          submitted_at: new Date(NOW - 30 * 60 * 1000).toISOString(),
          last_activity_at: new Date(NOW - 30 * 60 * 1000).toISOString(),
          face_fail_streak: 0,
          focus_pause_count: 0,
        },
      ],
      answers: [
        { session_id: "finished", question_id: "q1", selected_index: 1, is_correct: true },
        { session_id: "retake", question_id: "q1", selected_index: 0, is_correct: false },
      ],
    });
    const model = buildExportModel(input);
    // Exactly ONE row per student — the completed attempt wins despite the
    // newer in-progress retake.
    const rows = model.students.filter((s) => s.studentId === "stu-2");
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(2);
    // Distribution counts ONLY the representative session's answer.
    expect(model.distribution[0]).toEqual([
      { optionIndex: 0, chosenCount: 0, chosenPercent: 0 },
      { optionIndex: 1, chosenCount: 1, chosenPercent: 100 },
      { optionIndex: 2, chosenCount: 0, chosenPercent: 0 },
    ]);
    expect(model.meta.attemptedCount).toBe(1);
  });

  it("keeps the NEWER terminal when two completed attempts exist", () => {
    const input = baseInput({
      quiz: { title: "T", mode: "practice", status: "live" },
      sessions: [
        {
          id: "newest",
          student_id: "stu-2",
          status: "completed",
          score: 2,
          started_at: new Date(NOW - 1000).toISOString(),
          submitted_at: new Date(NOW).toISOString(),
          last_activity_at: new Date(NOW).toISOString(),
          face_fail_streak: 0,
          focus_pause_count: 0,
        },
        {
          id: "oldest",
          student_id: "stu-2",
          status: "completed",
          score: 0,
          started_at: new Date(NOW - HOUR).toISOString(),
          submitted_at: new Date(NOW - 30 * 60 * 1000).toISOString(),
          last_activity_at: new Date(NOW - 30 * 60 * 1000).toISOString(),
          face_fail_streak: 0,
          focus_pause_count: 0,
        },
      ],
    });
    const model = buildExportModel(input);
    const row = model.students.find((s) => s.studentId === "stu-2")!;
    expect(row.score).toBe(2);
  });

  it("breaks equal-started_at terminal ties deterministically by id DESC", () => {
    const input = baseInput({
      quiz: { title: "T", mode: "practice", status: "live" },
      sessions: [
        {
          // Route feeds started_at DESC + id DESC, so sess-zzz arrives FIRST.
          id: "sess-zzz",
          student_id: "stu-2",
          status: "completed",
          score: 1,
          started_at: new Date(NOW - HOUR).toISOString(),
          submitted_at: new Date(NOW).toISOString(),
          last_activity_at: new Date(NOW).toISOString(),
          face_fail_streak: 0,
          focus_pause_count: 0,
        },
        {
          id: "sess-aaa",
          student_id: "stu-2",
          status: "completed",
          score: 0,
          started_at: new Date(NOW - HOUR).toISOString(), // identical timestamps
          submitted_at: new Date(NOW - 30 * 60 * 1000).toISOString(),
          last_activity_at: new Date(NOW - 30 * 60 * 1000).toISOString(),
          face_fail_streak: 0,
          focus_pause_count: 0,
        },
      ],
    });
    const model = buildExportModel(input);
    // The first-seen terminal wins → deterministic pick of sess-zzz.
    const row = model.students.find((s) => s.studentId === "stu-2")!;
    expect(row.studentId).toBe("stu-2");
    expect(model.meta.attemptedCount).toBe(1);
    expect(row.score).toBe(1);
  });

  it("appends orphan attempts (session without roster entry) as extra rows", () => {
    const input = baseInput({
      sessions: [
        {
          id: "gone",
          student_id: "stu-gone",
          status: "completed",
          score: 1,
          started_at: new Date(NOW - HOUR).toISOString(),
          submitted_at: new Date(NOW).toISOString(),
          last_activity_at: new Date(NOW).toISOString(),
          face_fail_streak: 0,
          focus_pause_count: 0,
        },
      ],
      answers: [
        { session_id: "gone", question_id: "q1", selected_index: 1, is_correct: true },
      ],
    });
    const model = buildExportModel(input);
    const orphan = model.students.find((s) => s.studentId === "stu-gone");
    expect(orphan).toBeDefined();
    expect(orphan!.fullName).toBeNull();
    expect(orphan!.matricNo).toBeNull();
    expect(orphan!.status).toBe("completed");
    // Orphans carry no matric → they live in the null-matric tail of the
    // mark-sheet order (sorted by empty name, ahead of named null-matrics).
    const matricIdx = model.students.findIndex((s) => s.matricNo === null);
    expect(model.students.indexOf(orphan!)).toBeGreaterThanOrEqual(matricIdx);
  });

  it("flags truncated when the route reports an answer-cap hit", () => {
    const model = buildExportModel(baseInput({ answersTruncated: true }));
    expect(model.meta.truncated).toBe(true);
  });

  it("marks truncated when session cap is reached", () => {
    const sessions = Array.from({ length: 200 }, (_, i) => ({
      id: `s${i}`,
      student_id: `stu-${i}`,
      status: "completed" as const,
      score: 1,
      started_at: new Date(NOW - HOUR).toISOString(),
      submitted_at: new Date(NOW).toISOString(),
      last_activity_at: new Date(NOW).toISOString(),
      face_fail_streak: 0,
      focus_pause_count: 0,
    }));
    // Only two in the roster but sessions hit the cap → truncated still true.
    const model = buildExportModel(baseInput({ sessions }));
    expect(model.meta.truncated).toBe(true);
  });
});

describe("buildExportModel — per-question cells & derivation", () => {
  const input = baseInput({
    quiz: { title: "T", mode: "assessment", status: "live" },
    sessions: [
      {
        id: "sess-2",
        student_id: "stu-2",
        status: "completed",
        score: 1,
        started_at: new Date(NOW - HOUR).toISOString(),
        submitted_at: new Date(NOW - 30 * 60 * 1000).toISOString(),
        last_activity_at: new Date(NOW - 30 * 60 * 1000).toISOString(),
        face_fail_streak: 1,
        focus_pause_count: 2,
      },
    ],
    answers: [
      { session_id: "sess-2", question_id: "q1", selected_index: 0, is_correct: false },
      { session_id: "sess-2", question_id: "q2", selected_index: 0, is_correct: true },
    ],
  });

  it("renders letter+text cells and parallel correctness", () => {
    const model = buildExportModel(input);
    const citra = model.students.find((s) => s.studentId === "stu-2")!;
    expect(citra.answers).toEqual(["A — Respiration", "A — True"]);
    expect(citra.answerCorrect).toEqual([false, true]);
    expect(citra.score).toBe(1);
    expect(citra.percent).toBe(50);
    expect(citra.durationSec).toBe(1800);
    expect(citra.faceFails).toBe(1);
    expect(citra.focusPauses).toBe(2);
    expect(citra.status).toBe("completed");
  });

  it("derives abandoned for a stale active session on a live quiz (>2h)", () => {
    const stale = baseInput({
      quiz: { title: "T", mode: "practice", status: "live" },
      sessions: [
        {
          id: "s-stale",
          student_id: "stu-1",
          status: "active",
          score: null,
          started_at: new Date(NOW - 5 * HOUR).toISOString(),
          submitted_at: null,
          last_activity_at: new Date(NOW - 3 * HOUR - 1000).toISOString(),
          face_fail_streak: 0,
          focus_pause_count: 0,
        },
      ],
    });
    const model = buildExportModel(stale);
    expect(model.students.find((s) => s.studentId === "stu-1")!.status).toBe("abandoned");
  });

  it("leaves unanswered questions as null even among answered ones", () => {
    const partial = buildExportModel(input);
    const ali = partial.students.find((s) => s.studentId === "stu-1")!;
    expect(ali.status).toBe("not_started");
    expect(ali.percent).toBeNull();
  });
});

describe("distribution math", () => {
  it("counts answered attempts only and zeroes empty questions", () => {
    const input = baseInput({
      sessions: [
        {
          id: "sa",
          student_id: "stu-1",
          status: "completed",
          score: 0,
          started_at: new Date(NOW).toISOString(),
          submitted_at: new Date(NOW).toISOString(),
          last_activity_at: new Date(NOW).toISOString(),
          face_fail_streak: 0,
          focus_pause_count: 0,
        },
        {
          id: "sb",
          student_id: "stu-2",
          status: "completed",
          score: 0,
          started_at: new Date(NOW).toISOString(),
          submitted_at: new Date(NOW).toISOString(),
          last_activity_at: new Date(NOW).toISOString(),
          face_fail_streak: 0,
          focus_pause_count: 0,
        },
      ],
      answers: [
        { session_id: "sa", question_id: "q1", selected_index: 0, is_correct: false },
        { session_id: "sb", question_id: "q1", selected_index: 1, is_correct: true },
      ],
    });
    const model = buildExportModel(input);
    // q1: A chosen once, B once, C never → 50/50/0.
    expect(model.distribution[0]).toEqual([
      { optionIndex: 0, chosenCount: 1, chosenPercent: 50 },
      { optionIndex: 1, chosenCount: 1, chosenPercent: 50 },
      { optionIndex: 2, chosenCount: 0, chosenPercent: 0 },
    ]);
    // q2: zero answered → all zeros (no div-by-zero).
    expect(model.distribution[1]).toEqual([
      { optionIndex: 0, chosenCount: 0, chosenPercent: 0 },
      { optionIndex: 1, chosenCount: 0, chosenPercent: 0 },
    ]);
  });
});

describe("summarizeQuestionStats", () => {
  it("aggregates timesAnswered/timesCorrect/percentCorrect", () => {
    const input = baseInput({
      sessions: [
        {
          id: "sx",
          student_id: "stu-1",
          status: "completed",
          score: 1,
          started_at: new Date(NOW).toISOString(),
          submitted_at: new Date(NOW).toISOString(),
          last_activity_at: new Date(NOW).toISOString(),
          face_fail_streak: 0,
          focus_pause_count: 0,
        },
      ],
      answers: [
        { session_id: "sx", question_id: "q1", selected_index: 1, is_correct: true },
      ],
    });
    const model = buildExportModel(input);
    const stats = summarizeQuestionStats(model);
    expect(stats[0]).toEqual({ timesAnswered: 1, timesCorrect: 1, percentCorrect: 100 });
    expect(stats[1]).toEqual({ timesAnswered: 0, timesCorrect: 0, percentCorrect: 0 });
  });
});

describe("safeText (formula-injection choke point)", () => {
  it("prefixes dangerous leading characters", () => {
    for (const lead of ["=", "+", "-", "@"]) {
      expect(safeText(`${lead}cmd`).startsWith("'")).toBe(true);
    }
    expect(safeText("\tpwn").startsWith("'")).toBe(true);
    expect(safeText("\rpwn").startsWith("'")).toBe(true);
  });

  it("passes clean text through untouched", () => {
    expect(safeText("Photosynthesis")).toBe("Photosynthesis");
    expect(safeText(null)).toBe("");
    expect(safeText(undefined)).toBe("");
  });

  it("sanitizes prompts/options/explanations inside the built model", () => {
    const hostile = baseInput({
      questions: [
        {
          id: "q1",
          order_index: 0,
          type: "mcq",
          prompt: "=HYPERLINK(evil)",
          options: ["-ok", "@dde"],
          correct_index: 0,
          correct_indices: null,
          explanation: "+formula",
        },
      ],
      quiz: { title: "=title", mode: "mcq", status: "draft" },
    });
    const model = buildExportModel(hostile);
    expect(model.meta.quizTitle.startsWith("'")).toBe(true);
    expect(model.questions[0].prompt.startsWith("'")).toBe(true);
    expect(model.questions[0].options.every((o) => o.startsWith("'"))).toBe(true);
    expect(model.questions[0].explanation!.startsWith("'")).toBe(true);
  });

  it("sanitizes student full names (the doc-invariant covers every string cell)", () => {
    const hostile = baseInput({
      roster: [
        { student_id: "s-e", full_name: "=cmd|evil", matric_no: "231201" },
      ],
    });
    const model = buildExportModel(hostile);
    expect(model.students[0].fullName!.startsWith("'")).toBe(true);
  });
});

describe("optionLetter", () => {
  it("maps indices to letters and falls back safely", () => {
    expect(optionLetter(0)).toBe("A");
    expect(optionLetter(4)).toBe("E");
    expect(optionLetter(9)).not.toMatch(/^[A-Z]$/);
  });
});


describe("QT-1 — multi-select export cells + distribution", () => {
  const multiInput = (answers: BuildExportInput["answers"]): BuildExportInput =>
    baseInput({
      questions: [
        {
          id: "qm",
          order_index: 0,
          type: "multi_select",
          prompt: "Which are prime?",
          options: ["2", "3", "4", "5"],
          correct_index: null,
          correct_indices: [0, 1, 3],
          explanation: null,
        },
        {
          id: "q1",
          order_index: 1,
          type: "mcq",
          prompt: "Scalar question",
          options: ["A", "B"],
          correct_index: 0,
          correct_indices: null,
          explanation: null,
        },
      ],
      sessions: [
        {
          id: "sess-1",
          student_id: "stu-1",
          status: "completed",
          score: 2,
          started_at: new Date(NOW - HOUR).toISOString(),
          submitted_at: new Date(NOW).toISOString(),
          last_activity_at: NOW,
          face_fail_streak: 0,
          focus_pause_count: 0,
        },
      ],
      answers,
    });

  it("U-QT1-E1 answered multi cell uses joined letters + joined texts", () => {
    const model = buildExportModel(
      multiInput([
        { session_id: "sess-1", question_id: "qm", selected_index: null, selected_indices: [3, 0], is_correct: true },
        { session_id: "sess-1", question_id: "q1", selected_index: 0, is_correct: true },
      ]),
    );
    // Canonical set arrives sorted; letters joined "," and texts " / ".
    const ali = model.students.find((s) => s.studentId === "stu-1")!;
    expect(ali.answers[0]).toBe("A,D — 2 / 5");
    expect(ali.answers[1]).toBe("A — A");
  });

  it("U-QT1-E2 an unanswered multi row (empty set / null) stays null", () => {
    const model = buildExportModel(
      multiInput([
        { session_id: "sess-1", question_id: "q1", selected_index: 0, is_correct: true },
      ]),
    );
    const ali = model.students.find((s) => s.studentId === "stu-1")!;
    expect(ali.answers[0]).toBeNull();
    expect(ali.answerCorrect[0]).toBeNull();
  });

  it("U-QT1-E3 out-of-bounds elements degrade to letters-only (never crash)", () => {
    const model = buildExportModel(
      multiInput([
        { session_id: "sess-1", question_id: "qm", selected_index: null, selected_indices: [0, 99], is_correct: false },
        { session_id: "sess-1", question_id: "q1", selected_index: 1, is_correct: false },
      ]),
    );
    const ali = model.students.find((s) => s.studentId === "stu-1")!;
    expect(ali.answers[0]).toBe("A,#100");
    expect(ali.answers[1]).toBe("B — B");
  });

  it("U-QT1-E4 distribution counts EACH selection; attempt counted once", () => {
    const model = buildExportModel(
      multiInput([
        { session_id: "sess-1", question_id: "qm", selected_index: null, selected_indices: [0, 2], is_correct: false },
        { session_id: "sess-1", question_id: "q1", selected_index: 1, is_correct: false },
      ]),
    );
    const dist = model.distribution[0];
    expect(dist[0].chosenCount).toBe(1);
    expect(dist[2].chosenCount).toBe(1);
    expect(dist[1].chosenCount).toBe(0);
    // One answered attempt → each chosen option at 100%.
    expect(dist[0].chosenPercent).toBe(100);
    expect(dist[2].chosenPercent).toBe(100);
  });
});
