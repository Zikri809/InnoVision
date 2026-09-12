import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { normalizeJoinCode } from "@/lib/classes/join-code";
import { rateLimit } from "@/lib/classes/rate-limit";
import { checkSameOrigin, readCappedJson } from "@/lib/http";

export const dynamic = "force-dynamic";

// Brute-force guard on join codes: an authenticated user gets a fixed number
// of attempts per window. The authoritative throttle lives in the DB
// (`class_join_attempts` + join_class lockout — direct PostgREST RPC calls
// are throttled too); this per-process layer is defense-in-depth only.
const JOIN_RATE = { limit: 20, windowMs: 60_000 };

/**
 * POST /api/classes/join — student joins a class by join code.
 * Body: { code }. Uses the security-definer RPC `join_class` which is the
 * only enrollment insert path (no direct INSERT policy on class_enrollments).
 *
 * Errors (typed, never a 500):
 *   400 malformed code   → invalid_code (format)
 *   404 unknown code     → invalid_code (not found; generic, no oracle)
 *   403 matric required  → matric_required (route to /matric-capture)
 *   409 already enrolled → already_enrolled
 *   403 not a student    → forbidden
 *
 * audit-2 M-04: archived classes answer with the SAME 404 invalid_code as
 * unknown codes — the previous distinct 400 class_archived was a code-
 * existence oracle (the alphabet is public; one POST confirmed a guessed
 * code belongs to a real class without enrolling). already_enrolled stays
 * distinct: it is self-information (the caller's own enrollment state), not
 * an oracle.
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

  // audit-1 P1-5: streaming-capped read (no cap here at all before).
  const body = await readCappedJson(request);
  if (!body.ok) return body.response;

  const raw: unknown = body.data;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const rawBody = raw as Record<string, unknown>;
  const normalized = normalizeJoinCode(
    typeof rawBody.code === "string" ? rawBody.code : undefined,
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
    // The RPC's typed results (invalid_code / already_enrolled / not_student / class_archived)
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
    | { error: "invalid_code" | "already_enrolled" | "not_student" | "matric_required" | "class_archived" | "join_locked" };

  // audit-2 L-14 hardening: the typed-never-500 contract holds only if the
  // DB honors the RPC's return shape. A null/primitive payload (transport
  // layer violation) must fold to a typed 503, not `"class" in null` → 500.
  if (!result || typeof result !== "object") {
    console.error("join_class RPC returned a non-object payload:", data);
    return NextResponse.json(
      { error: "internal", message: "Could not join the class right now." },
      { status: 503 },
    );
  }

  if ("class" in result && result.class) {
    return NextResponse.json({ class: result.class }, { status: 200 });
  }

  const err = "error" in result ? result.error : "invalid_code";
  switch (err) {
    case "join_locked":
      return NextResponse.json(
        { error: "join_locked", message: "Too many invalid codes. Try again later." },
        { status: 429 },
      );
    case "already_enrolled":
      return NextResponse.json(
        { error: "already_enrolled", message: "You are already enrolled in this class." },
        { status: 409 },
      );
    case "not_student":
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    case "matric_required":
      // audit-2 H-11: NULL-matric students are refused at the authority (the
      // RPC); the client routes them to the one-time capture page.
      return NextResponse.json(
        { error: "matric_required", message: "Capture your matric number before joining a class." },
        { status: 403 },
      );
    case "class_archived":
      // audit-2 M-04: folded into the unknown-code answer — no existence
      // oracle. (Honest UX cost: an archived class QR says "invalid code".)
      return NextResponse.json(
        { error: "invalid_code", message: "That join code is not valid." },
        { status: 404 },
      );
    case "invalid_code":
    default:
      return NextResponse.json(
        { error: "invalid_code", message: "That join code is not valid." },
        { status: 404 },
      );
  }
}
