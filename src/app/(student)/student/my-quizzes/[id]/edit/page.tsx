import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/classes/roster";
import { QuizEditorClient, type EditorQuestion } from "./editor-client";

type Params = { params: Promise<{ id: string }> };

/**
 * /student/my-quizzes/[id]/edit — the builder for one own practice quiz.
 * Creator-only (RLS + explicit filter); questions are loaded WITH answers
 * here but the client never needs them except to prefill the editor form —
 * this page is unreachable by players.
 */
export default async function EditStudentQuizPage({ params }: Params) {
  const supabase = await createClient();
  const { id } = await params;
  if (!isUuid(id)) redirect("/student/my-quizzes");

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
    .select("id, title, description, created_by")
    .eq("id", id)
    .eq("created_by", user.id)
    .maybeSingle();

  if (!quiz) redirect("/student/my-quizzes");

  const { data: questions } = await supabase
    .from("student_quiz_questions")
    .select(
      "id, quiz_id, order_index, type, prompt, options, correct_index, explanation, image_path",
    )
    .eq("quiz_id", id)
    .order("order_index")
    .order("created_at");

  return (
    <QuizEditorClient
      quiz={{ id: quiz.id, title: quiz.title, description: quiz.description }}
      initialQuestions={(questions ?? []) as unknown as EditorQuestion[]}
      userId={user.id}
      ocrConfig={{
        defaultEngine: (process.env.OCR_DEFAULT_ENGINE as "tesseract" | "glm") ?? "tesseract",
      }}
    />
  );
}
