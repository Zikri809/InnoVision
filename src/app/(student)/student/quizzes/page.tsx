import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { StudentQuizzesClient } from "./student-quizzes-client";
import { ProfilePendingPanel, LoadErrorPanel } from "@/components/layout/load-state";
import { filterByClass, sortByDeadline } from "./list-order";

const QUIZ_LIST_LIMIT = 200;

export default async function StudentQuizzesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // SQ-4: optional ?class=<id> drill-down from a class card. The id is only a
  // narrow filter — RLS (student_quiz_view's is_enrolled_in_class predicate)
  // guarantees an unenrolled/invalid id simply yields an empty list, so no
  // validation beyond the shape check is needed (no oracle either way).
  const rawClass = params.class;
  const classFilter = typeof rawClass === "string" ? rawClass : null;

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

  // InsightFace migration (0039): status alone is not sufficient — a
  // pre-migration enrollee has status 'enrolled' but NO stored baseline (raw
  // frames were never kept). The enroll CTA must show for them.
  const baseline = await supabase.rpc("face_baseline_status");
  const hasBaseline = (baseline.data as { present: boolean } | null)?.present === true;

  if (!profile) {
    return (
      <ProfilePendingPanel />
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
  //
  // SQ-2 (results entry point): one extra student_session_view read (RLS =
  // own sessions) supplies each quiz's latest COMPLETED attempt so cards can
  // render a "View results" / "awaiting results" state. Flagged sessions are
  // deliberately NOT chip-eligible (documented divergence; RA-1 gradebook
  // shows their scores to the lecturer, the student card stays unchanged).
  const [{ data: quizzes, error }, { data: enrolledClasses, error: classesError }] =
    await Promise.all([
      supabase
        .from("student_quiz_view")
        .select("id, class_id, title, mode, status, time_limit_sec, allow_retake, max_attempts, results_revealed_at, opens_at, closes_at, created_at")
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
      <LoadErrorPanel />
    );
  }

  const quizIds = (quizzes ?? []).map((q) => q.id).filter((v): v is string => Boolean(v));
  const { data: completedSessions, error: sessionsError } =
    quizIds.length === 0
      ? { data: [] as { id: string | null; quiz_id: string | null; status: string | null; started_at: string | null; submitted_at: string | null }[], error: null }
      : await supabase
          .from("student_session_view")
          .select("id, quiz_id, status, started_at, submitted_at")
          .in("quiz_id", quizIds)
          .eq("status", "completed")
          .order("started_at", { ascending: false })
          .limit(QUIZ_LIST_LIMIT * 2);

  if (sessionsError) {
    console.error("Quizzes sessions fetch error:", sessionsError);
    return (
      <LoadErrorPanel />
    );
  }

  const classTitleById = new Map((enrolledClasses ?? []).map((c) => [c.id, c.title]));
  // Latest completed session per quiz: the read is already started_at DESC,
  // so the FIRST row seen per quiz_id wins (deterministic tie-break discipline
  // mirrors the export feed's started_at DESC, id DESC).
  const latestCompletedByQuiz = new Map<string, string>();
  for (const s of completedSessions ?? []) {
    if (!s.quiz_id || !s.id) continue;
    if (!latestCompletedByQuiz.has(s.quiz_id)) latestCompletedByQuiz.set(s.quiz_id, s.id);
  }

  // The views' generated types mark columns nullable (views can't express NOT
  // NULL to the type generator); the underlying columns are NOT NULL. Narrow
  // to the non-null shape the client expects.
  // SQ-1: deadline sort + SQ-4 class filter — pure helpers in list-order.ts
  // (unit-pinned). Server component: each request is a fresh render, so
  // reading the clock here is intentional (same suppressed-purity precedent
  // as the play page's serverNow seed).
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const sortedQuizzes = sortByDeadline(quizzes ?? [], nowMs);

  const quizzesWithClass = filterByClass(sortedQuizzes, classFilter)
    .filter((q) => q.id && q.title && q.mode && q.status && q.class_id)
    .map((q) => ({
      id: q.id!,
      class_id: q.class_id!,
      title: q.title!,
      mode: q.mode!,
      status: q.status!,
      time_limit_sec: q.time_limit_sec,
      allow_retake: q.allow_retake,
      max_attempts: q.max_attempts,
      opens_at: q.opens_at,
      closes_at: q.closes_at,
      created_at: q.created_at!,
      classes: classTitleById.get(q.class_id!) ? { title: classTitleById.get(q.class_id!)! } : null,
      // SQ-2: null = no completed attempt (or practice — client ignores it);
      // revealed = results_revealed_at set (auto-reveal sets it in
      // submit_session — single source of truth, never client math).
      completedSessionId: latestCompletedByQuiz.get(q.id!) ?? null,
      resultsRevealed: q.results_revealed_at != null,
    }));

  return (
    <StudentQuizzesClient
      quizzes={quizzesWithClass}
      enrolled={profile.face_enrollment_status === "enrolled" && hasBaseline}
      classFilter={classFilter}
      classFilterTitle={classFilter ? (classTitleById.get(classFilter) ?? null) : null}
    />
  );
}
