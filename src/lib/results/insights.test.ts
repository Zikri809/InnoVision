import { describe, expect, it } from "vitest";
import { LOW_CORRECT_THRESHOLD, buildQuestionInsights } from "./insights";
import { buildExportModel } from "./export";

const NOW = Date.parse("2026-09-01T10:00:00.000Z");

function baseInput(overrides: Partial<Parameters<typeof buildExportModel>[0]> = {}) {
  return {
    quiz: { title: "RA-2 Quiz", mode: "assessment", status: "closed" as const },
    className: "RA-2 Class",
    generatedAtISO: new Date(NOW).toISOString(),
    questions: [
      {
        id: "q1",
        order_index: 0,
        type: "mcq",
        prompt: "Stumped everyone?",
        options: ["A1", "B1", "C1"],
        correct_index: 1,
        correct_indices: null,
        explanation: null,
      },
      {
        id: "q2",
        order_index: 1,
        type: "mcq",
        prompt: "Easy one?",
        options: ["A2", "B2", "C2"],
        correct_index: 0,
        correct_indices: null,
        explanation: null,
      },
      {
        id: "q3",
        order_index: 2,
        type: "multi_select",
        prompt: "Pick the mammals?",
        options: ["Bat", "Trout", "Dog"],
        correct_index: null,
        correct_indices: [0, 2],
        explanation: null,
      },
    ],
    roster: [
      { student_id: "s1", full_name: "One", matric_no: "810001" },
      { student_id: "s2", full_name: "Two", matric_no: "810002" },
    ],
    sessions: [
      {
        id: "sess1",
        student_id: "s1",
        status: "completed" as const,
        score: 1,
        started_at: "2026-09-01T09:00:00.000Z",
        submitted_at: "2026-09-01T09:30:00.000Z",
        last_activity_at: "2026-09-01T09:30:00.000Z",
        face_fail_streak: 0,
        focus_pause_count: 0,
      },
      {
        id: "sess2",
        student_id: "s2",
        status: "completed" as const,
        score: 3,
        started_at: "2026-09-01T09:00:00.000Z",
        submitted_at: "2026-09-01T09:25:00.000Z",
        last_activity_at: "2026-09-01T09:25:00.000Z",
        face_fail_streak: 0,
        focus_pause_count: 0,
      },
    ],
    answers: [
      // Q1: BOTH students pick the wrong option A (index 0) — 0% correct, and
      // distractors B?? no: B1 is the KEY. Wrong picks on A only → C1 never picked.
      { session_id: "sess1", question_id: "q1", selected_index: 0, selected_indices: null, is_correct: false },
      { session_id: "sess2", question_id: "q1", selected_index: 0, selected_indices: null, is_correct: false },
      // Q2: both correct on A2 (index 0); distractors B2/C2 never picked.
      { session_id: "sess1", question_id: "q2", selected_index: 0, selected_indices: null, is_correct: true },
      { session_id: "sess2", question_id: "q2", selected_index: 0, selected_indices: null, is_correct: true },
      // Q3 (multi): sess1 picks {Bat}; sess2 picks {Bat, Dog} — both correct.
      { session_id: "sess1", question_id: "q3", selected_index: null, selected_indices: [0], is_correct: true },
      { session_id: "sess2", question_id: "q3", selected_index: null, selected_indices: [0, 2], is_correct: true },
    ],
    nowMs: NOW,
    ...overrides,
  };
}

