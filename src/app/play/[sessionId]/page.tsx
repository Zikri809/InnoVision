import { redirect, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/classes/roster";
import { firstUnansweredIndex, remainingMs } from "@/lib/sessions/timer";
import {
  applyBreakdownShuffle,
  applyQuestionShuffle,
  optionScope,
  QUESTION_ORDER_SCOPE,
  shufflePlan,
  toPresented,
} from "@/lib/sessions/shuffle";
import { PlayClient } from "@/components/quiz/play-client";
import { EndScreen } from "@/components/quiz/end-screen";
import type { FaceStatus } from "@/lib/face/types";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ sessionId: string }> };

type QuestionRow = {
  id: string;
  order_index: number;
  type: "mcq" | "true_false" | "multi_select";
  prompt: string;
  options: string[];
  has_image: boolean;
  created_at: string;
};

type SessionRow = {
  id: string;
  quiz_id: string;
  student_id: string;
  mode: "practice" | "assessment";
  status: "active" | "paused" | "flagged" | "completed";
  started_at: string;
  submitted_at: string | null;
  score: number | null;
  face_exempt: boolean;
  face_fail_streak: number;
  verify_nonce: string;
  face_unavailable_at: string | null;
  last_activity_at: string;
};

type QuizRow = {
  id: string;
  title: string;
  mode: "practice" | "assessment";
  status: "draft" | "live" | "closed";
  time_limit_sec: number | null;
  results_revealed_at: string | null;
  shuffle_questions: boolean | null;
};

type AnswerRow = {
  question_id: string;
  selected_index: number | null;
  /** Nullable: assessment pre-reveal hides correctness (student_answers_view). */
  is_correct: boolean | null;
  /** QT-1: multi-select rows carry the canonical selection set instead. */
  selected_indices: number[] | null;
};

/** One per-question result row from `student_results` (score + breakdown). */
export type ResultsBreakdownRow = {
  question_id: string;
  order_index: number;
  type: "mcq" | "true_false" | "multi_select";
  prompt: string;
  options: string[];
  selected_index: number | null;
  selected_indices: number[] | null;
  is_correct: boolean | null;
  correct_index: number | null;
  correct_indices: number[] | null;
  explanation: string | null;
  has_image?: boolean;
};

/**
 * Play page — server component. Reads the student's own session, quiz
 * metadata (student_quiz_view), questions (student_question_view — no
 * correct_index/explanation), and own answers for resume (student_answers_view
 * — is_correct reveal-gated). Computes `initialIndex` + `initialRemainingMs`
 * server-side and passes them to the client engine (the client never imports
 * lib/sessions).
 *
 * The session is fetched first (its `quiz_id` drives the other queries);
 * then quiz/questions/answers run in parallel with per-query error capture
 * (NOT bare Promise.all) so a single DB hiccup renders the friendly error
 * panel, not a raw 500.
 */
