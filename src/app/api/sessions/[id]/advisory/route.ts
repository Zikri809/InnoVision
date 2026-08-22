import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import { z } from "zod";
import {
  checkSameOrigin,
  firstIssueMessage,
  invalidBody,
  invalidJson,
  internalError,
  notFound,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-user rate limit. Client-side throttling keeps real traffic near
// 1 report/type/minute; the limit only bounds abuse.
const ADVISORY_RATE = { limit: 10, windowMs: 60 * 1000 };

const AdvisorySchema = z.object({
  type: z.enum(["second_face", "looked_away", "voice_activity", "headset_active"]),
});

/**
 * POST /api/sessions/[id]/advisory — record a lecturer-visible integrity
 * advisory (never a status change).
 *
 * The RPC upserts on (session_id, adv_type), accumulating occurrences +
 * last_seen_at — repeated reports of one type strengthen the signal without
 * growing rows.
 *
 * success → 200 `{ ok: true }`
 */
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  const auth = await requireStudent(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`session-advisory:${auth.userId}`, ADVISORY_RATE)) {
    return mapFaceError({ error: "rate_limited" }) ?? internalError("Something went wrong.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = AdvisorySchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid advisory payload."));
  }

  const { data, error } = await supabase.rpc("report_session_advisory", {
    p_session_id: id,
    p_type: parsed.data.type,
  });

  if (error) {
    console.error("report_session_advisory error:", error);
    return internalError("Could not record the advisory right now.");
  }

  const payload = data as Record<string, unknown> | null;

  const mapped = mapFaceError(payload, {});
  if (mapped) return mapped;

  if (payload?.ok === true) {
    return Response.json(
      { ok: true },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  console.error("report_session_advisory unexpected payload:", payload);
  return internalError("Could not record the advisory right now.");
}
