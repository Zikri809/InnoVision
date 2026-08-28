import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireClassOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { CreateQuizSchema } from "@/lib/quizzes/validation";
import {
  checkBodyLimit,
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  notFound,
  rateLimited,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-lecturer quiz-creation budget (student-surface parity; abuse bound).
const CREATE_RATE = { limit: 60, windowMs: 60 * 60 * 1000 };

/**
 * POST /api/classes/[id]/quizzes — lecturer creates a quiz in their own class.
 * Body: { title, mode?, timeLimitSec?, opensAt?, closesAt? }. Always starts as
 * a draft. Window endpoints are optional ISO timestamps (null = unbounded).
 */
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id: classId } = await params;

  if (!isUuid(classId)) {
    return notFound();
  }

  const owner = await requireClassOwner(supabase, classId);
  if (!owner.ok) return owner.response;
  if (owner.archivedAt) {
    return invalidBody("Cannot create quizzes in an archived class.");
  }

  // CSRF: reject cross-origin quiz creation (AI/session-route precedent).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`quiz-create:${owner.userId}`, CREATE_RATE)) {
    return rateLimited("Too many quizzes created. Try again later.");
  }

  const sizeError = checkBodyLimit(request);
  if (sizeError) return sizeError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = CreateQuizSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid quiz data."));
  }

  const { title, mode, timeLimitSec, opensAt, closesAt, allowRetake, maxAttempts } = parsed.data;
  const effectiveTimeLimitSec = mode === "practice" ? null : (timeLimitSec ?? null);

  const { data: quiz, error } = await supabase
    .from("quizzes")
    .insert({
      class_id: classId,
      created_by: owner.userId,
      title,
      mode,
      time_limit_sec: effectiveTimeLimitSec,
      opens_at: opensAt ?? null,
      closes_at: closesAt,
      allow_retake: mode === "assessment" ? (allowRetake ?? false) : false,
      max_attempts: mode === "assessment" ? (maxAttempts ?? 1) : 1,
      status: "draft",
    })
    .select("id, class_id, title, mode, status, time_limit_sec, opens_at, closes_at, allow_retake, max_attempts, created_at")
    .single();

  if (error) {
    console.error("Create quiz error:", error);
    if (error.message?.includes("quizzes_class_id_fkey")) {
      return notFound();
    }
    if (
      error.message?.includes("quizzes_practice_untimed") ||
      error.message?.includes("time_limit") ||
      error.message?.includes("quizzes_title_check") ||
      error.message?.includes("quizzes_window_order_check") ||
      error.message?.includes("quizzes_max_attempts_check") ||
      error.message?.includes("check constraint")
    ) {
      return invalidBody("Invalid quiz configuration.");
    }
    return internalError("Could not create the quiz right now.");
  }

  return NextResponse.json({ quiz }, { status: 201 });
}
