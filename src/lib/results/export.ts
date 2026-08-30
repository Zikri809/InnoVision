import { deriveSessionDisplayStatus, toEpochMs } from "./derive";
import { RESULTS_SESSION_LIMIT } from "./constants";
import type { DisplayStatus } from "./types";
import type { QuizStatus } from "@/lib/types/aliases";

/**
 * Pure export-model builder for the lecturer Excel download (PLAN_MATRIC_EXCEL_EXPORT §2.3).
 *
 * IMPORTANT: this module is 100% pure (no exceljs import, no server-only
 * modules) so it is Node-unit-testable. The workbook ASSEMBLY lives in
 * `export-workbook.ts`; this file owns every data decision:
 *
 *  - Rows are ROSTER-driven (left-join sessions by student_id): students who
 *    never attempted still get a row with status "not_started" — an attendance
 *    gap must be visible in the artifact, unlike the dashboard which iterates
 *    sessions only.
 *  - Status derivation reuses `deriveSessionDisplayStatus` so screen and
 *    export can never disagree.
 *  - Default order: matric ascending (mark-sheet convention), null matrics
 *    last sorted by name.
 *  - EVERY string cell passes `safeText()` unconditionally — classification-
 *    based scoping was rejected as drift-prone; leading = + - @ TAB CR get a
 *    literal `'` prefix (formula/DDE defense-in-depth for downstream
 *    re-export; exceljs stores plain strings inertly).
 *  - Distribution math counts ANSWERED attempts only; zero-answer questions
 *    yield zeroed percentages (no div-by-zero).
 */

const OPTION_LETTERS = ["A", "B", "C", "D", "E"] as const;

export function optionLetter(index: number): string {
  return OPTION_LETTERS[index] ?? `#${index + 1}`;
}

/**
 * Formula-injection sanitizer applied at the single model choke point.
 * exceljs never turns a plain string into a formula, but recipients re-export
 * to CSV / open in tools that coerce leading operators — prefix with `'`.
 */
export function safeText(value: string | null | undefined): string {
  if (value == null) return "";
  const s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) return `'${s}`;
  return s;
}

export type ExportQuestion = {
  id: string;
  /** 1-based display position (order_index + 1). */
  index: number;
  prompt: string;
  type: string;
  options: string[];
  /** Scalar key (single-answer types); null on multi_select rows (QT-1). */
  correctIndex: number | null;
  /** QT-1: sorted+distinct correct set — null on single-answer types. */
  correctIndices: number[] | null;
  explanation: string | null;
};

/** Session shape the export needs (GET-envelope minus nonce; no key fields). */
export type ExportSessionInput = {
  id: string;
  student_id: string;
  status: "active" | "paused" | "flagged" | "completed";
  score: number | null;
  started_at: string | null;
  submitted_at: string | null;
  last_activity_at: string | number | null;
  face_fail_streak: number | null;
  focus_pause_count: number | null;
  /** 0032 retake attempt number — optional; gradebook cells surface it. */
  attempt?: number | null;
};

export type ExportAnswerInput = {
  session_id: string;
  question_id: string;
  selected_index: number | null;
  /** QT-1: multi-select rows carry the canonical selection set instead. */
  selected_indices?: number[] | null;
  is_correct: boolean;
};

export type ExportRosterInput = {
  student_id: string;
  full_name: string | null;
  matric_no: string | null;
};

export type ExportStudentRow = {
  studentId: string;
  matricNo: string | null;
  fullName: string | null;
  status: DisplayStatus | "not_started";
  score: number | null;
  total: number;
  percent: number | null;
  startedAtISO: string | null;
  submittedAtISO: string | null;
  durationSec: number | null;
  faceFails: number | null;
  focusPauses: number | null;
  /** Per-question cell text ("B — Photosynthesis"); null = unanswered. */
  answers: (string | null)[];
  answerCorrect: (boolean | null)[];
};

export type OptionDistribution = {
  optionIndex: number;
  chosenCount: number;
  chosenPercent: number;
};

export type ExportModel = {
  meta: {
    quizTitle: string;
    className: string | null;
    mode: string;
    quizStatus: QuizStatus;
    generatedAtISO: string;
    totalQuestions: number;
    attemptedCount: number;
    truncated: boolean;
  };
  questions: ExportQuestion[];
  students: ExportStudentRow[];
  /** Per question, per option choice counts (answered attempts only). */
  distribution: OptionDistribution[][];
};

/**
 * Pick the REPRESENTATIVE attempt per student. Assessment quizzes have at most
 * one session (0008's partial unique index), so this only ever matters for
 * practice retakes: prefer the terminal attempt (completed/flagged), else the
 * most recently STARTED one.
 *
 * Deliberate grading semantics, NOT strict dashboard parity: the dashboard
 * ranks in_progress above completed (GROUP_RANK), while the export keeps the
 * completed attempt because that is where a score exists. Within terminal
 * attempts the newest wins (route feeds sessions started_at DESC, id DESC —
 * deterministic ties). Results rows, distribution math, and attemptedCount all
 * draw from exactly this session set so the workbook can never contradict
 * itself.
 *
 * ORDER CONTRACT (RA-1 gradebook consumes this too): the input MUST be fed
 * started_at DESC, id DESC (the export route's order, api/quizzes/[id]/export/
 * route.ts) — the loop keeps the FIRST terminal row encountered, so "newest
 * terminal wins" only holds under that feed order. The gradebook read/sort
 * replicates it; a differently-ordered feed yields nondeterministic retake
 * cells.
 */
