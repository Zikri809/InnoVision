import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { rateLimit } from "@/lib/classes/rate-limit";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import { SessionIdSchema } from "@/lib/face/schemas";
import { checkSameOrigin, firstIssueMessage, internalError, invalidBody, invalidJson } from "@/lib/http";

export const dynamic = "force-dynamic";

// Per-user rate limit on self-recovery (blink-recovery churn guard).
const SELF_RECOVER_RATE = { limit: 10, windowMs: 60 * 1000 };

/**
 * POST /api/face/self-recover — blink-recovery for a paused session.
 *
 * Preamble: guard → CSRF → rate-limit → parse → Zod → RPC → `mapFaceError`.
 *
 * Mappings (overrides only):
 *  - `flagged` → 403 (lecturer decision only)
 *  - success → 200 `{ sessionStatus: 'active', nextNonce }`
 */
export async function POST(request: Request) {
  const supabase = await createClient();

  const auth = await requireStudent(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`face-self-recover:${auth.userId}`, SELF_RECOVER_RATE)) {
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

  const { data, error } = await supabase.rpc("self_recover_session", {
    p_session_id: sessionId,
  });

  if (error) {
    console.error("self_recover_session error:", error);
    return internalError("Could not recover the session right now.");
  }

  const payload = data as Record<string, unknown> | null;

  const mapped = mapFaceError(payload, {
    flagged: { status: 403 },
  });
  if (mapped) return mapped;

  if (payload && payload.sessionStatus === "active") {
    return Response.json(payload, { status: 200, headers: { "content-type": "application/json" } });
  }

  console.error("self_recover_session unexpected payload:", payload);
  return internalError("Could not recover the session right now.");
}
