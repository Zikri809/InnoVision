import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MyQuizzesClient } from "./my-quizzes-client";
import { ProfilePendingPanel, LoadErrorPanel } from "@/components/layout/load-state";

const QUIZ_LIST_LIMIT = 200;

/**
 * /student/my-quizzes — creator dashboard for student practice quizzes.
 * Server-loaded (creator-filtered reads via RLS); counts computed in memory
 * from ONE quiz_id scan (no N+1).
 */
export default async function MyQuizzesPage() {
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

  if (profile.role !== "student") redirect("/lecturer/classes");

  const [{ data: quizzes, error }, { data: qrows }] = await Promise.all([
    supabase
      .from("student_quizzes")
      .select("id, title, description, share_code, created_at, updated_at")
      .eq("created_by", user.id)
      .order("created_at", { ascending: false })
      .limit(QUIZ_LIST_LIMIT),
    // One scan of own question rows → per-quiz counts in memory.
    supabase.from("student_quiz_questions").select("quiz_id"),
  ]);

  if (error) {
    console.error("My quizzes fetch error:", error);
    return (
      <LoadErrorPanel />
    );
  }

  const counts = new Map<string, number>();
  for (const r of qrows ?? []) {
    counts.set(r.quiz_id, (counts.get(r.quiz_id) ?? 0) + 1);
  }

  return (
    <MyQuizzesClient
      quizzes={(quizzes ?? []).map((q) => ({
        ...q,
        question_count: counts.get(q.id) ?? 0,
      }))}
    />
  );
}
