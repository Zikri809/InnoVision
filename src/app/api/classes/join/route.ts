import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { normalizeJoinCode } from "@/lib/classes/join-code";
import { rateLimit } from "@/lib/classes/rate-limit";
import { checkSameOrigin } from "@/lib/http";

export const dynamic = "force-dynamic";

// Brute-force guard on join codes: an authenticated user gets a fixed number
// of attempts per window. The RPC is also reachable directly, so this is a
// defense-in-depth layer on top of the DB function (which cannot easily rate
// limit without extra infra). Per-process — adequate at demo scale.
const JOIN_RATE = { limit: 20, windowMs: 60_000 };

/**
 * POST /api/classes/join — student joins a class by join code.
 * Body: { code }. Uses the security-definer RPC `join_class` which is the
 * only enrollment insert path (no direct INSERT policy on class_enrollments).
 *
 * Errors (typed, never a 500):
 *   400 malformed code   → invalid_code (format)
 *   404 unknown code     → invalid_code (not found; generic, no oracle)
 *   409 already enrolled → already_enrolled
 *   403 not a student    → forbidden
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const auth = await requireStudent(supabase);
  if (!auth.ok) return auth.response;

  // CSRF: reject cross-origin joins (AI/session-route precedent).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  // Per-user rate limit (keyed on the authenticated user id).
  if (!rateLimit(`join:${auth.userId}`, JOIN_RATE)) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many join attempts. Try again later." },
      { status: 429 },
    );
  }

  let body: { code?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const normalized = normalizeJoinCode(
    typeof body.code === "string" ? body.code : undefined,
  );
  if (!normalized) {
    return NextResponse.json(
      { error: "invalid_code", message: "That join code is not valid." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc("join_class", {
    code: normalized,
  });

  if (error) {
    // The RPC's typed results (invalid_code / already_enrolled / not_student)
    // arrive as `data`, not `error` — so any error here is a transport/DB
    // outage, not a business rule. Surface 503, never a raw message.
    console.error("join_class RPC error:", error);
    return NextResponse.json(
      { error: "internal", message: "Could not join the class right now." },
      { status: 503 },
    );
  }

  const result = data as
    | { class: { id: string; title: string } }
    | { error: "invalid_code" | "already_enrolled" | "not_student" };

  if ("class" in result && result.class) {
    return NextResponse.json({ class: result.class }, { status: 200 });
  }

  const err = "error" in result ? result.error : "invalid_code";
  switch (err) {
    case "already_enrolled":
      return NextResponse.json(
        { error: "already_enrolled", message: "You are already enrolled in this class." },
        { status: 409 },
      );
    case "not_student":
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    case "invalid_code":
    default:
      return NextResponse.json(
        { error: "invalid_code", message: "That join code is not valid." },
        { status: 404 },
      );
  }
}
