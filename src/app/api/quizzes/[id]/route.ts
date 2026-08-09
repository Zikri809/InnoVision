import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { UpdateQuizSchema } from "@/lib/quizzes/validation";
import {
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  notDraft,
  notFound,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/quizzes/[id] — rename / change mode / change time limit.
 * Draft-only (a live/closed quiz is immutable). Owner only.
 */
export async function PATCH(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) {
    return notFound();
  }

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;
  if (owner.quiz.status !== "draft") return notDraft();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = UpdateQuizSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid quiz data."));
  }

  // UpdateQuizSchema has NO defaults (see validation.ts), so an empty body
  // parses to {} and this guard is reachable — it is not dead code.
  const { title, mode, timeLimitSec } = parsed.data;
  if (title === undefined && mode === undefined && timeLimitSec === undefined) {
    return invalidBody("No editable fields provided.");
  }

  // Build the update from the keys the caller actually supplied. A PATCH that
  // only renames (or only changes the time limit) must NOT rewrite `mode`.
  const updates: {
    title?: string;
    mode?: "practice" | "assessment";
    time_limit_sec?: number | null;
  } = {};
  if (title !== undefined) updates.title = title;
  if (mode !== undefined) updates.mode = mode;
  if (timeLimitSec !== undefined) updates.time_limit_sec = timeLimitSec;

  const { data: quiz, error } = await supabase
    .from("quizzes")
    .update(updates)
    .eq("id", id)
    .select("id, class_id, title, mode, status, time_limit_sec, created_at")
    .single();

  if (error) {
    console.error("Update quiz error:", error);
    return internalError("Could not update the quiz right now.");
  }

  return NextResponse.json({ quiz });
}

/**
 * DELETE /api/quizzes/[id] — owner only. Cascades questions.
 * (P5+ adds a "block when sessions exist" guard — no sessions exist yet.)
 */
export async function DELETE(_request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) {
    return notFound();
  }

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  const { error } = await supabase.from("quizzes").delete().eq("id", id);
  if (error) {
    console.error("Delete quiz error:", error);
    return internalError("Could not delete the quiz right now.");
  }

  return NextResponse.json({ ok: true });
}
