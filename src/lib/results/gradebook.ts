import {
  selectRepresentativeSessions,
  type ExportSessionInput,
} from "./export";
import { coerceScore } from "./derive";
import { ROSTER_LIMIT } from "@/lib/classes/roster";

/**
 * Pure gradebook-model builder for RA-1 (cross-quiz class gradebook).
 *
 * IMPORTANT: 100% pure — no server-only imports, no DB — Node-unit-testable,
 * same discipline as export.ts. The RSC page and the workbook export route
 * both consume this model so on-screen matrix and downloaded artifact can
 * never disagree.
 *
 * Data decisions (see docs/roadmap/PLAN_R_RESULTS_ANALYTICS.md RA-1):
 *  - Rows = roster students (left-join representative sessions); orphans
 *    (sessions without roster rows) appended last with null name — same
 *    honesty rule as the per-quiz export.
 *  - Columns = PUBLISHED ASSESSMENT quizzes only (drafts/practice excluded),
 *    chronological (created_at ASC), capped at GRADEBOOK_QUIZ_LIMIT with a
 *    truncation flag.
 *  - Cell = representative session per (student, quiz) via the SAME policy
 *    as the per-quiz export (selectRepresentativeSessions) — callers MUST
 *    feed sessions started_at DESC, id DESC (see that function's order
 *    contract). Flagged sessions ARE score-bearing (intentional divergence
 *    from the student card, documented in both roadmap plans).
 *  - Percent = round(score / RESOLVED questions * 100), where resolved =
 *    questionCount − the session's pending AI-marked answers. A cell whose
 *    session still holds pending answers renders as pending (never as a 0):
 *    the D10 score SUM excludes pending rows, so dividing by the FULL count
 *    would read a partially-marked attempt as a low score. `resolved = 0`
 *    (every answer pending) → percent null. Null (em dash) when no
 *    representative session or a 0-question quiz. Cumulative % per student =
 *    round(sum(score) / sum(resolved) * 100) over attempted quizzes only;
 *    hidden (null) when the student attempted nothing.
 *  - Footer = per-quiz class average over attempted cells only.
 */

/** Column cap for the gradebook matrix (plan RA-1 pre-flight decision). */
export const GRADEBOOK_QUIZ_LIMIT = 50;

export type GradebookQuiz = {
  id: string;
  title: string;
  status: string;
  /** quizzes.results_revealed_at — null = students can't see scores yet. */
  results_revealed_at: string | null;
  created_at: string;
};

export type GradebookQuestionCount = {
  quiz_id: string;
  count: number;
};

export type GradebookRosterEntry = {
  student_id: string;
  full_name: string | null;
  matric_no: string | null;
};

export type GradebookCell = {
  /** Representative session id, or null when never attempted (em dash). */
  sessionId: string | null;
  score: number | null;
  total: number;
  /**
   * Denominator the percent was computed over: `total − pendingCount`. The
   * D10 score SUM excludes pending rows, so the two must travel together or
   * a partially-marked cell reads as a low score.
   */
  resolved: number;
  percent: number | null;
  /**
   * Answers still awaiting an AI mark. A non-zero count renders the cell as
   * PENDING (neutral chip) rather than a number — the score is provisional
   * and a percentage would understate the student.
   */
  pendingCount: number;
  /** 0032 attempt number, surfaced so retake cells are auditable. */
  attempt: number | null;
};

export type GradebookRow = {
  studentId: string;
  fullName: string | null;
  matricNo: string | null;
  cells: (GradebookCell | null)[];
  /** Cumulative % over attempted quizzes; null = attempted nothing. */
  cumulativePercent: number | null;
  /**
   * audit-4 M7: true when ANY of the row's cells carries an unresolved mark.
   * The cumulative percent excludes pending cells, so a student who attempted
   * everything but awaits marks would otherwise render as `notAttempted` — the
   * exact mislabel the per-cell chips avoid. Surfaces render the pending
   * label instead.
   */
  hasPending: boolean;
  /**
   * Integrity sums over the row's REPRESENTATIVE sessions (audit-1 P1-16:
   * fullscreen/hand farming used to be invisible in the cross-quiz
   * gradebook while the per-quiz export showed the counters). faceFails
   * mirrors the per-quiz export convention: lifetime face_fail_count when
   * present, else the resettable streak.
   */
  faceFails: number;
  fullscreenPauses: number;
  handPauses: number;
};

