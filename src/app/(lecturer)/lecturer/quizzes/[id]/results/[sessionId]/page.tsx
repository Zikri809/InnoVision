import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getClassRoster } from "@/lib/classes/roster";
import { coerceScore, deriveSessionDisplayStatus } from "@/lib/results/derive";
import type { SessionStatus } from "@/lib/types/aliases";
import { SessionDetailClient, type AnswerRow, type QuestionRow } from "./session-detail-client";
import { ProfilePendingPanel, LoadErrorPanel } from "@/components/layout/load-state";

type SessionInfo = {
  id: string;
  quiz_id: string;
  student_id: string;
  /** Assessment vs practice — the override dialog's copy differs slightly. */
  mode: string;
  status: SessionStatus;
  /** coerceScore'd NUMERIC (PostgREST returns NUMERIC as a string). */
  score: number | null;
  started_at: string | null;
  submitted_at: string | null;
  last_activity_at: string | null;
  face_unavailable_at: string | null;
  face_exempt: boolean;
  face_fail_streak: number;
};

export const dynamic = "force-dynamic";

/**
 * Lecturer per-session answer breakdown — the dispute-resolution surface.
 *
 * Questions and answers are read through the owner-predicated barrier views
 * (0054 revoked the key columns from `authenticated`). M2 migration: the
 * question projection now carries `answer_key`/`explanation`/`image_path`/
 * `max_score` so short_text rows can show their rubric and the override
 * dialog can enforce the per-question ceiling; the answer projection carries
 * the full marking state (`answer_text`, `skipped`, `mark_status`,
 * `mark_score`, `mark_metadata`, `marked_at`, `attempt_version`) so pending /
 * needs_review / failed rows are visible and adjudicable from the UI.
 *
 * `mark_metadata` is lecturer-only by construction: the view's predicate is
 * `is_lecturer_of_quiz` (0060), the same gate that lets the override RPC
 * write. The AI rationale is rendered as PLAIN TEXT in the client.
 */
export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string; sessionId: string }>;
}) {
  const { id, sessionId } = await params;
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
    return (
      <ProfilePendingPanel />
    );
  }
  if (profile.role !== "lecturer") redirect("/student/classes");

  // Owner-filtered quiz fetch (no oracle: not-found folds 404).
  const { data: quiz, error: quizError } = await supabase
    .from("quizzes")
    .select("id, class_id, title, mode, status, time_limit_sec, results_revealed_at")
    .eq("id", id)
    .maybeSingle();
  if (quizError) {
    console.error("Quiz fetch error:", quizError);
    return (
      <LoadErrorPanel />
    );
  }
  if (!quiz) notFound();

  const { data: ownedClass } = await supabase
    .from("classes")
    .select("id")
    .eq("id", quiz.class_id)
    .eq("lecturer_id", user.id)
    .maybeSingle();
  if (!ownedClass) notFound();

  // Session must belong to THIS quiz (URL can't swap in a foreign session id).
  const { data: session, error: sessionError } = await supabase
    .from("lecturer_session_view")
    .select("id, quiz_id, student_id, mode, status, score, started_at, submitted_at, last_activity_at, face_unavailable_at, face_exempt, face_fail_streak")
    .eq("id", sessionId)
    .eq("quiz_id", id)
    .maybeSingle();
  if (sessionError) {
    console.error("Session fetch error:", sessionError);
    return (
      <LoadErrorPanel />
    );
  }
  if (!session) notFound();
  // D8: NUMERIC crosses PostgREST as a string — coerce at the boundary so the
  // client's ring arithmetic and `!= null` score check read a number or null.
  const sessionInfo = {
    ...(session as unknown as SessionInfo),
    score: coerceScore(session.score),
  };

  const [{ data: questions, error: questionsError }, rosterResult] = await Promise.all([
    // 0054 revoked the key columns from `authenticated`; the owner-predicated
    // view is the only readable path. The projection now carries the rubric /
    // explanation / image / max_score the migrated breakdown needs (M2).
    supabase
      .from("lecturer_questions_view")
      .select("id, type, prompt, options, order_index, answer_key, explanation, image_path, max_score")
      .eq("quiz_id", id)
      .order("order_index", { ascending: true }),
    getClassRoster(supabase, quiz.class_id),
  ]);

  if (questionsError) {
    console.error("Questions fetch error:", questionsError);
    return (
      <LoadErrorPanel />
    );
  }
  if (rosterResult.error) {
    console.error("Roster fetch error:", rosterResult.error);
    return (
      <LoadErrorPanel />
    );
  }

  const { data: answers, error: answersError } = await supabase
    .from("lecturer_answers_view")
    .select("question_id, selected_index, selected_indices, is_correct, answered_at, answer_text, skipped, mark_status, mark_score, mark_metadata, marked_at, attempt_version")
    .eq("session_id", sessionId);
  if (answersError) {
    console.error("Session answers fetch error:", answersError);
    return (
      <LoadErrorPanel />
    );
  }

  const answerRows = (answers ?? []) as unknown as AnswerRow[];

  // Same D5 abandonment derivation as the results dashboard — otherwise an
  // in-progress (score=null) session that went stale (>2h, quiz closed, or
  // flagged) is mislabeled "In progress" on this page forever.
  // eslint-disable-next-line react-hooks/purity -- server render: fresh clock per request
  const nowMs = Date.now();
  const displayStatus = deriveSessionDisplayStatus(
    { status: sessionInfo.status, last_activity_at: sessionInfo.last_activity_at },
    { quizStatus: quiz.status, nowMs },
  );

  return (
    <SessionDetailClient
      quizId={id}
      quizTitle={quiz.title}
      session={sessionInfo}
      displayStatus={displayStatus}
      // View-generated types mark every column nullable; the underlying
      // columns are NOT NULL (same narrowing as the results RSC).
      questions={(questions ?? []) as unknown as QuestionRow[]}
      answers={answerRows}
      resultsRevealed={quiz.results_revealed_at != null}
      studentName={
        rosterResult.roster.find((r) => r.student_id === sessionInfo.student_id)?.full_name ??
        null
      }
    />
  );
}