export function selectRepresentativeSessions(
  sessions: ExportSessionInput[],
): ExportSessionInput[] {
  const byStudent = new Map<string, ExportSessionInput>();
  const isTerminal = (s: ExportSessionInput) =>
    s.status === "completed" || s.status === "flagged";
  for (const s of sessions) {
    const cur = byStudent.get(s.student_id);
    if (!cur) {
      byStudent.set(s.student_id, s);
      continue;
    }
    if (isTerminal(cur)) continue;
    if (!isTerminal(s) && (toEpochMs(s.started_at) ?? 0) <= (toEpochMs(cur.started_at) ?? 0)) {
      continue;
    }
    byStudent.set(s.student_id, s);
  }
  return [...byStudent.values()];
}

export type BuildExportInput = {
  quiz: { title: string; mode: string; status: QuizStatus };
  className: string | null;
  generatedAtISO: string;
  questions: {
    id: string;
    order_index: number;
    type: string;
    prompt: string;
    options: string[] | null;
    correct_index: number | null;
    correct_indices: number[] | null;
    explanation: string | null;
  }[];
  roster: ExportRosterInput[];
  sessions: ExportSessionInput[];
  answers: ExportAnswerInput[];
  nowMs: number;
  /** True when the route's answer fetch hit its hard row cap. */
  answersTruncated?: boolean;
};

