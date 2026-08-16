import { createClient } from "@/lib/supabase/server";
import { requireLecturer } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { ExemptSchema } from "@/lib/face/schemas";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import {
  checkSameOrigin,
  firstIssueMessage,
  invalidBody,
  invalidJson,
  internalError,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-user rate limit on lecturer exemptions.
const EXEMPT_RATE = { limit: 10, windowMs: 60 * 1000 };

/**
 * POST /api/sessions/[id]/exempt-face — lecturer exempts a session from face
 * verification (camera-off / persistent-death fallback safety net).
 *
 * Preamble: guard → CSRF → rate-limit → parse → Zod → RPC → `mapFaceError`.
 *
 * Mappings (overrides only):
 *  - `session_not_active` → 409 (common; completed sessions can't be exempted)
 *  - success → 200 `{ sessionStatus: 'active', nextNonce }`
 */
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) {
    return mapFaceError({ error: "not_owner" }) ?? internalError("Something went wrong.");
  }

  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`face-exempt:${auth.userId}`, EXEMPT_RATE)) {
    return mapFaceError({ error: "rate_limited" }) ?? internalError("Something went wrong.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = ExemptSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid exemption payload."));
  }

  const { data, error } = await supabase.rpc("exempt_face_session", {
    p_session_id: id,
    p_reason: parsed.data.reason,
  });

  if (error) {
    console.error("exempt_face_session error:", error);
    return internalError("Could not exempt the session right now.");
  }

  const payload = data as Record<string, unknown> | null;

  const mapped = mapFaceError(payload, {});
  if (mapped) return mapped;

  if (payload && payload.sessionStatus === "active") {
    return Response.json(payload, { status: 200, headers: { "content-type": "application/json" } });
  }

  console.error("exempt_face_session unexpected payload:", payload);
  return internalError("Could not exempt the session right now.");
}
