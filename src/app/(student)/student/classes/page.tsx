import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { StudentClassesClient } from "./student-classes-client";

const CLASS_LIST_LIMIT = 200;

export default async function StudentClassesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground" role="alert">
          Your profile is still being set up. Please refresh in a moment.
        </p>
      </div>
    );
  }

  if (profile.role !== "student") redirect("/lecturer/classes");

  const { data: classes, error } = await supabase
    .from("student_class_view")
    .select("id, title, created_at")
    .order("created_at", { ascending: false })
    .limit(CLASS_LIST_LIMIT);

  if (error) {
    console.error("Classes fetch error:", error);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load your classes right now. Please refresh.
        </p>
      </div>
    );
  }

  // Live-quiz counts per enrolled class (student_quiz_view exposes only LIVE
  // quizzes from enrolled classes — exactly what the stat tiles should show).
  const classIds = (classes ?? []).map((c) => c.id).filter(Boolean) as string[];
  const countByClass = new Map<string, number>();
  if (classIds.length > 0) {
    const { data: quizRows } = await supabase
      .from("student_quiz_view")
      .select("class_id")
      .in("class_id", classIds);
    for (const q of quizRows ?? []) {
      if (q.class_id) countByClass.set(q.class_id, (countByClass.get(q.class_id) ?? 0) + 1);
    }
  }

  // The view's generated types mark columns nullable (views can't express
  // NOT NULL to the type generator); the underlying classes columns are NOT
  // NULL, so narrow to the non-null shape the client expects.
  const rows = (classes ?? [])
    .filter((c) => c.id && c.title && c.created_at)
    .map((c) => ({
      id: c.id!,
      title: c.title!,
      created_at: c.created_at!,
      quizCount: countByClass.get(c.id!) ?? 0,
    }));

  return <StudentClassesClient classes={rows} />;
}
