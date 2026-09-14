import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStudentQuizOwner } from "@/lib/student-quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { parseImageUpload } from "@/lib/media/server";
import {
  QUESTION_IMAGES_BUCKET,
  MAX_QUESTION_IMAGE_BYTES,
  isOwnedQuestionImagePath,
} from "@/lib/media/validation";
import { checkSameOrigin, internalError, invalidOrigin, notFound, rateLimited } from "@/lib/http";
import { removeStorageObjects } from "@/lib/media/cleanup";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; questionId: string }> };

const IMAGE_RATE = { limit: 20, windowMs: 60 * 60 * 1000 };

/**
 * POST /api/student-quizzes/[id]/questions/[questionId]/image — attach or
 * replace ONE image on a question of the caller's OWN practice quiz. Same
 * byte-handling contract as the lecturer route (route-mediated upload, server
 * sniffing, service-role storage write, replace-after-success ordering).
 * Practice questions have no draft/live machine — attach is allowed any time,
 * but sharing the quiz exposes the image to code-holders (short signed-URL
 * TTL bounds post-unshare residue; plan D13).
 */
export async function POST(request: Request, { params }: Params) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const supabase = await createClient();
  const { id, questionId } = await params;
  if (!isUuid(id) || !isUuid(questionId)) return notFound();

  const owner = await requireStudentQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  if (!rateLimit(`sq-image:${owner.userId}`, IMAGE_RATE)) {
    return rateLimited("Too many image uploads. Try again later.");
  }

  const { data: question } = await supabase
    .from("student_quiz_questions")
    .select("id, image_path")
    .eq("id", questionId)
    .eq("quiz_id", id)
    .maybeSingle();
  if (!question) return notFound();

  const parsed = await parseImageUpload(request, MAX_QUESTION_IMAGE_BYTES);
  if (!parsed.ok) return parsed.response;

  const path = `${owner.userId}/${crypto.randomUUID()}.${parsed.ext}`;
  const admin = createAdminClient();

  const { error: uploadError } = await admin.storage
    .from(QUESTION_IMAGES_BUCKET)
    .upload(path, parsed.buffer, { contentType: parsed.contentType, upsert: false });
  if (uploadError) {
    console.error("practice question image upload error:", uploadError);
    return internalError("Could not store the image right now.");
  }

  const { error: updateError } = await supabase
    .from("student_quiz_questions")
    .update({ image_path: path })
    .eq("id", questionId)
    .eq("quiz_id", id);
  if (updateError) {
    await removeStorageObjects(admin, QUESTION_IMAGES_BUCKET, [path]);
    console.error("practice question image update error:", updateError);
    return internalError("Could not attach the image right now.");
  }

  const oldPath = (question as { image_path: string | null }).image_path;
  if (oldPath && oldPath !== path) {
    // audit-2 C-03: owner-pinned shape gate before the service-role remove —
    // the column is caller-writable at the DB layer, so an attacker-poisoned
    // path must fail closed here (skip + log) instead of deleting cross-
    // tenant bytes.
    if (isOwnedQuestionImagePath(oldPath, owner.userId)) {
      void removeStorageObjects(admin, QUESTION_IMAGES_BUCKET, [oldPath]);
    } else {
      console.error("practice question image replace: refusing malformed old image_path", {
        quizId: id,
        questionId,
      });
    }
  }

  return Response.json(
    { ok: true },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** DELETE — clear column first, then best-effort object removal. */
export async function DELETE(request: Request, { params }: Params) {
  const originError = checkSameOrigin(request);
  if (originError) return invalidOrigin();

  const supabase = await createClient();
  const { id, questionId } = await params;
  if (!isUuid(id) || !isUuid(questionId)) return notFound();

  const owner = await requireStudentQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;

  if (!rateLimit(`sq-image:${owner.userId}`, IMAGE_RATE)) {
    return rateLimited("Too many image updates. Try again later.");
  }

  const { data: question } = await supabase
    .from("student_quiz_questions")
    .select("id, image_path")
    .eq("id", questionId)
    .eq("quiz_id", id)
    .maybeSingle();
  if (!question) return notFound();

  const { error: updateError } = await supabase
    .from("student_quiz_questions")
    .update({ image_path: null })
    .eq("id", questionId)
    .eq("quiz_id", id);
  if (updateError) {
    console.error("practice question image clear error:", updateError);
    return internalError("Could not remove the image right now.");
  }

  const oldPath = (question as { image_path: string | null }).image_path;
  if (oldPath) {
    const admin = createAdminClient();
    // audit-2 C-03: owner-pinned shape gate before the service-role remove
    // (poisoned-column vector). Fail closed: skip + log.
    if (isOwnedQuestionImagePath(oldPath, owner.userId)) {
      void removeStorageObjects(admin, QUESTION_IMAGES_BUCKET, [oldPath]);
    } else {
      console.error("practice question image delete: refusing malformed image_path", {
        quizId: id,
        questionId,
      });
    }
  }

  return Response.json(
    { ok: true },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
