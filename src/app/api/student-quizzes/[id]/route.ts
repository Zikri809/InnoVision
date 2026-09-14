import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { tryCreateAdminClient } from "@/lib/supabase/admin";
import { requireStudentQuizOwner } from "@/lib/student-quizzes/guards";
import { UpdateStudentQuizSchema } from "@/lib/student-quizzes/validation";
import { generateShareCode } from "@/lib/student-quizzes/share-code";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import {
  QUESTION_IMAGES_BUCKET,
  QUIZ_SOURCES_BUCKET,
  isOwnedQuestionImagePath,
  isOwnedQuizSourcePath,
} from "@/lib/media/validation";
import { removeStorageObjects, removeValidatedStoragePrefix } from "@/lib/media/cleanup";
import {
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  notFound,
  rateLimited,
  readCappedJson,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const BODY_LIMIT_BYTES = 64 * 1024;
const PATCH_RATE = { limit: 20, windowMs: 60 * 60 * 1000 };
const SHARE_RATE = { limit: 10, windowMs: 60 * 60 * 1000 };
// audit-3 H3-AUTHZ-F1: DELETE was the ONLY mutating handler in the app with no
// limiter at all. Mirrors the sibling MUTATE_RATE budgets (60/h).
const DELETE_RATE = { limit: 60, windowMs: 60 * 60 * 1000 };
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

  const supabase = await createClient();
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const owner = await requireStudentQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  // audit-3 H3-AUTHZ-F1: the general PATCH budget runs BEFORE the body parse
  // (house ordering — questions/route.ts:46, import-questions/route.ts:79).
  // Parsing first let invalid-body spam cost 3 DB round trips (getUser +
  // profile + quiz) per request while burning no budget. Share actions carry
  // a SECOND, tighter budget checked after the parse below — the coarse gate
  // here is deliberately the looser of the two so a share request is never
  // rejected by it before its own budget is consulted.
  if (!rateLimit(`sq-patch:${owner.userId}`, PATCH_RATE)) {
    return rateLimited("Too many updates. Try again later.");
  }

  const body = await readCappedJson(request, BODY_LIMIT_BYTES);
  if (!body.ok) return body.response;

  const parsed = UpdateStudentQuizSchema.safeParse(body.data);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid update."));
  }

  const { title, description, action } = parsed.data;

  // Share actions get their own tighter budget than plain metadata edits.
  if (action && !rateLimit(`sq-share:${owner.userId}`, SHARE_RATE)) {
    return rateLimited("Too many share updates. Try again later.");
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
 *
 * audit-3 G-F3: the lecturer twin eagerly sweeps the quiz's storage objects;
 * this path did not, so deleting a practice quiz orphaned every attached
 * question image (and, via H3-ATOM-F1's sibling defect, any AI-uploaded
 * `quiz-sources` object — a bucket no cron covers at all). Paths are read
 * BEFORE the delete (questions cascade away with the row) and each one is
 * gated through the owner-pinned contract before the service-role remove().
 */
export async function DELETE(request: Request, { params }: Params) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const supabase = await createClient();
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const owner = await requireStudentQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  // audit-3 H3-AUTHZ-F1: this handler had NO rate limit at all — the only
  // mutating handler in the app without one. Mirror the sibling MUTATE_RATE.
  if (!rateLimit(`sq-delete:${owner.userId}`, DELETE_RATE)) {
    return rateLimited("Too many deletes. Try again later.");
  }

  // Capture storage references BEFORE the cascade (mirrors quizzes/[id]/route.ts).
  const imagePaths: string[] = [];
  const { data: questionRows } = await supabase
    .from("student_quiz_questions")
    .select("image_path")
    .eq("quiz_id", id);
  for (const row of questionRows ?? []) {
    if (!row.image_path) continue;
    if (isOwnedQuestionImagePath(row.image_path, owner.userId)) {
      imagePaths.push(row.image_path);
    } else {
      console.error("student quiz delete: refusing malformed question image_path", { quizId: id });
    }
  }

  const { error } = await supabase
    .from("student_quizzes")
    .delete()
    .eq("id", id)
    .eq("created_by", owner.userId);

  if (error) {
    console.error("Delete student quiz error:", error);
    return internalError("Could not delete the quiz right now.");
  }

  // Best-effort storage sweep (audit-3 G-F3). Cleanup is advisory — the DB
  // row is already gone — so a missing service-role key degrades to "object
  // left for the cron" instead of turning a successful delete into a 500.
  const admin = tryCreateAdminClient();
  if (admin) {
    await removeStorageObjects(admin, QUESTION_IMAGES_BUCKET, imagePaths);
    // Student AI uploads live under `<uid>/<quizId>/` in quiz-sources — a
    // server-constructed prefix with no DB column to read, so sweep it by
    // listing (validated per object). Best-effort + logged.
    await removeValidatedStoragePrefix(
      admin,
      QUIZ_SOURCES_BUCKET,
      `${owner.userId}/${id}`,
      (path) => isOwnedQuizSourcePath(path, owner.userId),
    );
  }

  return NextResponse.json({ ok: true });
}
