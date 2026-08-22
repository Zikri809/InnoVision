import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import { z } from "zod";
import { checkSameOrigin, internalError, invalidBody, invalidJson } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-user rate limit on pauses (coalesced per episode — 20/min is generous).
const PAUSE_RATE = { limit: 20, windowMs: 60 * 1000 };

const PauseSchema = z.object({
  reason: z.enum(["hand_loss", "focus_lost"]).default("hand_loss"),
});

/**
 * POST /api/sessions/[id]/pause — server-side pause (P7 + integrity suite).
 *
 * Moves client-only pauses INTO the server state machine:
 * `active` → `paused` (idempotent), assessment only, owner only. A
 * re-shown hand / refocused window can't answer a server-paused session
 * before blink-recovery.
 *
 * `reason: 'focus_lost'` additionally accumulates `focus_pause_count`; the
 * RPC FLAGS the session at the threshold (3) — a lecturer decision — and
 * audits it. The response's `sessionStatus` is authoritative.
 *
 * Preamble: guard → CSRF → rate-limit → RPC → `mapFaceError`.
 *
 * success → 200 `{ sessionStatus: 'paused' | 'flagged' }`
 */
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) {
    return mapFaceError({ error: "not_owner" }) ?? internalError("Something went wrong.");
  }

  const auth = await requireStudent(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`pause:${auth.userId}`, PAUSE_RATE)) {
    return mapFaceError({ error: "rate_limited" }) ?? internalError("Something went wrong.");
  }

  // Body is OPTIONAL: the hand-loss client sends `{}`, the focus-loss client
  // sends `{reason:'focus_lost'}`, and an empty body defaults to hand_loss.
  // (Read via text() — Request.content-length is unreliable across runtimes.)
  let reason = "hand_loss";
  const text = await request.text();
  if (text.trim().length > 0) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return invalidJson();
    }
    const parsed = PauseSchema.safeParse(body);
    if (!parsed.success) {
      return invalidBody("reason must be 'hand_loss' or 'focus_lost'.");
    }
    reason = parsed.data.reason;
  }

  const { data, error } = await supabase.rpc("pause_session", {
    p_session_id: id,
    p_reason: reason,
  });

  if (error) {
    console.error("pause_session error:", error);
    return internalError("Could not pause the session right now.");
  }

  const payload = data as Record<string, unknown> | null;

  const mapped = mapFaceError(payload, {});
  if (mapped) return mapped;

  if (
    payload?.sessionStatus === "paused" ||
    payload?.sessionStatus === "flagged"
  ) {
    return Response.json(
      { sessionStatus: payload.sessionStatus },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  console.error("pause_session unexpected payload:", payload);
  return internalError("Could not pause the session right now.");
}
