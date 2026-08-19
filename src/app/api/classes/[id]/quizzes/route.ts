import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireClassOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { CreateQuizSchema } from "@/lib/quizzes/validation";
import {
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  notFound,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/classes/[id]/quizzes — lecturer creates a quiz in their own class.
 * Body: { title, mode?, timeLimitSec? }. Always starts as a draft.
 */
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id: classId } = await params;

  if (!isUuid(classId)) {
    return notFound();
  }

  const owner = await requireClassOwner(supabase, classId);
  if (!owner.ok) return owner.response;

  // CSRF: reject cross-origin quiz creation (AI/session-route precedent).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

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

  const { title, mode, timeLimitSec } = parsed.data;
  const effectiveTimeLimitSec = mode === "practice" ? null : (timeLimitSec ?? null);

  const { data: quiz, error } = await supabase
    .from("quizzes")
    .insert({
      class_id: classId,
      created_by: owner.userId,
      title,
      mode,
      time_limit_sec: effectiveTimeLimitSec,
      status: "draft",
    })
    .select("id, class_id, title, mode, status, time_limit_sec, created_at")
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
      error.message?.includes("check constraint")
    ) {
      return invalidBody("Invalid quiz configuration.");
    }
    return internalError("Could not create the quiz right now.");
  }

  return NextResponse.json({ quiz }, { status: 201 });
}
