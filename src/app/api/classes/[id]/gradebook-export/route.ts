import { createClient } from "@/lib/supabase/server";
import { isUuid, getClassRoster, ROSTER_LIMIT } from "@/lib/classes/roster";
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
  safeText,
  type ExportSessionInput,
} from "@/lib/results/export";
import { coerceScore } from "@/lib/results/derive";
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
// becomes summary-only — bounded request. audit-3 B-F4: the downgrade is no
// longer silent — the Summary sheet carries a visible note row and the
// response carries `X-Gradebook-Sheet-Detail-Omitted`.
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
 *
 * Honesty signals (audit-3 B-F3/B-F4/B-F7/INJ-F1):
 *  - EVERY string cell passes `safeText()` (export.ts invariant), matching the
 *    per-quiz workbook — names/matric numbers/quiz titles included.
 *  - All percent cells are written as 0-1 fractions with a `0%` numFmt
 *    (the per-quiz export convention) so grades are readable in Excel.
 *  - Truncation is surfaced both as Summary note rows and as response headers:
 *    `X-Gradebook-Columns-Truncated`, `X-Gradebook-Roster-Truncated`,
 *    `X-Gradebook-Sessions-Truncated`, `X-Gradebook-Sheet-Detail-Omitted`.
 *  - Workbook assembly is wrapped: any ExcelJS throw (e.g. an illegal sheet
 *    name) becomes the typed 503 the per-quiz twin returns, never a raw 500.
 */
