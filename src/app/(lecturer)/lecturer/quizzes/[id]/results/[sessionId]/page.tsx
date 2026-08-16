import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getClassRoster } from "@/lib/classes/roster";
import { SessionDetailClient } from "./session-detail-client";

type SessionInfo = {
  id: string;
  quiz_id: string;
  student_id: string;
  mode: string;
  status: string;
  score: number | null;
  started_at: string | null;
  submitted_at: string | null;
  face_unavailable_at: string | null;
  face_exempt: boolean;
  face_fail_streak: number;
};

type AnswerRow = {
  question_id: string;
  selected_index: number | null;
  is_correct: boolean;
  answered_at: string | null;
};

export const dynamic = "force-dynamic";

/**
 * Lecturer per-session answer breakdown — each question a student answered,
 * with the option they picked and correct/wrong. NOT the correct answer
 * (D10): questions are projected WITHOUT correct_index/explanation.
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
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground" role="alert">
          Your profile is still being set up. Please refresh in a moment.
        </p>
      </div>
    );
  }
  if (profile.role !== "lecturer") redirect("/student/classes");

  // Owner-filtered quiz fetch (no oracle: not-found folds 404).
  const { data: quiz, error: quizError } = await supabase
    .from("quizzes")
    .select("id, class_id, title, mode, status, time_limit_sec")
    .eq("id", id)
    .maybeSingle();
  if (quizError) {
    console.error("Quiz fetch error:", quizError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load the results right now. Please refresh.
        </p>
      </div>
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
    .select("id, quiz_id, student_id, mode, status, score, started_at, submitted_at, face_unavailable_at, face_exempt, face_fail_streak")
    .eq("id", sessionId)
    .eq("quiz_id", id)
    .maybeSingle();
  if (sessionError) {
    console.error("Session fetch error:", sessionError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load the results right now. Please refresh.
        </p>
      </div>
    );
  }
  if (!session) notFound();
  const sessionInfo = session as unknown as SessionInfo;

  const [{ data: questions, error: questionsError }, rosterResult] = await Promise.all([
    supabase
      .from("questions")
      // Per-question breakdown columns — never correct_index (D10).
      .select("id, type, prompt, options, order_index")
      .eq("quiz_id", id)
      .order("order_index", { ascending: true }),
    getClassRoster(supabase, quiz.class_id),
  ]);

  if (questionsError) {
    console.error("Questions fetch error:", questionsError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load the results right now. Please refresh.
        </p>
      </div>
    );
  }
  if (rosterResult.error) {
    console.error("Roster fetch error:", rosterResult.error);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load the results right now. Please refresh.
        </p>
      </div>
    );
  }

  const { data: answers, error: answersError } = await supabase
    .from("lecturer_answers_view")
    .select("question_id, selected_index, is_correct, answered_at")
    .eq("session_id", sessionId);
  if (answersError) {
    console.error("Session answers fetch error:", answersError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load the results right now. Please refresh.
        </p>
      </div>
    );
  }

  const answerRows = (answers ?? []) as unknown as AnswerRow[];

  return (
    <SessionDetailClient
      quizId={id}
      quizTitle={quiz.title}
      session={sessionInfo}
      questions={questions ?? []}
      answers={answerRows}
      studentName={
        rosterResult.roster.find((r) => r.student_id === sessionInfo.student_id)?.full_name ??
        null
      }
    />
  );
}