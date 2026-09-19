import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getClassRoster } from "@/lib/classes/roster";
import { buildGradebookModel, GRADEBOOK_QUIZ_LIMIT } from "@/lib/results/gradebook";
import { coerceScore } from "@/lib/results/derive";
import { ProfilePendingPanel, LoadErrorPanel } from "@/components/layout/load-state";
import { GradebookClient } from "./gradebook-client";

export const dynamic = "force-dynamic";

const QUESTION_COUNT_LIMIT = 5_000;
// audit-3 B-F7: session read cap (mirrors the export route's SESSIONS_LIMIT).
const SESSIONS_LIMIT = 20_000;

/**
 * RA-1 — cross-quiz class gradebook (RSC).
 *
 * Owner guard mirrors classes/[id]/page.tsx (direct owner-scoped select →
 * notFound(); role redirect first). Pure-read: no mutation surface.
 *
 * Column policy (pre-flight decision): PUBLISHED ASSESSMENT quizzes only,
 * chronological, capped at GRADEBOOK_QUIZ_LIMIT (model also flags truncation
 * against the same filtered list). Practice/draft quizzes are excluded.
 */
export default async function GradebookPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) {
    return <ProfilePendingPanel />;
  }
  if (profile.role !== "lecturer") redirect("/student/classes");

  const { data: cls, error: classError } = await supabase
    .from("classes")
    .select("id, title, archived_at")
    .eq("id", id)
    .eq("lecturer_id", user.id)
    .maybeSingle();
  if (classError) {
    console.error("Gradebook class fetch error:", classError);
    return <LoadErrorPanel />;
  }
  if (!cls) notFound();

  const [
    { roster, truncated: rosterTruncated, error: rosterError },
    { data: quizzes, error: quizzesError },
  ] = await Promise.all([
    getClassRoster(supabase, id),
    supabase
      .from("quizzes")
      .select("id, title, status, results_revealed_at, created_at")
      .eq("class_id", id)
      .in("status", ["live", "closed"])
      .eq("mode", "assessment")
      .order("created_at", { ascending: true })
      .limit(GRADEBOOK_QUIZ_LIMIT + 1),
  ]);

  if (rosterError || quizzesError) {
    console.error("Gradebook fetch error:", rosterError ?? quizzesError);
    return <LoadErrorPanel />;
  }

  const quizList = quizzes ?? [];
  const columnQuizzes = quizList.slice(0, GRADEBOOK_QUIZ_LIMIT);
  const quizIds = columnQuizzes.map((q) => q.id);

  // One bounded read for question counts (quiz_id only — no prompt leakage).
  // audit-1 P1-9: an EMPTY id set makes PostgREST's `.in()` a 400/503 — a
  // brand-new class (no published assessment quizzes yet) must degrade to an
  // empty matrix, not an error panel, so both bounded reads below are
  // skipped when there are no column quizzes.
  const { data: questionRows, error: questionsError } = quizIds.length
    ? await supabase
        // 0054 revoked the base table from `authenticated`; the
        // owner-predicated view is the only readable path.
        .from("lecturer_questions_view")
        .select("quiz_id")
        .in("quiz_id", quizIds)
        .limit(QUESTION_COUNT_LIMIT)
    : { data: [], error: null };
  if (questionsError) {
    console.error("Gradebook questions fetch error:", questionsError);
    return <LoadErrorPanel />;
  }
  const countByQuiz = new Map<string, number>();
  for (const row of questionRows ?? []) {
    if (!row.quiz_id) continue;
    countByQuiz.set(row.quiz_id, (countByQuiz.get(row.quiz_id) ?? 0) + 1);
  }

  // Sessions for all column quizzes in ONE read, ordered to satisfy
  // selectRepresentativeSessions' contract (started_at DESC, id DESC).
  // audit-3 B-F7: bounded read — `count: "exact"` gives the true matching
  // total so the page can tell the user when older attempts were dropped
  // (including when the deployed PostgREST `max_rows` clamps our limit).
  const { data: sessionRows, count: sessionCount, error: sessionsError } = quizIds.length
    ? await supabase
        .from("lecturer_session_view")
        .select(
          "id, quiz_id, student_id, status, score, started_at, submitted_at, last_activity_at, face_fail_streak, focus_pause_count, fullscreen_pause_count, hand_pause_count, face_fail_count, attempt, pending_count",
          { count: "exact" },
        )
        .in("quiz_id", quizIds)
        .order("started_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(SESSIONS_LIMIT)
    : { data: [], count: 0, error: null };
  if (sessionsError) {
    console.error("Gradebook sessions fetch error:", sessionsError);
    return <LoadErrorPanel />;
  }

  // Prefer the exact count; the `>= limit` form is only a fallback for a null
  // count (with a real count it false-positives at exactly the cap).
  const sessionsTruncated =
    typeof sessionCount === "number"
      ? sessionCount > (sessionRows?.length ?? 0)
      : (sessionRows?.length ?? 0) >= SESSIONS_LIMIT;

  const sessionsByQuiz = new Map<string, import("@/lib/results/export").ExportSessionInput[]>();
  for (const s of sessionRows ?? []) {
    // View-generated types mark columns nullable; the underlying columns are
    // NOT NULL (same narrowing as the per-quiz export route).
    if (!s.id || !s.quiz_id || !s.student_id || !s.status) continue;
    const list = sessionsByQuiz.get(s.quiz_id) ?? [];
    list.push({
      id: s.id,
      student_id: s.student_id,
      status: s.status,
      // NUMERIC over the wire → string; coerce at the boundary so the model's
      // sums and percentages always see a number.
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

  const model = buildGradebookModel({
    className: cls.title,
    roster,
    // Feed the FULL fetched list (≤ LIMIT+1) so the model derives the
    // over-cap flag itself (single source of truth).
    quizzes: quizList.map((q) => ({
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
    // audit-2 M-13 / audit-3 B-F5: pass the roster read's flag through.
    rosterTruncated,
  });

  return (
    <GradebookClient
      model={model}
      quizLimit={GRADEBOOK_QUIZ_LIMIT}
      sessionsTruncated={sessionsTruncated}
      classId={cls.id}
      archived={cls.archived_at !== null}
    />
  );
}
