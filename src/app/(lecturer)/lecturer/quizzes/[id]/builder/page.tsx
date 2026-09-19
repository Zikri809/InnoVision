import { redirect, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { isWebSearchEnabled } from "@/lib/ai/tinyfish";
import { parseQuizSources } from "@/lib/quizzes/sources";
import { QuizBuilderClient, type QuestionRow } from "./quiz-builder-client";
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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
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
    .select("id, class_id, title, mode, status, time_limit_sec, opens_at, closes_at, allow_retake, max_attempts, shuffle_questions, gestures_enabled, results_revealed_at, created_at, source_file_url, source_text, sources")
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
  // fetch (both depend only on the quiz row we already have). The session
  // count query feeds QC-2's close-dialog warning (completed-but-unrevealed).
  const [
    { data: ownedClass, error: ownedClassError },
    { data: questions, error: questionsError },
    { count: completedUnrevealed, error: completedUnrevealedError },
    { data: ownedClasses, error: ownedClassesError },
  ] = await Promise.all([
    supabase
      .from("classes")
      .select("id, title")
      .eq("id", quiz.class_id)
      .eq("lecturer_id", user.id)
      .maybeSingle(),
    // 0054 revoked the key columns from `authenticated`, so every lecturer
    // read of questions goes through the owner-predicated view.
    supabase
      .from("lecturer_questions_view")
      .select("id, quiz_id, order_index, type, prompt, options, correct_index, correct_indices, answer_key, explanation, image_path")
      .eq("quiz_id", id)
      .order("order_index", { ascending: true })
      .order("created_at", { ascending: true }),
    // Only meaningful for an unrevealed assessment; the count is cheap either
    // way (exact count, head:true — no row transfer).
    supabase
      .from("quiz_sessions")
      .select("id", { count: "exact", head: true })
      .eq("quiz_id", id)
      .eq("mode", "assessment")
      .eq("status", "completed"),
    // AP-2: duplicate-destination options — every class this lecturer owns.
    supabase
      .from("classes")
      .select("id, title")
      .eq("lecturer_id", user.id)
      .is("archived_at", null)
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
  if (completedUnrevealedError) {
    console.error("Completed-session count error:", completedUnrevealedError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          {tBuilder("quizLoadError")}
        </p>
      </div>
    );
  }
  // Non-critical: the duplicate dialog degrades to the source's class only.
  if (ownedClassesError) {
    console.error("Owned-classes fetch error:", ownedClassesError);
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
        opens_at: quiz.opens_at,
        closes_at: quiz.closes_at,
        allow_retake: quiz.allow_retake,
        max_attempts: quiz.max_attempts,
        shuffle_questions: quiz.shuffle_questions,
        gestures_enabled: quiz.gestures_enabled,
        created_at: quiz.created_at,
        source_file_url: quiz.source_file_url,
        source_text: quiz.source_text,
      }}
      sources={parseQuizSources(quiz.sources)}
      hasWebSearch={isWebSearchEnabled()}
      // View-generated types mark every column nullable; the underlying
      // columns are NOT NULL (same narrowing as the results RSC).
      questions={(questions ?? []) as unknown as QuestionRow[]}
      userId={user.id}
      classes={ownedClasses ?? []}
      // Origin-aware back link: entered from the cross-class quizzes hub goes
      // back to the hub, not the quiz's class page (?from=quizzes hub link).
      backHref={from === "quizzes" ? "/lecturer/quizzes" : `/lecturer/classes/${quiz.class_id}`}
      backToQuizzes={from === "quizzes"}
      unrevealedCompleted={
        quiz.status === "live" &&
        quiz.mode === "assessment" &&
        quiz.results_revealed_at == null
          ? completedUnrevealed ?? 0
          : 0
      }
      ocrConfig={{
        defaultEngine: (process.env.OCR_DEFAULT_ENGINE as "tesseract" | "glm") ?? "tesseract",
      }}
    />
  );
}