export type GradebookModel = {
  className: string | null;
  quizzes: {
    id: string;
    title: string;
    revealed: boolean;
    questionCount: number;
    /** Class average percent over attempted cells; null = nobody attempted. */
    averagePercent: number | null;
  }[];
  rows: GradebookRow[];
  /** True when published assessment quizzes exceeded GRADEBOOK_QUIZ_LIMIT. */
  truncated: boolean;
  /** Students beyond ROSTER_LIMIT were dropped by the roster read. */
  rosterTruncated: boolean;
};

export type BuildGradebookInput = {
  className: string | null;
  roster: GradebookRosterEntry[];
  /** PUBLISHED ASSESSMENT quizzes, any order — sorted here (created_at ASC). */
  quizzes: GradebookQuiz[];
  /** questionCount per quiz id (0/absent = 0-question quiz). */
  questionCounts: GradebookQuestionCount[];
  /**
   * Sessions for ALL the class's quizzes, keyed by quiz_id. Each inner array
   * MUST be fed started_at DESC, id DESC (selectRepresentativeSessions order
   * contract).
   */
  sessionsByQuiz: Map<string, ExportSessionInput[]>;
  /**
   * audit-2 M-13 / audit-3 B-F5: the roster read's own truncation flag. The
   * roster array is ALREADY capped by getClassRoster, so the model cannot
   * infer truncation from its length (exactly-100 is indistinguishable from
   * >100); callers pass the read's flag through. Omitted (pure-model callers)
   * → inferred as `roster.length > ROSTER_LIMIT`, i.e. flagged only when rows
   * were ACTUALLY dropped by an uncapped feed (the old `>=` off-by-one
   * reported a full, untruncated 100-row roster as truncated).
   */
  rosterTruncated?: boolean;
};

/**
 * The denominator a session's percent divides by: the quiz's question count
 * minus the answers still awaiting an AI mark. Never negative — a stale
 * `pending_count` (a mark that resolved between the session read and the
 * count) must degrade to the full count, not to a nonsense negative one.
 */
function resolvedCount(total: number, session: ExportSessionInput): number {
  const pending = Math.max(0, Math.floor(session.pending_count ?? 0));
  return Math.max(0, total - pending);
}