export async function GET(_request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  const owner = await requireClassOwner(supabase, id);
  if (!owner.ok) return owner.response;

  // audit-2 M-22: origin check ABOVE the limiter — a rejected cross-origin
  // probe must not burn export budget (reveal-route precedent).
  const originError = checkSameOrigin(_request);
  if (originError) return originError;

  if (!rateLimit(`gradebook-export:${owner.userId}`, EXPORT_RATE)) {
    return rateLimited("Too many exports. Try again in a minute.");
  }

  const [{ data: profile }, { data: cls }] = await Promise.all([
    supabase.from("profiles").select("locale").eq("id", owner.userId).maybeSingle(),
    supabase.from("classes").select("title").eq("id", id).maybeSingle(),
  ]);
  const locale: SupportedLocale = profile?.locale === "ms" ? "ms" : "en";
  const t = tFor(locale);

  const [
    { roster, truncated: rosterTruncated, error: rosterError },
    { data: quizzes, error: quizzesError },
  ] = await Promise.all([
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

  // audit-1 P1-9: an EMPTY id set makes PostgREST's `.in()` a 400/503 — a
  // brand-new class must export an (empty) workbook, not a 500. Skip both
  // bounded reads when there are no column quizzes.
  // audit-3 B-F7: the session read is bounded. `count: "exact"` returns the
  // TRUE matching total in PostgREST's Content-Range, so `sessionsTruncated`
  // reflects what was actually dropped even when the deployed PostgREST
  // `max_rows` (supabase/config.toml:8 = 1000 locally) silently clamps our
  // `.limit(SESSIONS_LIMIT)` below the requested cap. The `>= limit` term is
  // the belt-and-braces fallback for a null count.
  const [{ data: sessionRows, count: sessionCount, error: sessionsError }, { data: questionCountRows, error: questionCountError }] =
    quizIds.length === 0
      ? [{ data: [], count: 0, error: null }, { data: [], error: null }]
      : await Promise.all([
          supabase
            .from("lecturer_session_view")
            .select(
              "id, quiz_id, student_id, status, score, started_at, submitted_at, last_activity_at, face_fail_streak, focus_pause_count, fullscreen_pause_count, hand_pause_count, face_fail_count, attempt, pending_count",
              { count: "exact" },
            )
            .in("quiz_id", quizIds)
            .order("started_at", { ascending: false })
            .order("id", { ascending: false })
            .limit(SESSIONS_LIMIT),
          supabase
            // 0054 revoked the base table from `authenticated`; the
            // owner-predicated view is the only readable path.
            .from("lecturer_questions_view")
            .select("quiz_id")
            .in("quiz_id", quizIds)
            .limit(QUESTION_COUNT_LIMIT),
        ]);

  if (sessionsError || questionCountError) {
    console.error("Gradebook export read error:", sessionsError ?? questionCountError);
    return internalError("Could not build the export right now.");
  }

  // The `>= limit` term is a fallback ONLY when no count is available: with a
  // real count it produces a false positive at exactly the cap (nothing was
  // dropped, yet it reports truncation). Prefer the count whenever we have one
  // (adversarial review).
  const sessionsTruncated =
    typeof sessionCount === "number"
      ? sessionCount > (sessionRows?.length ?? 0)
      : (sessionRows?.length ?? 0) >= SESSIONS_LIMIT;

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
      // NUMERIC over the wire → string; coerce at the boundary so every
      // downstream sum/percent sees a number.
      score: coerceScore(s.score),
      started_at: s.started_at,
      submitted_at: s.submitted_at,
      last_activity_at: s.last_activity_at,
      face_fail_streak: s.face_fail_streak,
      focus_pause_count: s.focus_pause_count,
      fullscreen_pause_count: s.fullscreen_pause_count,
      hand_pause_count: s.hand_pause_count,
      face_fail_count: s.face_fail_count,
      attempt: s.attempt,
      pending_count: s.pending_count,
    });
    sessionsByQuiz.set(s.quiz_id, list);
  }

  const countByQuiz = new Map<string, number>();
  for (const row of questionCountRows ?? []) {
    if (!row.quiz_id) continue;
    countByQuiz.set(row.quiz_id, (countByQuiz.get(row.quiz_id) ?? 0) + 1);
  }

  const model = buildGradebookModel({
    className: cls?.title ?? null,
    roster,
    // Feed the FULL fetched list (≤ LIMIT+1): the model caps its own columns
    // and derives `model.truncated`, so the flag has a single source of truth.
    quizzes: (quizzes ?? []).map((q) => ({
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
    // audit-2 M-13 / audit-3 B-F5: pass the roster read's own flag through —
    // the array is already capped, so length alone cannot detect truncation.
    rosterTruncated,
  });
  // audit-3 B-F4: the model's own truncation flag (published quizzes exceeded
  // GRADEBOOK_QUIZ_LIMIT) — surfaced below as a note row + response header.
  const truncated = model.truncated;

  type SheetRow = (string | number | null)[];
  const sheets: { name: string; rows: SheetRow[] }[] = [];

  // audit-3 B-F4: >SHEET_BUILD_LIMIT quizzes still mirror the FULL matrix in
  // the Summary, but per-quiz detail is dropped. That used to be silent; the
  // Summary now carries visible note rows and the response carries headers.
  const sheetDetailOmitted = columnQuizzes.length > SHEET_BUILD_LIMIT;

  // ── Summary sheet: mirror of the on-screen matrix ──────────────────
  // audit-3 B-F3: EVERY string cell passes safeText() (export.ts invariant).
  const summaryRows: SheetRow[] = [
    [
      t("workbook.colNum"),
      t("workbook.colMatric"),
      t("workbook.colName"),
      ...model.quizzes.map((q) =>
        safeText(`${q.title} (/${q.questionCount})${q.revealed ? "" : " *"}`),
      ),
      t("lecturer.gradebook.colCumulative"),
      t("workbook.colFaceFails"),
      t("workbook.colFullscreenPauses"),
      t("workbook.colHandPauses"),
    ],
  ];
  model.rows.forEach((row, i) => {
    summaryRows.push([
      i + 1,
      row.matricNo === null ? null : safeText(row.matricNo),
      row.fullName === null ? null : safeText(row.fullName),
      // audit-4 round-3 (M10 residual): a cell with unresolved AI marks is
      // PROVISIONAL — the on-screen gradebook renders the neutral pending
      // chip, so the summary sheet writes the same label, never the partial
      // number.
      ...row.cells.map((cell) =>
        cell === null || cell.pendingCount > 0
          ? cell === null
            ? null
            : t("play.shortText.pending")
          : cell.percent === null
            ? null
            : cell.percent / 100,
      ),
      row.hasPending
        ? t("play.shortText.pending")
        : row.cumulativePercent === null
          ? null
          : row.cumulativePercent / 100,
      row.faceFails,
      row.fullscreenPauses,
      row.handPauses,
    ]);
  });
  summaryRows.push([
    null,
    null,
    t("lecturer.gradebook.footerAverage"),
    ...model.quizzes.map((q) =>
      q.averagePercent === null ? null : q.averagePercent / 100,
    ),
    null,
    null,
    null,
    null,
  ]);
  // ── Visible honesty notes (audit-3 B-F4) ──────────────────────────
  // tFor has no ICU interpolation — substitute placeholders explicitly.
  if (sheetDetailOmitted) {
    summaryRows.push([
      t("workbook.sheetDetailOmitted")
        .replace("{count}", String(columnQuizzes.length))
        .replace("{limit}", String(SHEET_BUILD_LIMIT)),
    ]);
  }
  if (truncated) {
    summaryRows.push([
      t("workbook.columnsTruncated").replace("{limit}", String(GRADEBOOK_QUIZ_LIMIT)),
    ]);
  }
  if (rosterTruncated) {
    summaryRows.push([
      t("workbook.rosterTruncated").replace("{limit}", String(ROSTER_LIMIT)),
    ]);
  }
  if (sessionsTruncated) {
    summaryRows.push([
      t("workbook.sessionsTruncated").replace("{limit}", String(SESSIONS_LIMIT)),
    ]);
  }
  sheets.push({ name: "Summary", rows: summaryRows });

  // ── Per-quiz compact sheets (bounded by SHEET_BUILD_LIMIT) ─────────
  const sheetQuizzes = sheetDetailOmitted ? [] : columnQuizzes;
  // audit-3 B-F7: any per-quiz answer read hitting its row cap means the
  // per-quiz sheets under-report — surfaced below alongside the other flags.
  let answersTruncatedAny = false;

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
      selected_indices: number[] | null;
      is_correct: boolean;
      answer_text: string | null;
      skipped: boolean;
      mark_status: string;
    };
    const { data: answerRows, error: answersError } =
      sessionIds.length === 0
        ? { data: [] as AnswerRow[], error: null as null }
        : await supabase
            .from("lecturer_answers_view")
            .select(
              "session_id, question_id, selected_index, selected_indices, is_correct, answer_text, skipped, mark_status",
            )
            .in("session_id", sessionIds)
            .limit(ANSWERS_LIMIT);
    if (answersError) {
      console.error("Gradebook export answers error:", answersError);
      return internalError("Could not build the export right now.");
    }

    const { data: questionRowsForQuiz, error: qQuestionsError } = await supabase
      .from("lecturer_questions_view")
      .select("id, order_index, type, prompt, options, correct_index, correct_indices, explanation")
      .eq("quiz_id", quiz.id)
      .order("order_index", { ascending: true });
    if (qQuestionsError) {
      console.error("Gradebook export questions error:", qQuestionsError);
      return internalError("Could not build the export right now.");
    }

    const answersTruncated = (answerRows?.length ?? 0) >= ANSWERS_LIMIT;
    if (answersTruncated) answersTruncatedAny = true;

    const quizModel = buildExportModel({
      quiz: { title: quiz.title, mode: quiz.mode, status: quiz.status },
      className: cls?.title ?? null,
      generatedAtISO: new Date().toISOString(),
      // View-generated types mark every column nullable; the underlying
      // columns are NOT NULL (same narrowing as the sessions feed above).
      questions: (questionRowsForQuiz ?? []) as unknown as Parameters<typeof buildExportModel>[0]["questions"],
      roster: roster.map((r) => ({
        student_id: r.student_id,
        full_name: r.full_name,
        matric_no: r.matric_no,
      })),
      sessions: quizSessions,
      answers: (answerRows ?? []) as import("@/lib/results/export").ExportAnswerInput[],
      answersTruncated,
      // Absolute key form: this route's `t` is not namespaced (X2-9).
      pendingLabel: t("play.shortText.pending"),
      skippedLabel: t("play.skip.skipped"),
      nowMs: Date.now(),
    });

    sheets.push({
      // Raw title here — the assembly loop sanitizes + dedupes centrally.
      name: quiz.title,
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
          // audit-4 round-3: unresolved AI marks make the percent provisional;
          // write the neutral pending label (never the partial number).
          s.pendingCount > 0
            ? t("play.shortText.pending")
            : s.percent === null
              ? null
              : s.percent / 100,
        ]),
      ],
    });
  }

  if (answersTruncatedAny) {
    summaryRows.push([t("workbook.answersTruncated")]);
  }

  // ── Assemble the workbook ──────────────────────────────────────────
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  // audit-1 P1-7: ExcelJS THROWS on a duplicate sheet name (case-insensitive)
  // and "Summary" is reserved by the sheet above — two quizzes titled
  // "midterm"/"MIDTERM" (or a quiz literally named "Summary") used to 500 the
  // whole export. Sanitized names are deduped within Excel's 31-char budget
  // (" (2)", " (3)"…), matching the per-quiz route's try/catch posture.
  //
  // INJ-F1: ExcelJS ALSO throws when the first OR last character of a sheet
  // name is an apostrophe — sanitizeSheetName strips those now. The whole
  // assembly is wrapped anyway so any future ExcelJS throw becomes the typed
  // 503 the per-quiz twin returns, never a raw 500.
  // The ENTIRE assembly runs inside the try. addWorksheet() itself throws for
  // a name that survives sanitizing but is still illegal to ExcelJS, so
  // wrapping only writeBuffer() left a raw 500 for those inputs (adversarial
  // review, High). The per-quiz twin wraps its whole buildWorkbook call.
  const dateStamp = new Date().toISOString().slice(0, 10);
  const filename = `${sanitizeFilenamePart(cls?.title ?? "gradebook")}-gradebook-${dateStamp}.xlsx`;
  let buffer: Awaited<ReturnType<typeof wb.xlsx.writeBuffer>>;
  try {
    const usedSheetNames = new Set<string>();
    for (const [idx, sheet] of sheets.entries()) {
      if (idx === 0) {
        // The reserved Summary mirror keeps its name AND blocks quiz sheets
        // from claiming it (or any case variant) below. ExcelJS ALSO refuses
        // Excel's protected names (worksheet.js), so a quiz literally titled
        // "History" threw inside addWorksheet (adversarial review) — reserve
        // those too.
        usedSheetNames.add(sheet.name.toLowerCase());
        for (const protectedName of EXCEL_PROTECTED_SHEET_NAMES) {
          usedSheetNames.add(protectedName);
        }
      } else {
        sheet.name = sanitizeSheetName(sheet.name, usedSheetNames);
      }
      const ws = wb.addWorksheet(sheet.name);
      for (const row of sheet.rows) ws.addRow(row);
      ws.getRow(1).font = { bold: true };
      if (idx > 0) {
        // Per-quiz compact sheet: column 7 is Percent. Cells hold 0-1
        // fractions — apply the same `0%` numFmt the per-quiz export uses
        // (export-workbook.ts) so grades are readable, not 0.85 decimals.
        for (let r = 2; r <= ws.rowCount; r++) {
          ws.getRow(r).getCell(7).numFmt = "0%";
        }
      } else {
        // Summary: quiz percent columns start at column 4 and the cumulative %
        // is the last of them; apply `0%` to every percent cell uniformly.
        const firstPercentCol = 4;
        const lastPercentCol = 4 + model.quizzes.length; // inclusive cumulative col
        for (let r = 2; r <= ws.rowCount; r++) {
          const row = ws.getRow(r);
          for (let c = firstPercentCol; c <= lastPercentCol; c++) {
            row.getCell(c).numFmt = "0%";
          }
        }
      }
    }
    buffer = await wb.xlsx.writeBuffer();
  } catch (err) {
    console.error("Gradebook workbook assembly error:", err);
    return internalError("Could not build the export right now.");
  }

  const headers: Record<string, string> = {
    "Content-Type":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "no-store",
    // audit-3 B-F4/B-F7: machine-readable honesty signals, mirrored by the
    // Summary note rows above. Always present ("1"/"0") so a consumer can
    // distinguish "not truncated" from "flag not emitted by an older build".
    "X-Gradebook-Columns-Truncated": truncated ? "1" : "0",
    "X-Gradebook-Roster-Truncated": rosterTruncated ? "1" : "0",
    "X-Gradebook-Sessions-Truncated": sessionsTruncated ? "1" : "0",
    "X-Gradebook-Answers-Truncated": answersTruncatedAny ? "1" : "0",
    "X-Gradebook-Sheet-Detail-Omitted": sheetDetailOmitted ? "1" : "0",
  };

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers,
  });
}

