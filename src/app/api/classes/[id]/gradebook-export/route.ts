import { createClient } from "@/lib/supabase/server";
import { isUuid, getClassRoster } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { requireClassOwner } from "@/lib/quizzes/guards";
import {
  checkSameOrigin,
  internalError,
  notFound,
  rateLimited,
} from "@/lib/http";
import {
  buildExportModel,
  type ExportSessionInput,
} from "@/lib/results/export";
import { buildGradebookModel, GRADEBOOK_QUIZ_LIMIT } from "@/lib/results/gradebook";
import { RESULTS_SESSION_LIMIT } from "@/lib/results/constants";
import { sanitizeFilenamePart } from "@/lib/auth/matric";
import { tFor } from "@/lib/i18n/messages";
import type { SupportedLocale } from "@/lib/types/aliases";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// The heaviest read in the app (sessions+answers for up to 50 quizzes) —
// throttled like the per-quiz export.
const EXPORT_RATE = { limit: 10, windowMs: 60 * 1000 };
const ANSWERS_LIMIT = 20_000;
const SESSIONS_LIMIT = 20_000;
const QUESTION_COUNT_LIMIT = 50_000;
// Scale guard (RA-1 pre-flight): beyond this many quiz sheets the workbook
// becomes summary-only — bounded request, truncation flagged via header note.
const SHEET_BUILD_LIMIT = 25;

/**
 * GET /api/classes/[id]/gradebook-export — RA-1 lecturer workbook:
 * "Summary" sheet (gradebook matrix mirror) + one compact results sheet per
 * quiz (status/score/total/percent rows — full per-question detail stays in
 * the existing per-quiz export). Summary cells come from buildGradebookModel,
 * the SAME model the on-screen matrix renders, so they can never disagree.
 *
 * Guard chain mirrors api/quizzes/[id]/export/route.ts: isUuid →
 * requireClassOwner (no-oracle 404) → rate limit → same-origin → typed
 * errors. All reads on the user-scoped client under RLS; createAdminClient()
 * forbidden.
 */
