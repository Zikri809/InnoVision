import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireQuizOwner } from "@/lib/quizzes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { parseImageUpload } from "@/lib/media/server";
import {
  QUESTION_IMAGES_BUCKET,
  MAX_QUESTION_IMAGE_BYTES,
} from "@/lib/media/validation";
import { checkSameOrigin, internalError, invalidOrigin, notFound, rateLimited, notDraft } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; questionId: string }> };

const IMAGE_RATE = { limit: 20, windowMs: 60 * 60 * 1000 };

/**
 * POST /api/quizzes/[id]/questions/[questionId]/image — attach/replace ONE
 * image (PNG/JPEG/WebP ≤5 MB) to a DRAFT assessment question.
 *
 * Bytes go through THIS route (never browser→storage) so the server sniffs
 * magic bytes and pins the stored content-type; the object lands in the
 * private `question-images` bucket under `${uid}/${uuid}.${ext}` via the
 * service-role client (zero client storage policies — deny-by-default).
 * Replace semantics: new upload FIRST, column UPDATE second, old-object
 * delete best-effort LAST — a failure anywhere leaves either the previous
 * image intact or an orphan object (swept by media-cleanup), never a broken
 * render.
 */
export async function POST(request: Request, { params }: Params) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const supabase = await createClient();
  const { id, questionId } = await params;
  if (!isUuid(id) || !isUuid(questionId)) return notFound();

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;
  if (owner.quiz.status !== "draft") return notDraft();

  if (!rateLimit(`q-image:${owner.userId}`, IMAGE_RATE)) {
    return rateLimited("Too many image uploads. Try again later.");
  }

  // Question must belong to THIS quiz (RLS: lecturer-of-quiz only; students
  // have zero access). Missing or foreign → same 404.
  const { data: question } = await supabase
    .from("questions")
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
    console.error("question image upload error:", uploadError);
    return internalError("Could not store the image right now.");
  }

  const { error: updateError } = await supabase
    .from("questions")
    .update({ image_path: path })
    .eq("id", questionId)
    .eq("quiz_id", id);
  if (updateError) {
    // Column unchanged → roll the orphan back immediately.
    await admin.storage.from(QUESTION_IMAGES_BUCKET).remove([path]).catch(() => {});
    console.error("question image update error:", updateError);
    return internalError("Could not attach the image right now.");
  }

  const oldPath = (question as { image_path: string | null }).image_path;
  if (oldPath && oldPath !== path) {
    // Only AFTER the new state is durable. Failure mode = swept orphan.
    void admin.storage.from(QUESTION_IMAGES_BUCKET).remove([oldPath]).catch(() => {});
  }

  return Response.json(
    { ok: true },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * DELETE — clear the column FIRST, then remove the object best-effort
 * (failure mode = swept orphan, never a dangling pointer).
 */
export async function DELETE(request: Request, { params }: Params) {
  const originError = checkSameOrigin(request);
  if (originError) return invalidOrigin();

  const supabase = await createClient();
  const { id, questionId } = await params;
  if (!isUuid(id) || !isUuid(questionId)) return notFound();

  const owner = await requireQuizOwner(supabase, id);
  if (!owner.ok) return owner.response;
  if (owner.quiz.status !== "draft") return notDraft();

  if (!rateLimit(`q-image:${owner.userId}`, IMAGE_RATE)) {
    return rateLimited("Too many image updates. Try again later.");
  }

  const { data: question } = await supabase
    .from("questions")
    .select("id, image_path")
    .eq("id", questionId)
    .eq("quiz_id", id)
    .maybeSingle();
  if (!question) return notFound();

  const { error: updateError } = await supabase
    .from("questions")
    .update({ image_path: null })
    .eq("id", questionId)
    .eq("quiz_id", id);
  if (updateError) {
    console.error("question image clear error:", updateError);
    return internalError("Could not remove the image right now.");
  }

  const oldPath = (question as { image_path: string | null }).image_path;
  if (oldPath) {
    const admin = createAdminClient();
    // Best-effort: a failed object delete leaves a swept orphan, not an error.
    void admin.storage.from(QUESTION_IMAGES_BUCKET).remove([oldPath]).catch(() => {});
  }

  return Response.json(
    { ok: true },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
