import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireClassOwner, requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { isWellFormedQuestionImagePath, QUESTION_IMAGES_BUCKET } from "@/lib/media/validation";
import {
  checkBodyLimit,
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  invalidJson,
  jsonError,
  notFound,
  rateLimited,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Duplication is the heaviest per-call authoring op (RPC + one storage copy
// per imaged question) — publish/close parity budget.
const DUPLICATE_RATE = { limit: 30, windowMs: 60 * 60 * 1000 };

const DuplicateSchema = z.object({
  destClassId: z.string().uuid("A destination class is required."),
});

const CLASS_ARCHIVED_MESSAGE = "Quizzes cannot be duplicated into an archived class.";

/**
 * POST /api/quizzes/[id]/duplicate — clone a quiz into a FRESH DRAFT (AP-2,
 * PLAN_R_AUTHORING_PRODUCTIVITY).
 *
 * clone_quiz does the atomic quiz+questions copy (destination class may be
 * the source's own class or any other class the lecturer owns; draft/live/
 * closed sources are all allowed — the destination is draft by trigger).
 * The storage-copy phase afterwards duplicates question-image OBJECTS so
 * clones never share storage: question-image DELETE removes the object
 * (image/route.ts), which would break a sharing clone's render. Media
 * posture (ARCHITECTURE §7.12): copies are best-effort — a per-image
 * failure NULLs that clone's image_path (orphan objects are swept by
 * `npm run media:cleanup`), never a broken render or a failed clone.
 */
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) {
    return notFound();
  }

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  // CSRF before the limiter: a cross-origin probe must not burn the
  // duplicate budget (reveal-route rationale).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`quiz-duplicate:${owner.userId}`, DUPLICATE_RATE)) {
    return rateLimited("Too many duplicates. Try again later.");
  }

  const sizeError = checkBodyLimit(request);
  if (sizeError) return sizeError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = DuplicateSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid duplicate payload."));
  }

  // Destination ownership AFTER the source guard, same bare 404 — a
  // non-src-owner learns nothing about which classes exist.
  const dest = await requireClassOwner(supabase, parsed.data.destClassId);
  if (!dest.ok) return dest.response;
  if (dest.archivedAt) {
    return jsonError("class_archived", CLASS_ARCHIVED_MESSAGE, 409);
  }

  const { data: newQuizId, error: rpcError } = await supabase.rpc("clone_quiz", {
    p_src_quiz_id: id,
    p_dest_class_id: parsed.data.destClassId,
  } as never);

  if (rpcError || typeof newQuizId !== "string") {
    const msg = rpcError?.message ?? "";
    console.error("clone_quiz error:", rpcError);
    if (msg.includes("not_quiz_owner") || msg.includes("quiz_not_found") || msg.includes("not_class_owner")) {
      return notFound();
    }
    if (msg.includes("class_archived")) {
      return jsonError("class_archived", CLASS_ARCHIVED_MESSAGE, 409);
    }
    return internalError("Could not duplicate the quiz right now.");
  }

  await duplicateQuestionImages(supabase, owner.userId, newQuizId);

  return NextResponse.json({ quizId: newQuizId }, { status: 201 });
}

/**
 * Copy each cloned question's storage object to a fresh path and point the
 * clone's row at it. The RPC copied image_path verbatim, so until this phase
 * lands the clone transiently references the SOURCE objects (benign
 * same-owner sharing; the sign route degrades a missing object to a clean
 * 404). Failure arms: invalid/unvalidatable source path or copy failure →
 * NULL that clone's image_path; copy succeeded + column UPDATE failed →
 * remove the just-copied object then NULL; any unexpected phase error →
 * NULL every clone row's image_path (fail-closed: images lost on the clone,
 * never dangling).
 */
async function duplicateQuestionImages(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  newQuizId: string,
): Promise<void> {
  try {
    await duplicateQuestionImagesInner(supabase, userId, newQuizId);
  } catch (err) {
    // Fail-closed contract: an unexpected phase error (admin client,
    // randomUUID, …) must NULL every clone row's image_path rather than
    // leave rows referencing objects we can no longer reason about.
    console.error("duplicate image phase error:", err);
    await supabase.from("questions").update({ image_path: null }).eq("quiz_id", newQuizId);
  }
}

async function duplicateQuestionImagesInner(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  newQuizId: string,
): Promise<void> {
  const { data: cloned, error: selectError } = await supabase
    .from("questions")
    .select("id, image_path")
    .eq("quiz_id", newQuizId)
    .not("image_path", "is", null);

  if (selectError) {
    console.error("duplicate image select error:", selectError);
    await supabase.from("questions").update({ image_path: null }).eq("quiz_id", newQuizId);
    return;
  }

  const imaged = (cloned ?? []).filter(
    (question): question is { id: string; image_path: string } =>
      Boolean((question as { image_path: string | null }).image_path),
  );
  if (imaged.length === 0) return;

  const admin = createAdminClient();

  for (const question of imaged) {
    const srcPath = question.image_path;

    const clearPath = async () => {
      await supabase
        .from("questions")
        .update({ image_path: null })
        .eq("id", question.id)
        .eq("quiz_id", newQuizId);
    };

    // House rule: validate the stored path immediately before every
    // privileged storage op — the admin client bypasses all policy.
    if (!isWellFormedQuestionImagePath(srcPath)) {
      await clearPath();
      continue;
    }

    const ext = srcPath.slice(srcPath.lastIndexOf("."));
    const newPath = `${userId}/${crypto.randomUUID()}${ext}`;
    const { error: copyError } = await admin.storage
      .from(QUESTION_IMAGES_BUCKET)
      .copy(srcPath, newPath);

    if (copyError) {
      console.error("question image copy error:", copyError);
      await clearPath();
      continue;
    }

    // Column UPDATE via the USER client (least privilege; RLS re-checks
    // clone ownership) — image-route pattern.
    const { error: updateError } = await supabase
      .from("questions")
      .update({ image_path: newPath })
      .eq("id", question.id)
      .eq("quiz_id", newQuizId);

    if (updateError) {
      console.error("question image copy update error:", updateError);
      // Roll the copied object back immediately (swept-orphan avoidance),
      // then fail closed on the column. Awaited so a serverless freeze can
      // not orphan the just-copied object before removal dispatches.
      await admin.storage.from(QUESTION_IMAGES_BUCKET).remove([newPath]).catch(() => {});
      await clearPath();
    }
  }
}