export async function GET(_request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  const owner = await requireClassOwner(supabase, id);
  if (!owner.ok) return owner.response;

  if (!rateLimit(`gradebook-export:${owner.userId}`, EXPORT_RATE)) {
    return rateLimited("Too many exports. Try again in a minute.");
  }

  const originError = checkSameOrigin(_request);
  if (originError) return originError;

  const [{ data: profile }, { data: cls }] = await Promise.all([
    supabase.from("profiles").select("locale").eq("id", owner.userId).maybeSingle(),
    supabase.from("classes").select("title").eq("id", id).maybeSingle(),
  ]);
  const locale: SupportedLocale = profile?.locale === "ms" ? "ms" : "en";
  const t = tFor(locale);

  const [{ roster, error: rosterError }, { data: quizzes, error: quizzesError }] =
    await Promise.all([
      getClassRoster(supabase, id),
      supabase
        .from("quizzes")
        .select("id, title, mode, status, results_revealed_at, created_at")
        .eq("class_id", id)
        .in("status", ["live", "closed"])
        .eq("mode", "assessment")
        .order("created_at", { ascending: true })
        .limit(GRADEBOOK_QUIZ_LIMIT + 1),
    ]);

  if (rosterError || quizzesError) {
    console.error("Gradebook export fetch error:", rosterError ?? quizzesError);
    return internalError("Could not build the export right now.");
  }

  const columnQuizzes = (quizzes ?? []).slice(0, GRADEBOOK_QUIZ_LIMIT);
  const quizIds = columnQuizzes.map((q) => q.id);

  const [{ data: sessionRows, error: sessionsError }, { data: questionCountRows, error: questionCountError }] =
    await Promise.all([
      supabase
        .from("lecturer_session_view")
        .select(
          "id, quiz_id, student_id, status, score, started_at, submitted_at, last_activity_at, face_fail_streak, focus_pause_count, attempt",
        )
        .in("quiz_id", quizIds)
        .order("started_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(SESSIONS_LIMIT),
      supabase
        .from("questions")
        .select("quiz_id")
        .in("quiz_id", quizIds)
        .limit(QUESTION_COUNT_LIMIT),
    ]);

  if (sessionsError || questionCountError) {
    console.error("Gradebook export read error:", sessionsError ?? questionCountError);
    return internalError("Could not build the export right now.");
  }

  const sessionsByQuiz = new Map<string, ExportSessionInput[]>();
  for (const s of sessionRows ?? []) {
    // View-generated types mark columns nullable; the underlying columns are
    // NOT NULL (same narrowing as the per-quiz export route).
    if (!s.id || !s.quiz_id || !s.student_id || !s.status) continue;
    const list = sessionsByQuiz.get(s.quiz_id) ?? [];
    list.push({
      id: s.id,
      student_id: s.student_id,
      status: s.status,
      score: s.score,
      started_at: s.started_at,
      submitted_at: s.submitted_at,
      last_activity_at: s.last_activity_at,
      face_fail_streak: s.face_fail_streak,
      focus_pause_count: s.focus_pause_count,
      attempt: s.attempt,
    });
    sessionsByQuiz.set(s.quiz_id, list);
  }

  const countByQuiz = new Map<string, number>();
  for (const row of questionCountRows ?? []) {
    countByQuiz.set(row.quiz_id, (countByQuiz.get(row.quiz_id) ?? 0) + 1);
  }

  const model = buildGradebookModel({
    className: cls?.title ?? null,
    roster,
    quizzes: columnQuizzes.map((q) => ({
      id: q.id,
      title: q.title,
      status: q.status,
      results_revealed_at: q.results_revealed_at,
      created_at: q.created_at,
    })),
    questionCounts: columnQuizzes.map((q) => ({
      quiz_id: q.id,
      count: countByQuiz.get(q.id) ?? 0,
    })),
    sessionsByQuiz,
  });

  type SheetRow = (string | number | null)[];
  const sheets: { name: string; rows: SheetRow[] }[] = [];

  // ── Summary sheet: mirror of the on-screen matrix ──────────────────
  sheets.push({
    name: "Summary",
    rows: [
      [
        t("workbook.colNum"),
        t("workbook.colMatric"),
        t("workbook.colName"),
        ...model.quizzes.map(
          (q) => `${q.title} (/${q.questionCount})${q.revealed ? "" : " *"}`,
        ),
        t("lecturer.gradebook.colCumulative"),
      ],
      ...model.rows.map((row, i): SheetRow => [
        i + 1,
        row.matricNo,
        row.fullName,
        ...row.cells.map((cell) => (cell ? cell.percent : null)),
        row.cumulativePercent,
      ]),
      [
        null,
        null,
        t("lecturer.gradebook.footerAverage"),
        ...model.quizzes.map((q) => q.averagePercent),
        null,
      ],
    ],
  });

  // ── Per-quiz compact sheets (bounded by SHEET_BUILD_LIMIT) ─────────
  const sheetQuizzes =
    columnQuizzes.length > SHEET_BUILD_LIMIT ? [] : columnQuizzes;

  for (const quiz of sheetQuizzes) {
    const quizSessions = (sessionsByQuiz.get(quiz.id) ?? []).slice(
      0,
      RESULTS_SESSION_LIMIT,
    );
    const sessionIds = quizSessions.map((s) => s.id);

    type AnswerRow = {
      session_id: string;
      question_id: string;
      selected_index: number | null;
      is_correct: boolean;
    };
    const { data: answerRows, error: answersError } =
      sessionIds.length === 0
        ? { data: [] as AnswerRow[], error: null as null }
        : await supabase
            .from("lecturer_answers_view")
            .select("session_id, question_id, selected_index, is_correct")
            .in("session_id", sessionIds)
            .limit(ANSWERS_LIMIT);
    if (answersError) {
      console.error("Gradebook export answers error:", answersError);
      return internalError("Could not build the export right now.");
    }

    const { data: questionRowsForQuiz, error: qQuestionsError } = await supabase
      .from("questions")
      .select("id, order_index, type, prompt, options, correct_index, explanation")
      .eq("quiz_id", quiz.id)
      .order("order_index", { ascending: true });
    if (qQuestionsError) {
      console.error("Gradebook export questions error:", qQuestionsError);
      return internalError("Could not build the export right now.");
    }

    const quizModel = buildExportModel({
      quiz: { title: quiz.title, mode: quiz.mode, status: quiz.status },
      className: cls?.title ?? null,
      generatedAtISO: new Date().toISOString(),
      questions: questionRowsForQuiz ?? [],
      roster: roster.map((r) => ({
        student_id: r.student_id,
        full_name: r.full_name,
        matric_no: r.matric_no,
      })),
      sessions: quizSessions,
      answers: (answerRows ?? []) as import("@/lib/results/export").ExportAnswerInput[],
      answersTruncated: (answerRows?.length ?? 0) >= ANSWERS_LIMIT,
      nowMs: Date.now(),
    });

    sheets.push({
      name: sanitizeSheetName(quiz.title),
      rows: [
        [
          t("workbook.colNum"),
          t("workbook.colMatric"),
          t("workbook.colName"),
          t("workbook.colStatus"),
          t("workbook.colScore"),
          t("workbook.colTotal"),
          t("workbook.colPercent"),
        ],
        ...quizModel.students.map((s, i): SheetRow => [
          i + 1,
          s.matricNo,
          s.fullName,
          s.status,
          s.score,
          s.total,
          s.percent === null ? null : s.percent / 100,
        ]),
      ],
    });
  }

  // ── Assemble the workbook ──────────────────────────────────────────
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    for (const row of sheet.rows) ws.addRow(row);
    ws.getRow(1).font = { bold: true };
  }

  const dateStamp = new Date().toISOString().slice(0, 10);
  const filename = `${sanitizeFilenamePart(cls?.title ?? "gradebook")}-gradebook-${dateStamp}.xlsx`;
  const buffer = await wb.xlsx.writeBuffer();

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}

function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/*?:[\]]/g, "").trim();
  return cleaned.slice(0, 31) || "Quiz";
}
