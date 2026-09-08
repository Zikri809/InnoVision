import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { buildExportModel } from "@/lib/results/export";
import { buildQuestionInsights, type QuestionInsightsModel } from "@/lib/results/insights";
import { getClassRoster } from "@/lib/classes/roster";
import { RESULTS_SESSION_LIMIT } from "@/lib/results/constants";
import { ProfilePendingPanel, LoadErrorPanel } from "@/components/layout/load-state";

/** RA-2: hard row cap on the answers read (mirrors the export route's cap). */
const ANSWERS_LIMIT = 20_000;

/**
 * RA-2 — shared loader for the on-screen item analysis ("Question insights").
 *
 * Extracted from results/page.tsx when insights moved to its own route
 * (/lecturer/quizzes/[id]/insights) so the dashboard and the insights page
 * share ONE implementation of: auth gate, class-ownership re-check, the
 * capped questions/answers reads, and the representative-session feed order.
 *
 * The answers read is capped (20k) exactly like the export route; hitting the
 * cap sets `insightsTruncated` so the UI can warn that percentages may
 * under-report.
 *
 * Auth failures redirect (`/login`, `/student/classes`) and missing records
 * fold to 404 (notFound) directly. Read outages return `{ ok: false, panel }`
 * — the caller renders the standard destructive error panel instead of the
 * content (never an empty "no data" state on a DB outage).
 */
export async function loadQuizInsights(quizId: string): Promise<
  { ok: true; insights: QuestionInsightsModel; insightsTruncated: boolean } | { ok: false; panel: React.ReactNode }
> {
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
    return { ok: false, panel: <ProfilePendingPanel /> };
  }
  if (profile.role !== "lecturer") redirect("/student/classes");

  // Owner-filtered quiz fetch (no oracle: not-found folds 404).
  const { data: quiz, error: quizError } = await supabase
    .from("quizzes")
    .select("id, class_id, title, mode, status")
    .eq("id", quizId)
    .maybeSingle();
  if (quizError) {
    console.error("Quiz fetch error:", quizError);
    return { ok: false, panel: <LoadErrorPanel /> };
  }
  if (!quiz) notFound();

  // Explicit class-ownership re-check (defense in depth on top of RLS).
  const { data: ownedClass, error: ownedClassError } = await supabase
    .from("classes")
    .select("id")
    .eq("id", quiz.class_id)
    .eq("lecturer_id", user.id)
    .maybeSingle();
  if (ownedClassError) {
    console.error("Class ownership check error:", ownedClassError);
    return { ok: false, panel: <LoadErrorPanel /> };
  }
  if (!ownedClass) notFound();

  const [
    { data: sessions, error: sessionsError },
    rosterResult,
    { data: questionRows, error: questionsError },
  ] = await Promise.all([
    supabase
      .from("lecturer_session_view")
      // GET-envelope columns MINUS verify_nonce (the student replay token).
      .select(
        "id, quiz_id, student_id, mode, status, score, started_at, submitted_at, last_activity_at, face_unavailable_at, face_exempt, face_fail_streak, focus_pause_count, attempt",
      )
      .eq("quiz_id", quizId)
      // Representative-session policy (export route's feed): started_at DESC,
      // id DESC secondary for determinism on equal timestamps.
      .order("started_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(RESULTS_SESSION_LIMIT),
    getClassRoster(supabase, quiz.class_id),
    supabase
      .from("questions")
      .select("id, order_index, type, prompt, options, correct_index, correct_indices, explanation")
      .eq("quiz_id", quizId)
      .order("order_index", { ascending: true }),
  ]);

  if (sessionsError) {
    console.error("Sessions fetch error:", sessionsError);
    return { ok: false, panel: <LoadErrorPanel /> };
  }
  if (rosterResult.error) {
    console.error("Roster fetch error:", rosterResult.error);
    return { ok: false, panel: <LoadErrorPanel /> };
  }
  if (questionsError) {
    console.error("Questions fetch error:", questionsError);
    return { ok: false, panel: <LoadErrorPanel /> };
  }

  const sessionRows = (sessions ?? []) as import("@/lib/results/types").ResultsSessionInput[];
  const sessionIds = sessionRows.map((s) => s.id);

  type InsightAnswerRow = {
    session_id: string;
    question_id: string;
    selected_index: number | null;
    selected_indices: number[] | null;
    is_correct: boolean;
  };
  const { data: answerRows, error: answersError } =
    sessionIds.length === 0
      ? { data: [] as InsightAnswerRow[], error: null as null }
      : await supabase
          .from("lecturer_answers_view")
          .select("session_id, question_id, selected_index, selected_indices, is_correct")
          .in("session_id", sessionIds)
          .limit(ANSWERS_LIMIT);
  if (answersError) {
    console.error("Answers fetch error:", answersError);
    return { ok: false, panel: <LoadErrorPanel /> };
  }
  const answersTruncated = (answerRows?.length ?? 0) >= ANSWERS_LIMIT;

  // Server render clock — each request is a fresh render, so current time is
  // intentional (same reasoning as the results page's assembleResultsRows).
  const nowMs = Date.now();
  const insights = buildQuestionInsights({
    quiz: { title: quiz.title, mode: quiz.mode, status: quiz.status },
    className: null,
    generatedAtISO: new Date(nowMs).toISOString(),
    questions: (questionRows ?? []) as Parameters<typeof buildExportModel>[0]["questions"],
    roster: rosterResult.roster,
    sessions: sessionRows as Parameters<typeof buildExportModel>[0]["sessions"],
    answers: (answerRows ?? []) as Parameters<typeof buildExportModel>[0]["answers"],
    nowMs,
    answersTruncated,
  });

  return { ok: true, insights, insightsTruncated: answersTruncated };
}