export function buildGradebookModel(input: BuildGradebookInput): GradebookModel {
  const quizzes = [...input.quizzes]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, GRADEBOOK_QUIZ_LIMIT);
  const truncated = input.quizzes.length > GRADEBOOK_QUIZ_LIMIT;

  const countByQuiz = new Map(input.questionCounts.map((q) => [q.quiz_id, q.count]));

  const columns = quizzes.map((quiz) => {
    const total = countByQuiz.get(quiz.id) ?? 0;
    const sessions = input.sessionsByQuiz.get(quiz.id) ?? [];
    // Order contract: caller feeds started_at DESC, id DESC.
    const repByStudent = new Map(
      selectRepresentativeSessions(sessions).map((s) => [s.student_id, s]),
    );

    const percents: number[] = [];
    for (const s of repByStudent.values()) {
      const score = coerceScore(s.score);
      // audit-4 M11: a session with ANY pending answer is EXCLUDED from the
      // average entirely — its percent would be provisional (computed over a
      // partial denominator), and the per-cell UI already refuses to show it
      // as a number. Averaging what the cell hides would leak the provisional
      // grade through the footer. Pending answers are also excluded from the
      // denominator, so a fully-pending session contributes nothing.
      const resolved = resolvedCount(total, s);
      const pendingCount = Math.max(0, Math.floor(s.pending_count ?? 0));
      if (score !== null && resolved > 0 && pendingCount === 0) {
        percents.push(Math.round((score / resolved) * 100));
      }
    }
    const averagePercent =
      percents.length > 0
        ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length)
        : null;

    return {
      id: quiz.id,
      title: quiz.title,
      revealed: quiz.results_revealed_at !== null,
      questionCount: total,
      averagePercent,
      repByStudent,
    };
  });

  const rows: GradebookRow[] = [];
  const rosterIds = new Set(input.roster.map((r) => r.student_id));

  // Single row builder for BOTH roster rows and orphan rows so their cells,
  // cumulative %, and integrity sums can never diverge (audit-3 B-F1).
  const buildRow = (
    studentId: string,
    fullName: string | null,
    matricNo: string | null,
  ): GradebookRow => {
    const cells = columns.map((col) => {
      const s = col.repByStudent.get(studentId);
      if (!s) return null;
      const score = coerceScore(s.score);
      const resolved = resolvedCount(col.questionCount, s);
      // Pending answers carry no score yet (the D10 SUM skips them), so the
      // cell's percent is a RESOLVED-denominator number that EVERY surface
      // must gate on `pendingCount > 0` before rendering — audit-4 M10: the
      // mobile per-quiz sheet read this field straight out and leaked a
      // provisional "100%" as a final grade. The model keeps the resolved
      // arithmetic (plan §4); the surfaces own the neutral chip.
      const pendingCount = Math.max(0, Math.floor(s.pending_count ?? 0));
      if (score === null || col.questionCount === 0) return null;
      return {
        sessionId: s.id,
        score,
        total: col.questionCount,
        resolved,
        percent: resolved > 0 ? Math.round((score / resolved) * 100) : null,
        pendingCount,
        attempt: s.attempt ?? null,
      } satisfies GradebookCell;
    });

    let sumScore = 0;
    let sumResolved = 0;
    let hasPending = false;
    for (const cell of cells) {
      if (cell && cell.pendingCount === 0) {
        sumScore += cell.score ?? 0;
        sumResolved += cell.resolved;
      } else if (cell) {
        hasPending = true;
      }
    }
    const cumulativePercent =
      sumResolved > 0 ? Math.round((sumScore / sumResolved) * 100) : null;

    // Integrity sums run over the representative sessions THEMSELVES —
    // not the score-bearing cells — so a flagged/0-score session's
    // counter still shows (that is exactly the session worth seeing).
    let faceFails = 0;
    let fullscreenPauses = 0;
    let handPauses = 0;
    for (const col of columns) {
      const s = col.repByStudent.get(studentId);
      if (!s) continue;
      faceFails += s.face_fail_count ?? s.face_fail_streak ?? 0;
      fullscreenPauses += s.fullscreen_pause_count ?? 0;
      handPauses += s.hand_pause_count ?? 0;
    }

    return {
      studentId,
      fullName,
      matricNo,
      cells,
      cumulativePercent,
      hasPending,
      faceFails,
      fullscreenPauses,
      handPauses,
    };
  };

  for (const r of input.roster) {
    rows.push(buildRow(r.student_id, r.full_name, r.matric_no));
  }

  // audit-3 B-F1: orphan attempts (representative sessions whose student is
  // no longer on the roster — removed/unenrolled, or pushed past the 100-row
  // roster read cap) get appended rows with a null name, exactly like the
  // per-quiz export's honesty rule (export.ts orphanSessions). The per-quiz
  // class average already counted these students; without a row the Summary
  // sheet silently dropped them while the average kept including them.
  const orphanIds = new Set<string>();
  for (const col of columns) {
    for (const studentId of col.repByStudent.keys()) {
      if (!rosterIds.has(studentId)) orphanIds.add(studentId);
    }
  }
  for (const studentId of [...orphanIds].sort()) {
    rows.push(buildRow(studentId, null, null));
  }

  return {
    className: input.className,
    quizzes: columns.map((col) => ({
      id: col.id,
      title: col.title,
      revealed: col.revealed,
      questionCount: col.questionCount,
      averagePercent: col.averagePercent,
    })),
    rows,
    truncated,
    rosterTruncated:
      input.rosterTruncated ?? input.roster.length > ROSTER_LIMIT,
  };
}