export default async function PlayPage({ params }: PageProps) {
  const { sessionId } = await params;
  const tPlay = await getTranslations("play");
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
        <p
          className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground"
          role="alert"
        >
          {tPlay("profileSettingUp")}
        </p>
      </div>
    );
  }
  if (profile.role !== "student") redirect("/lecturer/classes");

  if (!isUuid(sessionId)) notFound();

  // 1. Own session (missing / not-owned → notFound, no oracle). Read via the
  // student-safe view (score is reveal-gated; the raw quiz_sessions score is
  // column-revoked from authenticated per PLAN_REVEAL_RESULTS v4).
  const { data: session, error: sessionError } = await supabase
    .from("student_session_view")
    .select("id, quiz_id, student_id, mode, status, started_at, submitted_at, score, face_exempt, face_fail_streak, verify_nonce, face_unavailable_at, last_activity_at")
    .eq("id", sessionId)
    .eq("student_id", user.id)
    .maybeSingle();

  if (sessionError) {
    console.error("Play session fetch error:", sessionError);
    return errorPanel(tPlay("quizLoadError"));
  }
  if (!session) notFound();

  const s = session as SessionRow;

  // 2–4. Remaining reads in parallel with per-query error capture. The
  // answers fetch (resume) is SKIPPED when the session is completed —
  // EndScreen doesn't need it.
  const answersPromise =
    s.status === "completed"
      ? Promise.resolve({ data: [] as AnswerRow[], error: null })
      : supabase
          .from("student_answers_view")
          .select("question_id, selected_index, selected_indices, is_correct")
          .eq("session_id", sessionId);

  // P7: `exists(face_checks)` → hasFaceChecks (the assessment gate is NOT
  // bypassable by reload — `'ready'` requires ≥1 recorded check) + own-profile
  // presence booleans (consent / enrollment) for the gate UI.
  const faceChecksPromise = supabase
    .from("face_checks")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId);
  const profilePromise = supabase
    .from("profiles")
    .select("consent_given_at, face_enrollment_status")
    .eq("id", user.id)
    .maybeSingle();
  // InsightFace migration (0039): enrollment status alone is not sufficient —
  // a pre-migration enrollee has status 'enrolled' but NO stored baseline
  // (raw frames were never kept). The gate additionally requires a real
  // biometric baseline so such students re-enroll instead of failing every
  // verify mid-quiz.
  const baselinePromise = supabase.rpc("face_baseline_status");

  // QC-2: a CLOSED+REVEALED quiz falls out of the live-only
  // student_quiz_view — recover its metadata through the closed-revealed
  // view (reveal-gated, barrier). Closed+unrevealed stays a truthful 404.
  const [quizRes, questionsRes, answersRes, faceChecksRes, profileRes, baselineRes] = await Promise.allSettled([
    supabase
      .from("student_quiz_view")
      .select("id, title, mode, status, time_limit_sec, results_revealed_at, shuffle_questions")
      .eq("id", s.quiz_id)
      .maybeSingle()
      .then(async (r) =>
        r.data
          ? r
          : supabase
              .from("student_closed_revealed_quiz_view")
              .select("id, title, mode, status, time_limit_sec, results_revealed_at, shuffle_questions")
              .eq("id", s.quiz_id)
              .maybeSingle(),
      ),
    supabase
      .from("student_question_view")
      .select("id, order_index, type, prompt, options, has_image, created_at")
      .eq("quiz_id", s.quiz_id)
      .order("order_index", { ascending: true })
      .order("created_at", { ascending: true }),
    answersPromise,
    faceChecksPromise,
    profilePromise,
    baselinePromise,
  ]);

  if (quizRes.status === "rejected" || quizRes.value.error) {
    console.error("Play quiz fetch error:", quizRes.status === "rejected" ? quizRes.reason : quizRes.value.error);
    return errorPanel(tPlay("quizLoadError"));
  }
  if (questionsRes.status === "rejected" || questionsRes.value.error) {
    console.error("Play questions fetch error:", questionsRes.status === "rejected" ? questionsRes.reason : questionsRes.value.error);
    return errorPanel(tPlay("quizLoadError"));
  }
  if (answersRes.status === "rejected" || answersRes.value.error) {
    console.error("Play answers fetch error:", answersRes.status === "rejected" ? answersRes.reason : answersRes.value.error);
    return errorPanel(tPlay("quizLoadError"));
  }
  if (faceChecksRes.status === "rejected" || faceChecksRes.value.error) {
    console.error("Play face-checks fetch error:", faceChecksRes.status === "rejected" ? faceChecksRes.reason : faceChecksRes.value.error);
    return errorPanel(tPlay("quizLoadError"));
  }
  if (profileRes.status === "rejected" || profileRes.value.error) {
    console.error("Play profile fetch error:", profileRes.status === "rejected" ? profileRes.reason : profileRes.value.error);
    return errorPanel(tPlay("quizLoadError"));
  }

  const quiz = quizRes.value.data as QuizRow | null;
  if (!quiz) notFound();

  // The views' generated types mark columns nullable (views can't express NOT
  // NULL to the type generator); the underlying columns are NOT NULL. The
  // casts narrow to the non-null shape the client expects (same workaround as
  // student-quizzes/page.tsx).
  const questions = (questionsRes.value.data ?? []) as QuestionRow[];

  // ── QT-3: per-session shuffling. When the quiz opts in, BOTH the question
  // order and each question's option order are permuted into presented space,
  // deterministically derived from (sessionId, question id) — nothing is
  // stored, so resume/multi-device reloads re-derive the identical order.
  // The client translates presented→canonical indices before POSTing (the
  // wire and session_answers stay canonical); review below is translated the
  // other way so highlights match what the student saw.
  const shuffled = quiz.shuffle_questions === true;
  const presentedQuestions = shuffled ? applyQuestionShuffle(s.id, questions) : questions;

  // P7: seeding precedence (PLAN_PHASE7 §2) — completed → EndScreen;
  // flagged → 'flagged'; paused → 'paused'; faceExempt → 'exempt' (only when
  // active); !hasFaceChecks → 'gate'; else 'ready'.
  const hasFaceChecks = (faceChecksRes.value.count ?? 0) > 0;
  const ownProfile = profileRes.value.data as { consent_given_at: string | null; face_enrollment_status: string | null } | null;
  const baseline = baselineRes.status === "fulfilled"
    ? (baselineRes.value.data as { present: boolean; sample_count: number } | null)
    : null;
  const consentGiven = Boolean(ownProfile?.consent_given_at);
  // pending_review must NOT count as enrolled (the gate blocks it); a
  // cutover student (status enrolled, zero samples) must re-enroll.
  const enrolled =
    ownProfile?.face_enrollment_status === "enrolled" && baseline?.present === true;

  let initialFaceStatus: FaceStatus = "off";
  if (s.mode === "assessment") {
    if (s.status === "flagged") initialFaceStatus = "flagged";
    else if (s.status === "paused") initialFaceStatus = "paused";
    else if (s.face_exempt && s.status === "active") initialFaceStatus = "exempt";
    else if (!hasFaceChecks) initialFaceStatus = "gate";
    else initialFaceStatus = "ready";
  }

  // Defensive: the RPC copies mode at start; direct service-role writes are
  // trusted, but this closes drift.
  if (s.mode !== quiz.mode) notFound();

  // ── QC-2: completed sessions render their EndScreen BEFORE the questions
  // guard. student_question_view is live-only (can_student_view_quiz), so a
  // CLOSED quiz yields 0 rows even though the attempt completed and (for
  // practice / closed+revealed assessments) the results are visible. The
  // EndScreen is driven by `student_results` (no status term, 0028) — the
  // breakdown rows carry their own truth; `total` falls back to the
  // breakdown length when the question projection is empty.
  if (s.status === "completed") {
    // Practice always reveals; assessment only once results_revealed_at set.
    const revealed = quiz.mode === "practice" || quiz.results_revealed_at != null;

    // Server-side breakdown (student_results is security-definer; re-validates
    // enrollment + reveal + own-session scope). Reveal-gated: hidden assessment
    // returns error → no breakdown, no fabricated score.
    let breakdown: ResultsBreakdownRow[] = [];
    if (revealed) {
      const { data: rpcRes, error: rpcErr } = await supabase.rpc("student_results", {
        p_quiz_id: s.quiz_id,
      });
      if (!rpcErr) {
        const r = rpcRes as { questions?: unknown[]; total?: unknown } | null;
        breakdown = (r?.questions ?? []).map((q) => q as ResultsBreakdownRow);
        if (shuffled && breakdown.length > 0) {
          // QT-3: reorder rows + translate indices into presented space so the
          // review matches the order the student answered in. On the QC-2
          // closed+revealed path student_question_view is live-only → the
          // question projection is empty, so derive the presented order from
          // the breakdown rows themselves (canonical order via order_index).
          const presentedIds =
            presentedQuestions.length > 0
              ? presentedQuestions.map((q) => q.id)
              : shufflePlan(s.id, QUESTION_ORDER_SCOPE, breakdown.length).map(
                  (i) => breakdown[i].question_id,
                );
          breakdown = applyBreakdownShuffle(s.id, presentedIds, breakdown);
        }
      }
      // On RPC error fall through to the score-only EndScreen (never crash).
    }

    const total = questions.length > 0 ? questions.length : breakdown.length;

    return (
      <EndScreen
        session={s}
        quiz={quiz}
        revealed={revealed}
        score={revealed ? s.score : null}
        total={total}
        breakdown={revealed ? breakdown : []}
      />
    );
  }

  // Degenerate guard: a live quiz always has ≥1 question (publish trigger),
  // but guard defensively to avoid a divide-by-zero in the client HUD.
  if (questions.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          {tPlay("quizNoQuestions")}
        </p>
      </div>
    );
  }

  // Resume: server computes the first unanswered index — in the student's
  // PRESENTED order when shuffling is on (ID-keyed, so it survives the
  // permutation; the presented position is what the HUD shows).
  const answeredRows = (answersRes.value.data ?? []) as AnswerRow[];
  const answeredIds = answeredRows.map((a) => a.question_id);
  const initialIndex = firstUnansweredIndex(presentedQuestions, answeredIds);

  // QT-3: stored selected_index/selected_indices values are canonical (the
  // wire never carries presented indices); translate once here so the client
  // renders the resume highlight against the presented options array.
  // QT-1: multi rows translate their set element-wise.
  const presentedAnswers = shuffled
    ? answeredRows.map((a) => {
        const q = presentedQuestions.find((x) => x.id === a.question_id);
        if (!q) return a;
        const plan = shufflePlan(s.id, optionScope(q.id), q.options.length);
        const presented = toPresented(a.selected_index, plan);
        const presentedSet = a.selected_indices
          ? a.selected_indices.map((i) => toPresented(i, plan) ?? i)
          : null;
        return { ...a, selected_index: presented, selected_indices: presentedSet };
      })
    : answeredRows;

  const initialRemainingMs = remainingMs({
    startedAt: new Date(s.started_at).getTime(),
    timeLimitSec: quiz.time_limit_sec,
    // Server component: each request is a fresh render, so current time is
    // intentional here (the client must not read the clock — this is the
    // server-computed seed). Suppressed purity rule for the same reason.
    // eslint-disable-next-line react-hooks/purity
    serverNow: Date.now(),
  });

  return (
    <PlayClient
      sessionId={s.id}
      quiz={{ id: quiz.id, title: quiz.title, mode: quiz.mode, timeLimitSec: quiz.time_limit_sec }}
      questions={presentedQuestions}
      initialAnswers={presentedAnswers}
      initialIndex={initialIndex}
      initialRemainingMs={initialRemainingMs}
      shuffled={shuffled}
      hasMultiQuestions={presentedQuestions.some((q) => q.type === "multi_select")}
      face={{
        enrolled,
        consentGiven,
        faceExempt: s.face_exempt,
        initialNonce: s.verify_nonce,
        initialFaceStatus,
        hasFaceChecks,
      }}
    />
  );
}

function errorPanel(msg: string) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
        {msg}
      </p>
    </div>
  );
}