describe("RA-2 — buildQuestionInsights", () => {
  it("mirrors the export model's stats + distribution exactly", () => {
    const input = baseInput();
    const insights = buildQuestionInsights(input);
    expect(insights.questions).toHaveLength(3);
    // Q1: 0/2 → 0%.
    expect(insights.questions[0].timesAnswered).toBe(2);
    expect(insights.questions[0].timesCorrect).toBe(0);
    expect(insights.questions[0].percentCorrect).toBe(0);
    // Q2: 2/2 → 100%.
    expect(insights.questions[1].percentCorrect).toBe(100);
    // Distribution mirror: Q1 option 0 picked by both.
    expect(insights.questions[0].distribution[0].chosenCount).toBe(2);
    expect(insights.questions[0].distribution[0].chosenPercent).toBe(100);
    // QT-1 multi: each selection counts; per-option percentages out of 100.
    expect(insights.questions[2].distribution[0].chosenCount).toBe(2);
    expect(insights.questions[2].distribution[2].chosenCount).toBe(1);
    expect(insights.questions[2].distribution[2].chosenPercent).toBe(50);
  });

  it("flags low-correct questions under the 30% threshold only", () => {
    const insights = buildQuestionInsights(baseInput());
    expect(insights.questions[0].lowCorrect).toBe(true); // 0%
    expect(insights.questions[1].lowCorrect).toBe(false); // 100%
    expect(LOW_CORRECT_THRESHOLD).toBe(30);
  });

  it("flags never-picked distractors on answered questions only", () => {
    const insights = buildQuestionInsights(baseInput());
    // Q1 answered: C1 (a wrong option) never picked → flagged.
    expect(insights.questions[0].hasNeverPickedDistractor).toBe(true);
    // Q2 answered: B2 and C2 both never picked → flagged.
    expect(insights.questions[1].hasNeverPickedDistractor).toBe(true);
    // Q3 multi: Trout (index 1, wrong) never picked → flagged.
    expect(insights.questions[2].hasNeverPickedDistractor).toBe(true);
    // A distractor ON the key must not count: Q1's key is B1 (index 1) —
    // craft a variant where B1 is unpicked but everything else picked.
    const input = baseInput();
    input.answers = [
      { session_id: "sess1", question_id: "q1", selected_index: 0, selected_indices: null, is_correct: false },
      { session_id: "sess2", question_id: "q1", selected_index: 2, selected_indices: null, is_correct: false },
    ];
    const v = buildQuestionInsights(input);
    // Wrong options A1 and C1 were both picked; only the KEY B1 is unpicked.
    expect(v.questions[0].hasNeverPickedDistractor).toBe(false);
    expect(v.questions[0].lowCorrect).toBe(true); // 0% — still a teaching gap
  });

  it("does not flag unanswered questions (zero-answer → zeroed, no hint)", () => {
    const input = baseInput();
    input.answers = [];
    const insights = buildQuestionInsights(input);
    for (const q of insights.questions) {
      expect(q.timesAnswered).toBe(0);
      expect(q.percentCorrect).toBe(0);
      expect(q.lowCorrect).toBe(false);
      expect(q.hasNeverPickedDistractor).toBe(false);
    }
    expect(insights.hasDegenerate).toBe(false);
  });

  it("aggregates hasDegenerate across both hint kinds", () => {
    const insights = buildQuestionInsights(baseInput());
    expect(insights.hasDegenerate).toBe(true);
  });

  it("honors the representative-session policy (latest terminal wins)", () => {
    // s1 attempted twice: an old completed + a newer completed — the export
    // model keeps the NEWEST terminal (feed order started_at DESC). Feed the
    // sessions in the route's DESC order and give the two attempts different
    // answers; insights must reflect only the newest attempt.
    const input = baseInput();
    input.sessions = [
      {
        id: "sess1-new",
        student_id: "s1",
        status: "completed" as const,
        score: 1,
        started_at: "2026-09-01T09:50:00.000Z",
        submitted_at: "2026-09-01T09:55:00.000Z",
        last_activity_at: "2026-09-01T09:55:00.000Z",
        face_fail_streak: 0,
        focus_pause_count: 0,
      },
      {
        id: "sess1-old",
        student_id: "s1",
        status: "completed" as const,
        score: 0,
        started_at: "2026-09-01T09:00:00.000Z",
        submitted_at: "2026-09-01T09:05:00.000Z",
        last_activity_at: "2026-09-01T09:05:00.000Z",
        face_fail_streak: 0,
        focus_pause_count: 0,
      },
      input.sessions[1],
    ];
    input.answers = [
      { session_id: "sess1-new", question_id: "q1", selected_index: 1, selected_indices: null, is_correct: true },
      { session_id: "sess1-old", question_id: "q1", selected_index: 0, selected_indices: null, is_correct: false },
      { session_id: "sess2", question_id: "q1", selected_index: 1, selected_indices: null, is_correct: true },
    ];
    const insights = buildQuestionInsights(input);
    // Both representative sessions answered Q1 CORRECTLY → 100% (the abandoned
    // old attempt's wrong answer must NOT count).
    expect(insights.questions[0].timesAnswered).toBe(2);
    expect(insights.questions[0].timesCorrect).toBe(2);
    expect(insights.questions[0].percentCorrect).toBe(100);
  });
});
