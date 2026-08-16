import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import { checkSameOrigin, internalError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-user rate limit on face-unavailable reports.
const UNAVAILABLE_RATE = { limit: 10, windowMs: 60 * 1000 };

/**
 * POST /api/sessions/[id]/face-unavailable — record that face tracking is
 * unavailable (camera denied / models offline). Idempotent (set-if-null), so
 * the risk-7 gap is lecturer-visible via `face_unavailable_at` on GET.
 *
 * Preamble: guard → CSRF → rate-limit → RPC → `mapFaceError`.
 *
 * success → 200 `{ ok: true }`
 */
export async function POST(_request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) {
    return mapFaceError({ error: "not_owner" }) ?? internalError("Something went wrong.");
  }

  const auth = await requireStudent(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(_request);
  if (originError) return originError;

  if (!rateLimit(`face-unavailable:${auth.userId}`, UNAVAILABLE_RATE)) {
    return mapFaceError({ error: "rate_limited" }) ?? internalError("Something went wrong.");
  }

  const { data, error } = await supabase.rpc("report_face_unavailable", {
    p_session_id: id,
  });

  if (error) {
    console.error("report_face_unavailable error:", error);
    return internalError("Could not record camera status right now.");
  }

  const payload = data as Record<string, unknown> | null;

  const mapped = mapFaceError(payload, {});
  if (mapped) return mapped;

  if (payload?.ok === true) {
    return Response.json({ ok: true }, { status: 200, headers: { "content-type": "application/json" } });
  }

  console.error("report_face_unavailable unexpected payload:", payload);
  return internalError("Could not record camera status right now.");
}
