import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { StudentQuizzesClient } from "./student-quizzes-client";

const QUIZ_LIST_LIMIT = 200;

export default async function StudentQuizzesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, face_enrollment_status")
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

  if (profile.role !== "student") redirect("/lecturer/classes");

  // Students see LIVE quizzes from their enrolled classes only, via the
  // column-restricted student_quiz_view (no source_file_url / created_by —
  // MED-1) and student_class_view (no join_code — M-1). Both views are gated
  // by is_enrolled_in_class internally, so a draft quiz is invisible and an
  // unenrolled student sees nothing. Class titles are mapped in memory from
  // the second view query (students can no longer read `classes`/`quizzes`
  // directly).
  const [{ data: quizzes, error }, { data: enrolledClasses, error: classesError }] =
    await Promise.all([
      supabase
        .from("student_quiz_view")
        .select("id, class_id, title, mode, status, time_limit_sec, created_at")
        .order("created_at", { ascending: false })
        .limit(QUIZ_LIST_LIMIT),
      supabase
        .from("student_class_view")
        .select("id, title")
        .limit(QUIZ_LIST_LIMIT),
    ]);

  if (error || classesError) {
    console.error("Quizzes fetch error:", error ?? classesError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load the quizzes right now. Please refresh.
        </p>
      </div>
    );
  }

  const classTitleById = new Map((enrolledClasses ?? []).map((c) => [c.id, c.title]));
  // The views' generated types mark columns nullable (views can't express NOT
  // NULL to the type generator); the underlying columns are NOT NULL. Narrow
  // to the non-null shape the client expects.
  const quizzesWithClass = (quizzes ?? [])
    .filter((q) => q.id && q.title && q.mode && q.status && q.class_id)
    .map((q) => ({
      id: q.id!,
      class_id: q.class_id!,
      title: q.title!,
      mode: q.mode!,
      status: q.status!,
      time_limit_sec: q.time_limit_sec,
      created_at: q.created_at!,
      classes: classTitleById.get(q.class_id!) ? { title: classTitleById.get(q.class_id!)! } : null,
    }));

  return (
    <StudentQuizzesClient
      quizzes={quizzesWithClass}
      enrolled={profile.face_enrollment_status === "enrolled"}
    />
  );
}
