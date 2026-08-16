import { createClient } from "@/lib/supabase/server";
import { requireLecturer } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import { checkSameOrigin, internalError, notFound } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-user rate limit on lecturer session resets.
const RESET_RATE = { limit: 10, windowMs: 60 * 1000 };

/**
 * DELETE /api/sessions/[id]/reset — lecturer deletes an assessment session
 * (supervisor fallback for a dead laptop / glitched submit).
 *
 * Session writes are RPC-only; this route ONLY guards/CSRF/rate-limits and
 * maps. `mapFaceError`'s common keys auto-cover `not_owner`→404 (identity:
 * non-existent and not-owned are indistinguishable — no oracle),
 * `not_lecturer`→403, `not_assessment`→400.
 *
 * No body → no Zod. The `if (error)` guard + the `payload.ok === true`
 * shape-assert guarantee a failed reset can never return a false `200 {ok:true}`
 * (a transport/RPC-raise → 503, never a raw message).
 *
 * success → 200 `{ ok, deleted_session_id, student_id, quiz_id }`
 */
export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(_request);
  if (originError) return originError;

  if (!rateLimit(`session-reset:${auth.userId}`, RESET_RATE)) {
    // mapFaceError never returns null for a known key; the fallback satisfies
    // the mapper's nullable signature (sibling-route convention).
    return mapFaceError({ error: "rate_limited" }) ?? internalError("Something went wrong.");
  }

  const { data, error } = await supabase.rpc("reset_session", {
    p_session_id: id,
  });

  if (error) {
    console.error("reset_session error:", error);
    return internalError("Could not reset the session right now.");
  }

  const payload = data as Record<string, unknown> | null;

  const mapped = mapFaceError(payload, {});
  if (mapped) return mapped;

  // Shape-assert success: anything without `ok === true` is not a successful
  // reset — mapped to 503 (never a silent 200 on a partially-failed RPC).
  if (payload?.ok === true) {
    return Response.json(payload, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  console.error("reset_session unexpected payload:", payload);
  return internalError("Could not reset the session right now.");
}