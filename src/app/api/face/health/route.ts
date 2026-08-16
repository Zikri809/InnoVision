import { requireUser } from "@/lib/classes/guards";
import { createClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/classes/rate-limit";
import * as compreface from "@/lib/face/server/compreface-client";

export const dynamic = "force-dynamic";

// Health probe is read-only (no CSRF needed); rate-limited to prevent flooding
// the CompreFace health endpoint.
const HEALTH_RATE = { limit: 10, windowMs: 60 * 1000 };

/**
 * GET /api/face/health — CompreFace availability probe.
 *
 * Used by `useFaceTracker` at boot (inside the `FACE_BOOT_TIMEOUT_MS` race):
 * if CompreFace is unreachable, the face pipeline reports `unavailable`
 * (click-first passthrough) instead of attempting verifies that would 503.
 *
 * GET — no CSRF (read-only). Authenticated (either role).
 */
export async function GET() {
  const supabase = await createClient();
  const auth = await requireUser(supabase, "student");
  if (!auth.ok) return auth.response;

  if (!rateLimit(`face-health:${auth.userId}`, HEALTH_RATE)) {
    return Response.json(
      { available: false, rate_limited: true },
      { status: 429, headers: { "content-type": "application/json" } },
    );
  }

  const available = await compreface.health();
  return Response.json(
    { available },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