export function buildExportModel(input: BuildExportInput): ExportModel {
  // Questions in presentation order; prompts/options pass safeText.
  const questions: ExportQuestion[] = [...input.questions]
    .sort((a, b) => a.order_index - b.order_index)
    .map((q, i) => ({
      id: q.id,
      index: i + 1,
      prompt: safeText(q.prompt),
      type: q.type,
      options: (q.options ?? []).map((o) => safeText(o)),
      correctIndex: q.correct_index,
      correctIndices: q.correct_indices,
      explanation: q.explanation ? safeText(q.explanation) : null,
    }));

  const total = questions.length;

  // Answers keyed by session+question for O(1) row assembly.
  const answersByKey = new Map<string, ExportAnswerInput>();
  for (const a of input.answers) answersByKey.set(`${a.session_id}:${a.question_id}`, a);

  // One representative session per student (see docstring above).
  const selectedSessions = selectRepresentativeSessions(input.sessions);
  const sessionByStudent = new Map(selectedSessions.map((s) => [s.student_id, s]));
  const rosterIds = new Set(input.roster.map((r) => r.student_id));
  // Sessions whose student is missing from the roster (left the class after
  // attempting) still get a row — same honesty rule as the dashboard, which
  // keeps session-without-roster rows with a null name.
  const orphanSessions = selectedSessions.filter((s) => !rosterIds.has(s.student_id));

  const buildRow = (
    studentId: string,
    fullName: string | null,
    matricNo: string | null,
    session: ExportSessionInput | undefined,
  ): ExportStudentRow => {
    if (!session) {
      return {
        studentId,
        matricNo,
        fullName,
        status: "not_started",
        score: null,
        total,
        percent: null,
        startedAtISO: null,
        submittedAtISO: null,
        durationSec: null,
        faceFails: null,
        focusPauses: null,
        answers: Array.from({ length: total }, () => null),
        answerCorrect: Array.from({ length: total }, () => null),
      };
    }

    const displayStatus = deriveSessionDisplayStatus(
      { status: session.status, last_activity_at: session.last_activity_at },
      { quizStatus: input.quiz.status, nowMs: input.nowMs },
    );

    const startMs = toEpochMs(session.started_at);
    const submitMs = toEpochMs(session.submitted_at);
    const durationSec =
      startMs !== null && submitMs !== null && submitMs >= startMs
        ? Math.round((submitMs - startMs) / 1000)
        : null;

    const answers: (string | null)[] = [];
    const answerCorrect: (boolean | null)[] = [];
    for (const q of questions) {
      const a = answersByKey.get(`${session.id}:${q.id}`);
      // QT-1: multi rows are "answered" when the selection SET is present —
      // their selected_index is ALWAYS null. Cell contract: joined letters +
      // " — " + selected texts joined " / " (e.g. "A,C — X / Y"). The set is
      // sorted defensively (the RPC stores it canonical; a hostile/foreign
      // writer must not scramble the cell).
      const multiSelected =
        q.type === "multi_select"
          ? [...(a?.selected_indices ?? [])].sort((x, y) => x - y)
          : null;
      const isMultiAnswered = multiSelected != null && multiSelected.length > 0;
      if (!a || (!isMultiAnswered && a.selected_index === null)) {
        answers.push(null);
        answerCorrect.push(null);
        continue;
      }
      if (isMultiAnswered) {
        const inBounds = multiSelected.every((i) => i >= 0 && i < q.options.length);
        const texts = multiSelected.map((i) => q.options[i]);
        const letters = multiSelected.map((i) => optionLetter(i)).join(",");
        answers.push(
          inBounds && texts.every((t) => t != null)
            ? `${letters} — ${texts.join(" / ")}`
            : letters,
        );
        answerCorrect.push(a.is_correct);
        continue;
      }
      const text = q.options[a.selected_index!];
      answers.push(
        text != null ? `${optionLetter(a.selected_index!)} — ${text}` : optionLetter(a.selected_index!),
      );
      answerCorrect.push(a.is_correct);
    }

    return {
      studentId,
      matricNo,
      fullName,
      status: displayStatus,
      score: session.score,
      total,
      percent:
        session.score !== null && total > 0
          ? Math.round((session.score / total) * 100)
          : null,
      startedAtISO: session.started_at,
      submittedAtISO: session.submitted_at,
      durationSec,
      faceFails: session.face_fail_streak,
      focusPauses: session.focus_pause_count,
      answers,
      answerCorrect,
    };
  };

  const students: ExportStudentRow[] = [
    ...input.roster.map((r) =>
      buildRow(r.student_id, r.full_name ? safeText(r.full_name) : null, r.matric_no ? safeText(r.matric_no) : null, sessionByStudent.get(r.student_id)),
    ),
    // Orphan attempts last — no roster entry means we can't show a name.
    ...orphanSessions.map((s) => buildRow(s.student_id, null, null, s)),
  ];

  // Mark-sheet convention: matric ascending, null-matrics last by name.
  students.sort((a, b) => {
    if (a.matricNo && b.matricNo) return a.matricNo.localeCompare(b.matricNo, undefined, { sensitivity: "base" });
    if (a.matricNo) return -1;
    if (b.matricNo) return 1;
    return (a.fullName ?? "").localeCompare(b.fullName ?? "", undefined, { sensitivity: "base" });
  });

  // Choice distribution over ANSWERED attempts of the REPRESENTATIVE sessions
  // only — never over raw sessions, so the numbers always match the visible
  // rows above. QT-1: multi rows count EACH selected option (an attempt still
  // adds 1 to answeredCount, so per-option percentages stay out of 100).
  const distribution: OptionDistribution[][] = questions.map((q) => {
    const keyBound = Math.max(
      q.correctIndex ?? -1,
      ...(q.correctIndices ?? []),
    );
    const counts = new Array<number>(Math.max(q.options.length, keyBound + 1)).fill(0);
    let answeredCount = 0;
    for (const s of selectedSessions) {
      const a = answersByKey.get(`${s.id}:${q.id}`);
      if (!a) continue;
      if (q.type === "multi_select") {
        const sel = a.selected_indices ?? [];
        if (sel.length === 0) continue;
        for (const i of sel) {
          if (i < 0 || i >= counts.length) continue;
          counts[i] += 1;
        }
        answeredCount += 1;
        continue;
      }
      if (a.selected_index === null) continue;
      if (a.selected_index < 0 || a.selected_index >= counts.length) continue;
      counts[a.selected_index] += 1;
      answeredCount += 1;
    }
    return q.options.map((_, oi) => ({
      optionIndex: oi,
      chosenCount: counts[oi],
      chosenPercent:
        answeredCount > 0 ? Math.round((counts[oi] / answeredCount) * 100) : 0,
    }));
  });

  return {
    meta: {
      quizTitle: safeText(input.quiz.title),
      className: input.className ? safeText(input.className) : null,
      mode: input.quiz.mode,
      quizStatus: input.quiz.status,
      generatedAtISO: input.generatedAtISO,
      totalQuestions: total,
      attemptedCount: selectedSessions.length,
      truncated:
        input.sessions.length >= RESULTS_SESSION_LIMIT ||
        input.roster.length >= ROSTER_EXPORT_CAP ||
        Boolean(input.answersTruncated),
    },
    questions,
    students,
    distribution,
  };
}

/** Roster read cap used by the export route (mirrors getClassRoster's cap). */
export const ROSTER_EXPORT_CAP = 100;

/** Times-correct/times-answered aggregates per question (key sheet). */
export function summarizeQuestionStats(
  model: ExportModel,
): { timesAnswered: number; timesCorrect: number; percentCorrect: number }[] {
  return model.questions.map((q) => {
    let answered = 0;
    let correct = 0;
    for (const s of model.students) {
      const idx = q.index - 1;
      if (s.answerCorrect[idx] === true) {
        correct += 1;
        answered += 1;
      } else if (s.answerCorrect[idx] === false) {
        answered += 1;
      }
    }
    return {
      timesAnswered: answered,
      timesCorrect: correct,
      percentCorrect: answered > 0 ? Math.round((correct / answered) * 100) : 0,
    };
  });
}