/**
 * Excel worksheet names: max 31 chars, no `\ / * ? : [ ]`, and ExcelJS throws
 * if the first or last character is a single quotation mark (INJ-F1). The
 * `slice(0, 31)` can itself CREATE a trailing apostrophe, so trimming happens
 * after the slice. Collisions are deduped with " (2)", " (3)"… within the
 * 31-char budget; an empty result falls back to "Quiz".
 */
/**
 * Sheet names ExcelJS refuses to create because Excel reserves them
 * (node_modules/exceljs/lib/doc/worksheet.js). Lower-cased for the
 * case-insensitive dedupe set.
 */
const EXCEL_PROTECTED_SHEET_NAMES = ["history"];

function sanitizeSheetName(name: string, used: Set<string>): string {
  const cleaned = name
    // Backslash belongs in the strip class: ExcelJS rejects it (worksheet.js)
    // even though Excel's own UI tolerates it, so a title like "A\B" threw
    // inside addWorksheet and 500'd the whole export (adversarial review).
    .replace(/[\\/*?:[\]]/g, "")
    .trim()
    .slice(0, 31)
    .replace(/^'+|'+$/g, "")
    .trim();
  const base = cleaned.slice(0, 31) || "Quiz";
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${n})`;
    // Re-strip after the slice: a title ending in an apostrophe at the cut
    // boundary must not reintroduce the terminal-quote throw.
    candidate = (base.slice(0, 31 - suffix.length) + suffix)
      .replace(/^'+|'+$/g, "")
      .trim() || `Quiz${suffix}`;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}
