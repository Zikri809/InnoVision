import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireLecturer } from "@/lib/classes/guards";
import { createClassWithRetry } from "@/lib/classes/join-code";
import { checkSameOrigin, invalidJson, internalError, unauthorized, forbidden } from "@/lib/http";

export const dynamic = "force-dynamic";

const CLASS_LIST_LIMIT = 200;

/**
 * POST /api/classes — lecturer creates a class (join code auto-generated,
 * retry-on-collision). Body: { title }.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;

  // CSRF: reject cross-origin class creation (AI/session-route precedent).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalidJson();
  }

  const rawBody = body as Record<string, unknown>;
  const title = typeof rawBody.title === "string" ? rawBody.title.trim() : "";
  if (title.length < 1 || title.length > 200) {
    return NextResponse.json(
      { error: "invalid_title", message: "Title must be 1–200 characters." },
      { status: 400 },
    );
  }

  // Use upsert with ignoreDuplicates (equivalent of INSERT ... ON CONFLICT
  // (join_code) DO NOTHING) so the documented contract in join-code.ts holds:
  // a raised unique_violation inside a transaction aborts the whole txn, so we
  // never catch-and-retry. On a collision PostgREST returns 0 rows; with
  // .maybeSingle() that surfaces as { data: null, error: null } → retry with a
  // fresh code. (NB: .single() would turn 0 rows into a PGRST116 *error* and
  // defeat the retry — do not switch back.)
  let result;
  try {
    result = await createClassWithRetry(async (joinCode) => {
      const { data, error } = await supabase
        .from("classes")
        .upsert(
          { title, lecturer_id: auth.userId, join_code: joinCode },
          { onConflict: "join_code", ignoreDuplicates: true },
        )
        .select("id, title, join_code, created_at")
        .maybeSingle();

      if (error) {
        // Non-conflict errors (e.g. Supabase down, DB constraint) are real
        // failures — surface a typed error, don't swallow into a retry loop.
        console.error("Failed to create class:", error);
        throw new Error("class_create_failed");
      }
      return data;
    });
  } catch {
    return internalError("Could not create the class right now.");
  }

  if (!result.ok) {
    return NextResponse.json(
      { error: "join_code_collision", message: "Could not allocate a unique join code. Try again." },
      { status: 409 },
    );
  }

  return NextResponse.json({ class: result.class }, { status: 201 });
}

/**
 * GET /api/classes — list classes visible to the caller:
 *   lecturer → classes they own; student → classes they are enrolled in.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return unauthorized();
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    console.error("Profile fetch error:", profileError);
    return internalError("Could not load profile.");
  }
  if (!profile) {
    return NextResponse.json(
      { error: "profile_unavailable", message: "Your profile is not ready yet. Try again." },
      { status: 503 },
    );
  }

  if (profile.role === "lecturer") {
    const { data, error } = await supabase
      .from("classes")
      .select("id, title, join_code, created_at, archived_at")
      .eq("lecturer_id", user.id)
      .order("created_at", { ascending: false })
      .limit(CLASS_LIST_LIMIT);
    if (error) {
      console.error("Class list error:", error);
      return internalError("Could not load classes.");
    }
    return NextResponse.json({ classes: data ?? [] });
  }

  if (profile.role === "student") {
    // Students read the join_code-free projection view (security audit M-1):
    // `classes` is now owner-only, so direct access can no longer leak
    // join_code/lecturer_id to enrolled students.
    const { data, error } = await supabase
      .from("student_class_view")
      .select("id, title, created_at")
      .order("created_at", { ascending: false })
      .limit(CLASS_LIST_LIMIT);
    if (error) {
      console.error("Class list error:", error);
      return internalError("Could not load classes.");
    }
    return NextResponse.json({ classes: data ?? [] });
  }

  return forbidden();
}
