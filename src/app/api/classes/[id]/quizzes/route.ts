import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireClassOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { CreateQuizSchema } from "@/lib/quizzes/validation";
import { checkSameOrigin } from "@/lib/http";

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
    return NextResponse.json({ error: "not_found" }, { status: 404 });
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
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = CreateQuizSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        message: parsed.error.issues[0]?.message ?? "Invalid quiz data.",
      },
      { status: 400 },
    );
  }

  const { title, mode, timeLimitSec } = parsed.data;

  const { data: quiz, error } = await supabase
    .from("quizzes")
    .insert({
      class_id: classId,
      created_by: owner.userId,
      title,
      mode,
      time_limit_sec: timeLimitSec ?? null,
      status: "draft",
    })
    .select("id, class_id, title, mode, status, time_limit_sec, created_at")
    .single();

  if (error) {
    console.error("Create quiz error:", error);
    return NextResponse.json(
      { error: "internal", message: "Could not create the quiz right now." },
      { status: 503 },
    );
  }

  return NextResponse.json({ quiz }, { status: 201 });
}
