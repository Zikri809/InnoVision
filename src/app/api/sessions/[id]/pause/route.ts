import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import { checkSameOrigin, internalError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-user rate limit on pauses (coalesced per episode — 20/min is generous).
const PAUSE_RATE = { limit: 20, windowMs: 60 * 1000 };

/**
 * POST /api/sessions/[id]/pause — server-side hand-loss pause (P7).
 *
 * Moves the P6 client-only hand-loss pause INTO the server state machine:
 * `active` → `paused` (idempotent), assessment only, owner only. No audit
 * (transient). A re-shown hand can't answer a server-paused session before
 * blink-recovery.
 *
 * Preamble: guard → CSRF → rate-limit → RPC → `mapFaceError`.
 *
 * success → 200 `{ sessionStatus: 'paused' }`
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

  if (!rateLimit(`pause:${auth.userId}`, PAUSE_RATE)) {
    return mapFaceError({ error: "rate_limited" }) ?? internalError("Something went wrong.");
  }

  const { data, error } = await supabase.rpc("pause_session", {
    p_session_id: id,
  });

  if (error) {
    console.error("pause_session error:", error);
    return internalError("Could not pause the session right now.");
  }

  const payload = data as Record<string, unknown> | null;

  const mapped = mapFaceError(payload, {});
  if (mapped) return mapped;

  if (payload?.sessionStatus === "paused") {
    return Response.json(
      { sessionStatus: "paused" },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  console.error("pause_session unexpected payload:", payload);
  return internalError("Could not pause the session right now.");
}
