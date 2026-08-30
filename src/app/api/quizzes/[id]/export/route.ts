import { createClient } from "@/lib/supabase/server";
import { isUuid, getClassRoster } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import {
  checkSameOrigin,
  internalError,
  notFound,
  rateLimited,
} from "@/lib/http";
import { buildExportModel } from "@/lib/results/export";
import { buildWorkbook, type WorkbookLabels } from "@/lib/results/export-workbook";
import { RESULTS_SESSION_LIMIT } from "@/lib/results/constants";
import { sanitizeFilenamePart } from "@/lib/auth/matric";
import { tFor } from "@/lib/i18n/messages";
import type { SupportedLocale } from "@/lib/types/aliases";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// The most expensive read in the app (quiz + ≤200 sessions + roster + all
// answers + xlsx build) returning a PII payload — throttled like every route.
const EXPORT_RATE = { limit: 10, windowMs: 60 * 1000 };
// Hard bound on fetched answer rows (200 sessions × questions); keeps memory
// finite even for pathological quizzes.
const ANSWERS_LIMIT = 20_000;

/**
 * GET /api/quizzes/[id]/export — lecturer-only .xlsx download of quiz results
 * (PLAN_MATRIC_EXCEL_EXPORT §2).
 *
 * Authz: requireQuizOwner (session → lecturer → owner-joined RLS fetch) is
 * THE gate; a non-owner gets the uniform 404. All reads run on the user-scoped
 * client under RLS — `createAdminClient()` is forbidden in this route.
 */
function workbookLabels(locale: SupportedLocale): WorkbookLabels {
  const t = tFor(locale);
  return {
    sheetResults: t("workbook.sheetResults"),
    sheetKey: t("workbook.sheetKey"),
    sheetDist: t("workbook.sheetDist"),
    colNum: t("workbook.colNum"),
    colMatric: t("workbook.colMatric"),
    colName: t("workbook.colName"),
    colStatus: t("workbook.colStatus"),
    colScore: t("workbook.colScore"),
    colTotal: t("workbook.colTotal"),
    colPercent: t("workbook.colPercent"),
    colStarted: t("workbook.colStarted"),
    colSubmitted: t("workbook.colSubmitted"),
    colDuration: t("workbook.colDuration"),
    colFaceFails: t("workbook.colFaceFails"),
    colFocusPauses: t("workbook.colFocusPauses"),
    colType: t("workbook.colType"),
    colPrompt: t("workbook.colPrompt"),
    // Reuses the dashboard's student-name fallback label ("Student"/"Pelajar")
    // so blank-name rows read the same on screen and in the artifact.
    unknownStudent: t("lecturer.results.tableHeaderStudent"),
    colCorrect: t("workbook.colCorrect"),
    colExplanation: t("workbook.colExplanation"),
    colAnswered: t("workbook.colAnswered"),
    colTimesCorrect: t("workbook.colTimesCorrect"),
    colPercentCorrect: t("workbook.colPercentCorrect"),
    colOption: t("workbook.colOption"),
    colOptionText: t("workbook.colOptionText"),
    colIsCorrect: t("workbook.colIsCorrect"),
    colChosenCount: t("workbook.colChosenCount"),
    colChosenPercent: t("workbook.colChosenPercent"),
    statusCompleted: t("workbook.statusCompleted"),
    statusFlagged: t("workbook.statusFlagged"),
    statusAbandoned: t("workbook.statusAbandoned"),
    statusInProgress: t("workbook.statusInProgress"),
    statusNotStarted: t("workbook.statusNotStarted"),
    unanswered: t("workbook.unanswered"),
    generatedLine: t("workbook.generatedLine"),
    classLabel: t("workbook.classLabel"),
    modeLabel: t("workbook.modeLabel"),
    truncatedWarning: t("workbook.truncatedWarning"),
  };
}

