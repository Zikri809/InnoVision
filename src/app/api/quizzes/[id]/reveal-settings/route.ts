import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { RevealSettingsSchema } from "@/lib/quizzes/validation";
import {
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

// Per-user rate limit on settings changes.
const SETTINGS_RATE = { limit: 10, windowMs: 60 * 1000 };

/**
 * PATCH /api/quizzes/[id]/reveal-settings — toggle the assessment auto-reveal
 * flag. Lecturer-only via requireQuizOwner. Allowed on draft AND live quizzes
 * (it is a preference, not a state transition — the quiz_status_transition
 * trigger's metadata edit-lock does not apply to non-immutable-flagged columns,
 * so auto_reveal_on_complete is editable post-publish).
 */
export async function PATCH(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  const rate = owner.userId ? rateLimit(`reveal-settings:${owner.userId}`, SETTINGS_RATE) : false;
  if (!rate) return rateLimited("Too many requests. Try again in a minute.");

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = RevealSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid reveal settings."));
  }

  const { data, error } = await supabase
    .from("quizzes")
    .update({ auto_reveal_on_complete: parsed.data.autoRevealOnComplete })
    .eq("id", id)
    .select("id, auto_reveal_on_complete")
    .maybeSingle();

  if (error) {
    console.error("update reveal-settings error:", error);
    return internalError("Could not update the reveal settings right now.");
  }
  if (!data) return notFound();

  return NextResponse.json(
    { autoRevealOnComplete: data.auto_reveal_on_complete },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}