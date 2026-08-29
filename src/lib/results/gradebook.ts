import {
  selectRepresentativeSessions,
  type ExportSessionInput,
} from "./export";
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
 *  - Percent = round(score / questionCount * 100); null (em dash) when no
 *    representative session or a 0-question quiz. Cumulative % per student =
 *    round(sum(score) / sum(questionCount) * 100) over attempted quizzes
 *    only; hidden (null) when the student attempted nothing.
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
  percent: number | null;
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
};

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
      if (s.score !== null && total > 0) percents.push(Math.round((s.score / total) * 100));
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

  const rows: GradebookRow[] = input.roster.map((r) => {
    const cells = columns.map((col) => {
      const s = col.repByStudent.get(r.student_id);
      if (!s || s.score === null || col.questionCount === 0) return null;
      return {
        sessionId: s.id,
        score: s.score,
        total: col.questionCount,
        percent: Math.round((s.score / col.questionCount) * 100),
        attempt: s.attempt ?? null,
      } satisfies GradebookCell;
    });

    let sumScore = 0;
    let sumTotal = 0;
    for (const cell of cells) {
      if (cell) {
        sumScore += cell.score;
        sumTotal += cell.total;
      }
    }
    const cumulativePercent =
      sumTotal > 0 ? Math.round((sumScore / sumTotal) * 100) : null;

    return {
      studentId: r.student_id,
      fullName: r.full_name,
      matricNo: r.matric_no,
      cells,
      cumulativePercent,
    };
  });

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
    rosterTruncated: input.roster.length >= ROSTER_LIMIT,
  };
}
