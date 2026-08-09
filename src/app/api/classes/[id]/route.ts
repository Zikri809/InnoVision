import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireLecturer } from "@/lib/classes/guards";
import { getClassRoster, isUuid } from "@/lib/classes/roster";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

async function invalidId(): Promise<Response> {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

/**
 * GET /api/classes/[id]
 *   lecturer owner → full detail + roster (enrolled students' profiles);
 *   enrolled student → class title only (no roster, no join_code);
 *   anyone else (unenrolled student, non-owner lecturer) → 404 (no oracle).
 */
export async function GET(_request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) return invalidId();

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
    return NextResponse.json({ error: "internal" }, { status: 503 });
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
      .select("id, title, join_code, created_at")
      .eq("id", id)
      .eq("lecturer_id", user.id)
      .maybeSingle();
    if (error) {
      console.error("Class fetch error:", error);
      return NextResponse.json({ error: "internal" }, { status: 503 });
    }
    if (!cls) return invalidId();

    const { roster, error: rosterError } = await getClassRoster(supabase, id);
    if (rosterError) {
      console.error("Roster fetch error:", rosterError);
      return NextResponse.json({ error: "internal" }, { status: 503 });
    }

    return NextResponse.json({
      class: { id: cls.id, title: cls.title, join_code: cls.join_code, created_at: cls.created_at },
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
    return NextResponse.json({ error: "internal" }, { status: 503 });
  }
  if (!enrolled) return invalidId();

  return NextResponse.json({ class: { id: enrolled.id, title: enrolled.title } });
}

/**
 * PATCH /api/classes/[id] — rename (owner only).
 */
export async function PATCH(request: Request, { params }: Params) {
  const supabase = await createClient();
  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  if (!isUuid(id)) return invalidId();

  let body: { title?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length < 1 || title.length > 200) {
    return NextResponse.json(
      { error: "invalid_title", message: "Title must be 1–200 characters." },
      { status: 400 },
    );
  }

  // Owner-filtered update: RLS is the backstop; the filter makes not-found vs
  // forbidden distinguishable.
  const { data, error } = await supabase
    .from("classes")
    .update({ title })
    .eq("id", id)
    .eq("lecturer_id", auth.userId)
    .select("id, title, join_code, created_at")
    .maybeSingle();
  if (error) {
    console.error("Class update error:", error);
    return NextResponse.json({ error: "internal" }, { status: 503 });
  }
  if (!data) return invalidId();

  return NextResponse.json({ class: data });
}

/**
 * DELETE /api/classes/[id] — owner only; cascades enrollments (and, later, quizzes).
 */
export async function DELETE(_request: Request, { params }: Params) {
  const supabase = await createClient();
  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  if (!isUuid(id)) return invalidId();

  const { data, error } = await supabase
    .from("classes")
    .delete()
    .eq("id", id)
    .eq("lecturer_id", auth.userId)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("Class delete error:", error);
    return NextResponse.json({ error: "internal" }, { status: 503 });
  }
  if (!data) return invalidId();

  return NextResponse.json({ ok: true });
}