export async function GET(_request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  if (!rateLimit(`export:${owner.userId}`, EXPORT_RATE)) {
    return rateLimited("Too many exports. Try again in a minute.");
  }

  const originError = checkSameOrigin(_request);
  if (originError) return originError;

  // Lecturer's locale drives workbook label language.
  const [{ data: profile }, { data: cls }] = await Promise.all([
    supabase.from("profiles").select("locale").eq("id", owner.userId).maybeSingle(),
    supabase.from("classes").select("title").eq("id", owner.quiz.class_id).maybeSingle(),
  ]);
  const locale: SupportedLocale = profile?.locale === "ms" ? "ms" : "en";

  const [
    { data: sessions, error: sessionsError },
    rosterResult,
    { data: questionRows, error: questionsError },
  ] = await Promise.all([
    supabase
      .from("lecturer_session_view")
      .select(
        "id, student_id, status, score, started_at, submitted_at, last_activity_at, face_fail_streak, focus_pause_count",
      )
      .eq("quiz_id", id)
      // Newest-first, matching the results dashboard's read so both artifacts
      // truncate the SAME subset beyond the 200-session cap; id DESC secondary
      // keeps the representative-session pick deterministic on equal timestamps.
      .order("started_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(RESULTS_SESSION_LIMIT),
    getClassRoster(supabase, owner.quiz.class_id),
    supabase
      .from("questions")
      .select("id, order_index, type, prompt, options, correct_index, correct_indices, explanation")
      .eq("quiz_id", id)
      .order("order_index", { ascending: true }),
  ]);

  if (sessionsError || questionsError || rosterResult.error) {
    if (sessionsError) console.error("Export sessions read error:", sessionsError);
    if (questionsError) console.error("Export questions read error:", questionsError);
    if (rosterResult.error) console.error("Export roster read error:", rosterResult.error);
    return internalError("Could not build the export right now.");
  }

  // View-generated types mark every column nullable; the underlying columns
  // are NOT NULL (same narrowing as the results RSC).
  const sessionRows = (sessions ?? []) as import("@/lib/results/export").ExportSessionInput[];
  const sessionIds = sessionRows.map((s) => s.id);

  type AnswerRow = {
    session_id: string;
    question_id: string;
    selected_index: number | null;
    selected_indices: number[] | null;
    is_correct: boolean;
  };
  const { data: answerRows, error: answersError } =
    sessionIds.length === 0
      ? { data: [] as AnswerRow[], error: null as null }
      : await supabase
          .from("lecturer_answers_view")
          .select("session_id, question_id, selected_index, selected_indices, is_correct")
          .in("session_id", sessionIds)
          .limit(ANSWERS_LIMIT);

  if (answersError) {
    console.error("Export answers read error:", answersError);
    return internalError("Could not build the export right now.");
  }
  // Hitting the hard cap means answer cells/distribution would silently
  // under-report — surface it via the workbook's truncation warning.
  const answersTruncated = (answerRows?.length ?? 0) >= ANSWERS_LIMIT;

  const model = buildExportModel({
    quiz: {
      title: owner.quiz.title,
      mode: owner.quiz.mode,
      status: owner.quiz.status,
    },
    className: cls?.title ?? null,
    generatedAtISO: new Date().toISOString(),
    questions: questionRows ?? [],
    roster: rosterResult.roster.map((r) => ({
      student_id: r.student_id,
      full_name: r.full_name,
      matric_no: r.matric_no,
    })),
    sessions: sessionRows,
    answers: (answerRows ?? []) as import("@/lib/results/export").ExportAnswerInput[],
    answersTruncated,
    nowMs: Date.now(),
  });

  let buffer: Buffer;
  try {
    buffer = await buildWorkbook(model, workbookLabels(locale));
  } catch (err) {
    console.error("Workbook assembly error:", err);
    return internalError("Could not build the export right now.");
  }

  const dateStamp = model.meta.generatedAtISO.slice(0, 10);
  const filename = `${sanitizeFilenamePart(owner.quiz.title)}-results-${dateStamp}.xlsx`;

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
