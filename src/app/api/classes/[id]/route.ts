import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireLecturer } from "@/lib/classes/guards";
import { rateLimit } from "@/lib/classes/rate-limit";
import { getClassRoster, isUuid } from "@/lib/classes/roster";
import {
  checkBodyLimit,
  checkSameOrigin,
  internalError,
  invalidJson,
  notFound,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Per-lecturer mutation budget (student-surface parity; abuse bound).
const MUTATE_RATE = { limit: 60, windowMs: 60 * 60 * 1000 };

/**
 * GET /api/classes/[id]
 *   lecturer owner → full detail + roster (enrolled students' profiles);
 *   enrolled student → class title only (no roster, no join_code);
 *   anyone else (unenrolled student, non-owner lecturer) → 404 (no oracle).
 */
export async function GET(_request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) {
    console.error("Profile fetch error:", profileError);
    return internalError("Could not complete the request right now.");
  }
  if (!profile) {
    return NextResponse.json(
      { error: "profile_unavailable", message: "Your profile is not ready yet. Try again." },
      { status: 503 },
    );
  }

  if (profile.role === "lecturer") {
    // Owner-filtered fetch so a non-owner never sees the join_code.
    const { data: cls, error } = await supabase
      .from("classes")
      .select("id, title, join_code, created_at, archived_at")
      .eq("id", id)
      .eq("lecturer_id", user.id)
      .maybeSingle();
    if (error) {
      console.error("Class fetch error:", error);
      return internalError("Could not complete the request right now.");
    }
    if (!cls) return notFound();

    const { roster, error: rosterError } = await getClassRoster(supabase, id);
    if (rosterError) {
      console.error("Roster fetch error:", rosterError);
      return internalError("Could not complete the request right now.");
    }

    return NextResponse.json({
      class: {
        id: cls.id,
        title: cls.title,
        join_code: cls.join_code,
        created_at: cls.created_at,
        archived_at: cls.archived_at,
      },
      roster,
    });
  }

  // Student: enrolled → title only (never join_code or roster). An unenrolled
  // student gets 404 (the same as a non-existent class) — no title leak, no
  // enrollment oracle. Reads the join_code-free projection view (M-1); the
  // view's is_enrolled_in_class() filter means a non-enrolled student gets no
  // row → 404.
  const { data: enrolled, error } = await supabase
    .from("student_class_view")
    .select("id, title")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("Class fetch error:", error);
    return internalError("Could not complete the request right now.");
  }
  if (!enrolled) return notFound();

  return NextResponse.json({ class: { id: enrolled.id, title: enrolled.title } });
}

/**
 * PATCH /api/classes/[id] — update title or archive/restore (owner only).
 * Body: { title?: string, archived?: boolean }
 */
export async function PATCH(request: Request, { params }: Params) {
  const supabase = await createClient();
  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  // CSRF: reject cross-origin renames/archives (AI/session-route precedent).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`class-mutate:${auth.userId}`, MUTATE_RATE)) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many updates. Try again later." },
      { status: 429 },
    );
  }

  const sizeError = checkBodyLimit(request);
  if (sizeError) return sizeError;

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
  const updatePayload: { title?: string; archived_at?: string | null } = {};

  if ("title" in rawBody) {
    const title = typeof rawBody.title === "string" ? rawBody.title.trim() : "";
    if (title.length < 1 || title.length > 200) {
      return NextResponse.json(
        { error: "invalid_title", message: "Title must be 1–200 characters." },
        { status: 400 },
      );
    }
    updatePayload.title = title;
  }

  if ("archived" in rawBody) {
    if (typeof rawBody.archived !== "boolean") {
      return NextResponse.json(
        { error: "invalid_archived", message: "Archived field must be a boolean." },
        { status: 400 },
      );
    }
    updatePayload.archived_at = rawBody.archived ? new Date().toISOString() : null;
  }

  if (Object.keys(updatePayload).length === 0) {
    return NextResponse.json(
      { error: "empty_update", message: "No valid fields provided to update." },
      { status: 400 },
    );
  }

  // Owner-filtered update: RLS is the backstop; the filter makes not-found vs
  // forbidden distinguishable.
  const { data, error } = await supabase
    .from("classes")
    .update(updatePayload)
    .eq("id", id)
    .eq("lecturer_id", auth.userId)
    .select("id, title, join_code, created_at, archived_at")
    .maybeSingle();
  if (error) {
    console.error("Class update error:", error);
    return internalError("Could not complete the request right now.");
  }
  if (!data) return notFound();

  return NextResponse.json({ class: data });
}

/**
 * DELETE /api/classes/[id] — soft delete (archive) class by default (owner only).
 */
export async function DELETE(request: Request, { params }: Params) {
  const supabase = await createClient();
  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  // CSRF: reject cross-origin class deletion (AI/session-route precedent).
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`class-mutate:${auth.userId}`, MUTATE_RATE)) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many updates. Try again later." },
      { status: 429 },
    );
  }

  const { data, error } = await supabase
    .from("classes")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .eq("lecturer_id", auth.userId)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("Class archive/delete error:", error);
    return internalError("Could not complete the request right now.");
  }
  if (!data) return notFound();

  return NextResponse.json({ ok: true, archived: true });
}
