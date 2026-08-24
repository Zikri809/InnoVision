import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireStudentQuizOwner } from "@/lib/student-quizzes/guards";
import { UpdateStudentQuizSchema } from "@/lib/student-quizzes/validation";
import { generateShareCode } from "@/lib/student-quizzes/share-code";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import {
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  notFound,
  payloadTooLarge,
  rateLimited,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const BODY_LIMIT_BYTES = 64 * 1024;
const PATCH_RATE = { limit: 20, windowMs: 60 * 60 * 1000 };
const SHARE_RATE = { limit: 10, windowMs: 60 * 60 * 1000 };
const CODE_ATTEMPTS = 3;

/**
 * PATCH /api/student-quizzes/[id] — edit metadata AND/OR run a share action.
 *
 * Share semantics (PLAN D-SQ3 — single source of truth):
 *  - share:     mint a fresh code; idempotent when already shared (returns
 *               the existing code so the creator can always re-copy it).
 *  - unshare:   NULL the code — every existing link stops working immediately.
 *  - regenerate: rotate the code; old links die. Gated on currently-shared.
 */
export async function PATCH(request: Request, { params }: Params) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const lenHeader = request.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > BODY_LIMIT_BYTES) {
    return payloadTooLarge("Request body too large.");
  }

  const supabase = await createClient();
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const owner = await requireStudentQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = UpdateStudentQuizSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid update."));
  }

  const { title, description, action } = parsed.data;

  // Share actions get their own tighter budget than plain metadata edits.
  if (action && !rateLimit(`sq-share:${owner.userId}`, SHARE_RATE)) {
    return rateLimited("Too many share updates. Try again later.");
  }
  if (!action && !rateLimit(`sq-patch:${owner.userId}`, PATCH_RATE)) {
    return rateLimited("Too many updates. Try again later.");
  }

  if (action === "unshare") {
    const { error } = await supabase.rpc("student_quiz_share_action", {
      p_quiz_id: id,
      p_action: "unshare",
    });
    if (error) {
      console.error("Unshare quiz error:", error);
      if ((error.message ?? "").includes("not_owner")) return notFound();
      return internalError("Could not update sharing right now.");
    }
    const { data, error: refetchError } = await supabase
      .from("student_quizzes")
      .select("id, title, description, share_code, created_at, updated_at")
      .eq("id", id)
      .single();
    if (refetchError || !data) {
      console.error("Unshare quiz refetch error:", refetchError);
      return internalError("Could not update sharing right now.");
    }
    return NextResponse.json({ quiz: data });
  }

  if (action === "share" || action === "regenerate") {
    if (action === "regenerate" && !owner.quiz.share_code) {
      return invalidBody("This quiz is not shared yet.");
    }
    if (action === "share" && owner.quiz.share_code) {
      return NextResponse.json({ quiz: owner.quiz });
    }

    // Retry-on-collision against the partial unique index (join-code
    // precedent): fresh codes each attempt, never catch-and-retry inside a
    // transaction. The definer RPC is the ONLY share_code write path.
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      const code = generateShareCode();
      const { error } = await supabase.rpc("student_quiz_share_action", {
        p_quiz_id: id,
        p_action: action,
        p_code: code,
      });

      if (!error) {
        const { data: row, error: refetchError } = await supabase
          .from("student_quizzes")
          .select("id, title, description, share_code, created_at, updated_at")
          .eq("id", id)
          .single();
        if (refetchError || !row) {
          console.error("Share quiz refetch error:", refetchError);
          return internalError("Could not update sharing right now.");
        }
        return NextResponse.json({ quiz: row });
      }

      const msg = error.message ?? "";
      if (msg.includes("code_collision")) continue;
      console.error("Share quiz error:", error);
      if (msg.includes("not_shared")) return invalidBody("This quiz is not shared yet.");
      if (msg.includes("not_owner")) return notFound();
      if (msg.includes("invalid_code") || msg.includes("invalid_action")) {
        return invalidBody("Invalid share request.");
      }
      return internalError("Could not update sharing right now.");
    }
    return internalError("Could not allocate a share code. Try again.");
  }

  const { data, error } = await supabase
    .from("student_quizzes")
    .update({
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description: description ?? null } : {}),
    })
    .eq("id", id)
    .eq("created_by", owner.userId)
    .select("id, title, description, share_code, created_at, updated_at")
    .single();

  if (error) {
    console.error("Update quiz error:", error);
    if ((error.message ?? "").includes("check constraint")) {
      return invalidBody("Invalid quiz data.");
    }
    return internalError("Could not update the quiz right now.");
  }

  return NextResponse.json({ quiz: data });
}

/**
 * DELETE /api/student-quizzes/[id] — delete own quiz (questions cascade).
 */
export async function DELETE(request: Request, { params }: Params) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const supabase = await createClient();
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const owner = await requireStudentQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  const { error } = await supabase
    .from("student_quizzes")
    .delete()
    .eq("id", id)
    .eq("created_by", owner.userId);

  if (error) {
    console.error("Delete student quiz error:", error);
    return internalError("Could not delete the quiz right now.");
  }

  return NextResponse.json({ ok: true });
}
