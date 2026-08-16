import { createClient } from "@/lib/supabase/server";
import { requireLecturer } from "@/lib/classes/guards";
import { rateLimit } from "@/lib/classes/rate-limit";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import { SessionIdSchema } from "@/lib/face/schemas";
import { checkSameOrigin, firstIssueMessage, internalError, invalidBody, invalidJson } from "@/lib/http";

export const dynamic = "force-dynamic";

// Per-user rate limit on lecturer unlocks.
const UNLOCK_RATE = { limit: 10, windowMs: 60 * 1000 };

/**
 * POST /api/face/unlock — lecturer unlocks a flagged session (the ONLY path
 * out of `flagged`; a student self-recover on flagged is 403).
 *
 * Preamble: guard → CSRF → rate-limit → parse → RPC → `mapFaceError`. No
 * overrides — the common key set covers it (lecturer-only enforcement is
 * in-RPC).
 *
 * success → 200 `{ sessionStatus: 'active', nextNonce }`
 */
export async function POST(request: Request) {
  const supabase = await createClient();

  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`face-unlock:${auth.userId}`, UNLOCK_RATE)) {
    return mapFaceError({ error: "rate_limited" }) ?? internalError("Something went wrong.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }
  const parsed = SessionIdSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "sessionId must be a valid UUID."));
  }
  const sessionId = parsed.data.sessionId;

  const { data, error } = await supabase.rpc("unlock_session", {
    p_session_id: sessionId,
  });

  if (error) {
    console.error("unlock_session error:", error);
    return internalError("Could not unlock the session right now.");
  }

  const payload = data as Record<string, unknown> | null;

  const mapped = mapFaceError(payload, {});
  if (mapped) return mapped;

  if (payload && payload.sessionStatus === "active") {
    return Response.json(payload, { status: 200, headers: { "content-type": "application/json" } });
  }

  console.error("unlock_session unexpected payload:", payload);
  return internalError("Could not unlock the session right now.");
}
