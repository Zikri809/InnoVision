import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getClassRoster } from "@/lib/classes/roster";
import { assembleResultsRows } from "@/lib/results/derive";
import { RESULTS_SESSION_LIMIT, RESULTS_AUDIT_LIMIT } from "@/lib/results/constants";
import { ResultsDashboardClient } from "./results-dashboard-client";

export const dynamic = "force-dynamic";

/**
 * Lecturer results dashboard — attendance (= sessions), scores, and integrity
 * timelines for a quiz (Phase 8).
 *
 * D1: the results read is a lecturer RSC (no new read API route) — direct
 * RLS-scoped reads with EXPLICIT `.select(...)` projections (D8). This page is
 * thin glue; every derivation/ordering decision lives in pure
 * `lib/results/derive.ts`. Reads are NOT API-gated (the I21 gate is the reset
 * route only).
 *
 * Access: lecturer who owns the quiz's CLASS (builder-page pattern). A DB
 * outage on any read renders the destructive error panel (never an empty
 * "not attempted" dashboard); only `error === null` + zero rows is the empty
 * state.
 */
export default async function LecturerQuizResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
    .select("id, class_id, title, mode, status, time_limit_sec, results_revealed_at, auto_reveal_on_complete")
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

  // Explicit class-ownership re-check (defense in depth on top of RLS).
  const { data: ownedClass, error: ownedClassError } = await supabase
    .from("classes")
    .select("id")
    .eq("id", quiz.class_id)
    .eq("lecturer_id", user.id)
    .maybeSingle();

  if (ownedClassError) {
    console.error("Class ownership check error:", ownedClassError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load the results right now. Please refresh.
        </p>
      </div>
    );
  }
  if (!ownedClass) notFound();

  // ── Parallel reads, each with explicit projections (D8) ──────────
  const [
    { data: sessions, error: sessionsError },
    rosterResult,
    { count: totalQuestions, error: totalQuestionsError },
  ] = await Promise.all([
      supabase
        .from("lecturer_session_view")
        // GET-envelope columns MINUS verify_nonce (the student replay token).
        .select(
          "id, quiz_id, student_id, mode, status, score, started_at, submitted_at, last_activity_at, face_unavailable_at, face_exempt, face_fail_streak, focus_pause_count",
        )
        .eq("quiz_id", id)
        .order("started_at", { ascending: false })
        .limit(RESULTS_SESSION_LIMIT),
      getClassRoster(supabase, quiz.class_id),
      supabase.from("questions").select("id", { count: "exact", head: true }).eq("quiz_id", id),
    ]);

  if (sessionsError) {
    console.error("Sessions fetch error:", sessionsError);
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
  if (totalQuestionsError) {
    console.error("Questions count fetch error:", totalQuestionsError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load the results right now. Please refresh.
        </p>
      </div>
    );
  }

  const sessionRows = (sessions ?? []) as import("@/lib/results/types").ResultsSessionInput[];
  const sessionIds = sessionRows.map((s) => s.id);
  const studentIds = sessionRows.map((s) => s.student_id);

  // Guarded-empty reads: skip the fetch entirely when there are no sessions.
  const [
    { data: faceChecks, error: faceChecksError },
    { data: auditRows, error: auditError },
    { data: advisoryRows, error: advisoriesError },
    { data: clipRows, error: clipsError },
  ] =
    sessionIds.length === 0
      ? [
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
        ]
      : await Promise.all([
          supabase
            .from("face_checks")
            // Timeline columns only — never frame_hash (D8). Capped like the
            // audit read (a long-running assessment + 200 sessions could
            // otherwise return thousands of rows unchecked).
            .select("id, session_id, checked_at, matched, distance, trigger, suspected_replay, too_frequent")
            .in("session_id", sessionIds)
            .order("checked_at", { ascending: false })
            .limit(RESULTS_AUDIT_LIMIT),
          supabase
            .from("lecturer_audit_view")
            // Curated view columns; the view's own predicate gates readability.
            .select("id, actor_id, subject_id, action, created_at, event_quiz_id, event_session_id")
            .in("subject_id", studentIds)
            // Deterministic cap: newest first so this quiz's recent rows
            // (incl. reset markers) are never silently dropped by truncation.
            .order("created_at", { ascending: false })
            .limit(RESULTS_AUDIT_LIMIT),
          supabase
            .from("session_advisories")
            .select("session_id, adv_type, first_seen_at, last_seen_at, occurrences")
            .in("session_id", sessionIds),
          supabase
            .from("incident_clips")
            .select("id, session_id, storage_path, reason, duration_ms, recorded_from, recorded_to")
            .in("session_id", sessionIds)
            .order("recorded_from", { ascending: false }),
        ]);

  if (faceChecksError) {
    console.error("Face checks fetch error:", faceChecksError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load the results right now. Please refresh.
        </p>
      </div>
    );
  }
  if (auditError) {
    console.error("Audit read error:", auditError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load the results right now. Please refresh.
        </p>
      </div>
    );
  }
  if (advisoriesError) {
    console.error("Advisories fetch error:", advisoriesError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load the results right now. Please refresh.
        </p>
      </div>
    );
  }
  if (clipsError) {
    console.error("Incident clips fetch error:", clipsError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load the results right now. Please refresh.
        </p>
      </div>
    );
  }

  // Signed playback URLs: the incident-footage bucket is PRIVATE with no
  // client policies, so signing runs through the service-role client
  // (server-side only; the 1h URLs are short-lived and never stored).
  const incidentClips: Record<string, { id: string; url: string; reason: string; durationMs: number; recordedFrom: string | null }[]> = {};
  if ((clipRows ?? []).length > 0) {
    const admin = createAdminClient();
    for (const clip of clipRows ?? []) {
      const { data: signed } = await admin.storage
        .from("incident-footage")
        .createSignedUrl(clip.storage_path, 3600);
      if (!signed?.signedUrl) continue;
      const list = incidentClips[clip.session_id] ?? [];
      list.push({
        id: clip.id,
        url: signed.signedUrl,
        reason: clip.reason,
        durationMs: clip.duration_ms ?? 0,
        recordedFrom: clip.recorded_from,
      });
      incidentClips[clip.session_id] = list;
    }
  }

  const rows = assembleResultsRows({
    quiz: { status: quiz.status },
    sessions: sessionRows,
    roster: rosterResult.roster,
    faceChecks: faceChecks ?? [],
    auditRows: auditRows ?? [],
    advisories: advisoryRows ?? [],
    totalQuestions: totalQuestions ?? 0,
    // Server component: each request is a fresh render, so current time is
    // intentional (the abandonment derivation is server-computed). Suppressed
    // purity rule for the same reason as the play page's remainingMs seed.
    // eslint-disable-next-line react-hooks/purity
    nowMs: Date.now(),
  });

  return (
    <ResultsDashboardClient
      quizId={quiz.id}
      quizTitle={quiz.title}
      mode={quiz.mode}
      status={quiz.status}
      timeLimitSec={quiz.time_limit_sec}
      resultsRevealedAt={quiz.results_revealed_at}
      autoRevealOnComplete={quiz.auto_reveal_on_complete}
      totalQuestions={totalQuestions ?? 0}
      truncated={sessionRows.length >= RESULTS_SESSION_LIMIT}
      rows={rows}
      roster={rosterResult.roster}
      incidentClips={incidentClips}
    />
  );
}