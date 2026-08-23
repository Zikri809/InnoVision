import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAnyUser } from "@/lib/student-quizzes/guards";
import { normalizeShareCode } from "@/lib/student-quizzes/share-code";
import { rateLimit } from "@/lib/classes/rate-limit";
import { internalError, notFound, rateLimited } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ code: string }> };

const RESOLVE_RATE = { limit: 20, windowMs: 60 * 1000 };
// Best-effort per-IP backstop keyed on account-rotation defense.
const RESOLVE_IP_RATE = { limit: 60, windowMs: 60 * 1000 };

/**
 * GET /api/student-quizzes/shared/[code] — resolve a share code for PLAYING.
 *
 * Authz: any authenticated user (D-SQ6 — matches the RLS SELECT policy, which
 * has no role predicate). Format-rejects BEFORE touching the DB (400);
 * unknown-or-revoked codes are one uniform no-oracle 404. The creator's UUID
 * never leaves the server — only their first name via the definer RPC.
 */
export async function GET(request: Request, { params }: Params) {
  const supabase = await createClient();

  const auth = await requireAnyUser(supabase);
  if (!auth.ok) return auth.response;

  const { code } = await params;
  const normalized = normalizeShareCode(code);
  if (!normalized) {
    // Malformed format is public knowledge; unknown-vs-revoked is not.
    return NextResponse.json(
      { error: "invalid_code", message: "This link is not valid." },
      { status: 400 },
    );
  }

  if (!rateLimit(`sq-resolve:${auth.userId}`, RESOLVE_RATE)) {
    return rateLimited("Too many lookups. Try again in a minute.");
  }
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`sq-resolve-ip:${ip}`, RESOLVE_IP_RATE)) {
    return rateLimited("Too many lookups. Try again in a minute.");
  }

  const { data: quizMeta, error } = await supabase.rpc(
    "resolve_shared_student_quiz",
    { p_code: normalized },
  );

  if (error) {
    console.error("Resolve shared quiz error:", error);
    return internalError("Could not open this quiz right now.");
  }

  // NULL covers BOTH unknown codes and revoked ones — indistinguishable.
  if (!quizMeta) return notFound();

  // Questions come ONLY through the player view (no correct_index /
  // explanation). A zero-question shared quiz is legal; the player UI shows
  // an empty-state message instead of starting.
  const { data: questions, error: qerr } = await supabase
    .from("student_quiz_player_question_view")
    .select("id, quiz_id, order_index, type, prompt, options, created_at")
    .eq("quiz_id", (quizMeta as { id: string }).id)
    .order("order_index")
    .order("created_at");

  if (qerr) {
    console.error("Shared questions fetch error:", qerr);
    return internalError("Could not open this quiz right now.");
  }

  return NextResponse.json({ quiz: quizMeta, questions: questions ?? [] });
}
