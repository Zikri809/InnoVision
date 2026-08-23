import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/classes/roster";
import {
  StudentPracticePlayer,
  type SafeQuestion,
} from "@/components/student-quiz/player-client";

type Params = { params: Promise<{ quizId: string }> };

export const metadata: Metadata = { title: "Practice — InnoVision" };

/**
 * /play/student/[quizId] — SHELL-LESS self-play (same focused chrome as
 * /play/[sessionId]). Creator-only: the server load filters on created_by and
 * RLS double-gates. Questions are stripped to the safe shape — the answer key
 * is re-derived per answer by the grading RPC, never shipped up front.
 */
export default async function SelfPlayPage({ params }: Params) {
  const supabase = await createClient();
  const { quizId } = await params;
  if (!isUuid(quizId)) redirect("/student/my-quizzes");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || profile.role !== "student") redirect("/lecturer/classes");

  const { data: quiz } = await supabase
    .from("student_quizzes")
    .select("id, title, created_by")
    .eq("id", quizId)
    .eq("created_by", user.id)
    .maybeSingle();

  if (!quiz) redirect("/student/my-quizzes");

  const { data: rows } = await supabase
    .from("student_quiz_questions")
    .select("id, order_index, type, prompt, options, created_at")
    .eq("quiz_id", quizId)
    .order("order_index")
    .order("created_at");

  // Strip everything except the safe player shape (defense-in-depth: even
  // though this page is creator-only, the player component must never receive
  // correct_index/explanation).
  const questions: SafeQuestion[] = (rows ?? []).map((q) => ({
    id: q.id,
    order_index: q.order_index,
    type: q.type,
    prompt: q.prompt,
    options: q.options,
  }));

  return (
    <div className="min-h-dvh bg-background">
      <StudentPracticePlayer
        quizKey={quiz.id}
        title={quiz.title}
        questions={questions}
        backHref="/student/my-quizzes"
        backLabelKey="backMine"
      />
    </div>
  );
}
