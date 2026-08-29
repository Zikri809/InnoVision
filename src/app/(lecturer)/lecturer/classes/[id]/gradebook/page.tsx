import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getClassRoster } from "@/lib/classes/roster";
import { buildGradebookModel, GRADEBOOK_QUIZ_LIMIT } from "@/lib/results/gradebook";
import { ProfilePendingPanel, LoadErrorPanel } from "@/components/layout/load-state";
import { GradebookClient } from "./gradebook-client";

export const dynamic = "force-dynamic";

const QUESTION_COUNT_LIMIT = 5_000;

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

  const [{ roster, error: rosterError }, { data: quizzes, error: quizzesError }] =
    await Promise.all([
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
  // Over-cap flag from the same filtered source list (not raw class quizzes).
  const truncated = quizList.length > GRADEBOOK_QUIZ_LIMIT;
  const columnQuizzes = quizList.slice(0, GRADEBOOK_QUIZ_LIMIT);

  // One bounded read for question counts (quiz_id only — no prompt leakage).
  const { data: questionRows, error: questionsError } = await supabase
    .from("questions")
    .select("quiz_id")
    .in(
      "quiz_id",
      columnQuizzes.map((q) => q.id),
    )
    .limit(QUESTION_COUNT_LIMIT);
  if (questionsError) {
    console.error("Gradebook questions fetch error:", questionsError);
    return <LoadErrorPanel />;
  }
  const countByQuiz = new Map<string, number>();
  for (const row of questionRows ?? []) {
    countByQuiz.set(row.quiz_id, (countByQuiz.get(row.quiz_id) ?? 0) + 1);
  }

  // Sessions for all column quizzes in ONE read, ordered to satisfy
  // selectRepresentativeSessions' contract (started_at DESC, id DESC).
  const { data: sessionRows, error: sessionsError } = await supabase
    .from("lecturer_session_view")
    .select(
      "id, quiz_id, student_id, status, score, started_at, submitted_at, last_activity_at, face_fail_streak, focus_pause_count, attempt",
    )
    .in(
      "quiz_id",
      columnQuizzes.map((q) => q.id),
    )
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(20_000);
  if (sessionsError) {
    console.error("Gradebook sessions fetch error:", sessionsError);
    return <LoadErrorPanel />;
  }

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

  const model = buildGradebookModel({
    className: cls.title,
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

  return (
    <GradebookClient
      model={model}
      truncated={truncated}
      quizLimit={GRADEBOOK_QUIZ_LIMIT}
      classId={cls.id}
      archived={cls.archived_at !== null}
    />
  );
}
