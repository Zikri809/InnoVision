import { redirect, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { QuizBuilderClient } from "./quiz-builder-client";
import { ProfilePendingPanel } from "@/components/layout/load-state";

export const dynamic = "force-dynamic";

/**
 * Lecturer quiz builder — the manual-builder deliverable of Phase 3.
 *
 * Access: lecturer who owns the quiz's CLASS (ownership is class ownership).
 * The server component performs the owner-filtered read (RLS + explicit
 * filter), so a non-owner lecturer or any student gets a 404 — never a leak
 * of another lecturer's quiz or a draft.
 */
export default async function QuizBuilderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tBuilder = await getTranslations("builder");
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

  // Owner-filtered quiz fetch: RLS restricts to the lecturer's own classes;
  // the explicit eq() on lecturer_id makes the not-found case unambiguous.
  const { data: quiz, error: quizError } = await supabase
    .from("quizzes")
    .select("id, class_id, title, mode, status, time_limit_sec, created_at, source_file_url, source_text")
    .eq("id", id)
    .maybeSingle();

  if (quizError) {
    console.error("Quiz fetch error:", quizError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          {tBuilder("quizLoadError")}
        </p>
      </div>
    );
  }
  if (!quiz) notFound();

  // Re-verify class ownership explicitly (defense in depth on top of RLS) and
  // fetch the class title in the SAME query, in parallel with the questions
  // fetch (both depend only on the quiz row we already have).
  const [
    { data: ownedClass, error: ownedClassError },
    { data: questions, error: questionsError },
  ] = await Promise.all([
    supabase
      .from("classes")
      .select("id, title")
      .eq("id", quiz.class_id)
      .eq("lecturer_id", user.id)
      .maybeSingle(),
    supabase
      .from("questions")
      .select("id, quiz_id, order_index, type, prompt, options, correct_index, explanation, image_path")
      .eq("quiz_id", id)
      .order("order_index", { ascending: true })
      .order("created_at", { ascending: true }),
  ]);
  // Distinguish a DB outage (503-style error panel) from genuinely-not-owned
  // (404). A transient error must not render as a not-found.
  if (ownedClassError) {
    console.error("Class ownership check error:", ownedClassError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          {tBuilder("quizLoadError")}
        </p>
      </div>
    );
  }
  if (!ownedClass) notFound();

  if (questionsError) {
    console.error("Questions fetch error:", questionsError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          {tBuilder("questionsLoadError")}
        </p>
      </div>
    );
  }

  return (
    <QuizBuilderClient
      quiz={{
        id: quiz.id,
        class_id: quiz.class_id,
        class_title: ownedClass.title,
        title: quiz.title,
        mode: quiz.mode,
        status: quiz.status,
        time_limit_sec: quiz.time_limit_sec,
        created_at: quiz.created_at,
        source_file_url: quiz.source_file_url,
        source_text: quiz.source_text,
      }}
      questions={questions ?? []}
      userId={user.id}
      ocrConfig={{
        defaultEngine: (process.env.OCR_DEFAULT_ENGINE as "tesseract" | "glm") ?? "tesseract",
      }}
    />
  );
}
