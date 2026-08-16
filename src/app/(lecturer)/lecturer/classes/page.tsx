import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ClassesPageClient } from "./classes-client";

const CLASS_LIST_LIMIT = 200;

export default async function LecturerClassesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // maybeSingle: a missing profile (signup trigger race) is transient — show a
  // retry state instead of redirecting to the other role (which would loop).
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

  if (profile.role !== "lecturer") redirect("/student/classes");

  const { data: classes, error } = await supabase
    .from("classes")
    .select("id, title, join_code, created_at")
    .eq("lecturer_id", user.id)
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

  // Quiz counts per class (for the stat tiles + class cards). Lecturer-owned
  // quizzes are RLS-visible to the owner, so a single grouped fetch is enough.
  const classIds = (classes ?? []).map((c) => c.id);
  const countByClass = new Map<string, number>();
  if (classIds.length > 0) {
    const { data: quizRows } = await supabase
      .from("quizzes")
      .select("class_id")
      .in("class_id", classIds);
    for (const q of quizRows ?? []) {
      if (q.class_id) countByClass.set(q.class_id, (countByClass.get(q.class_id) ?? 0) + 1);
    }
  }

  const cards = (classes ?? []).map((c) => ({
    ...c,
    quizCount: countByClass.get(c.id) ?? 0,
  }));

  return <ClassesPageClient classes={cards} />;
}
