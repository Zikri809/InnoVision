import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { isWellFormedQuestionImagePath, QUESTION_IMAGES_BUCKET } from "@/lib/media/validation";
import { internalError, notFound, rateLimited } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ qid: string }> };

const SIGN_RATE = { limit: 60, windowMs: 60 * 1000 };

/**
 * GET /api/question-images/[qid] — exchange a question id for a short-TTL
 * signed URL, IF AND ONLY IF `resolve_question_image` says the caller may see
 * that image (the single authorization boundary — owner / enrolled+live /
 enrolled+closed+revealed / creator / shared-code-holder; everything else is
 * the same empty result → 404, no oracle).
 *
 * The storage path NEVER crosses to the client beyond this exchange (the
 * signed URL embeds it, unavoidable for <img> rendering). Defense in depth:
 * the path is re-validated against the anchored shape before signing, so a
 * tampered column can never steer the signer outside `question-images`.
 */
export async function GET(_request: Request, { params }: Params) {
  const supabase = await createClient();
  const { qid } = await params;
  if (!isUuid(qid)) return notFound();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return notFound();

  if (!rateLimit(`q-image-sign:${user.id}`, SIGN_RATE)) {
    return rateLimited("Too many image requests. Try again shortly.");
  }

  const { data: resolved, error: rpcError } = await supabase.rpc(
    "resolve_question_image",
    { p_question_id: qid } as unknown as never,
  );
  if (rpcError) {
    console.error("resolve_question_image error:", rpcError);
    return internalError("Could not load the image right now.");
  }

  const row = (resolved as { image_path: string; ttl_seconds: number }[] | null)?.[0];
  if (!row?.image_path) return notFound();

  if (!isWellFormedQuestionImagePath(row.image_path)) {
    console.error("Malformed image_path in database:", row.image_path);
    return notFound();
  }

  // Clamp the RPC-supplied TTL to the sanctioned band — a positive-but-absurd
  // value from a (future) bad code path must not mint long-lived URLs.
  const requestedTtl = Number.isFinite(row.ttl_seconds) ? row.ttl_seconds : 300;
  const ttl = Math.min(3600, Math.max(300, Math.floor(requestedTtl)));
  const admin = createAdminClient();
  const { data: signed, error: signError } = await admin.storage
    .from(QUESTION_IMAGES_BUCKET)
    .createSignedUrl(row.image_path, ttl);

  if (signError || !signed) {
    console.error("createSignedUrl error:", signError);
    // The row points at a missing object — treat exactly like no access.
    return notFound();
  }

  return Response.json(
    { url: signed.signedUrl, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
