import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ClassesPageClient } from "./classes-client";
import { ProfilePendingPanel, LoadErrorPanel } from "@/components/layout/load-state";

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
      <ProfilePendingPanel />
    );
  }

  if (profile.role !== "lecturer") redirect("/student/classes");

  // Fetch only active classes for the main dashboard
  const { data: classes, error } = await supabase
    .from("classes")
    .select("id, title, join_code, created_at, archived_at")
    .eq("lecturer_id", user.id)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(CLASS_LIST_LIMIT);

  if (error) {
    console.error("Classes fetch error:", error);
    return (
      <LoadErrorPanel />
    );
  }

  // Fast count query for archived classes (used by the header action pill & hero stat)
  const { count: archivedCount } = await supabase
    .from("classes")
    .select("id", { count: "exact", head: true })
    .eq("lecturer_id", user.id)
    .not("archived_at", "is", null);

  // Quiz counts per class (for the stat tiles + class cards). Lecturer-owned
  // quizzes are RLS-visible to the owner, so a single grouped fetch is enough.
  const classIds = (classes ?? []).map((c) => c.id);
  const countByClass = new Map<string, number>();
  if (classIds.length > 0) {
    const { data: quizRows } = await supabase
      .from("quizzes")
      .select("class_id")
      .in("class_id", classIds)
      .limit(10_000);
    for (const q of quizRows ?? []) {
      if (q.class_id) countByClass.set(q.class_id, (countByClass.get(q.class_id) ?? 0) + 1);
    }
  }

  const cards = (classes ?? []).map((c) => ({
    ...c,
    quizCount: countByClass.get(c.id) ?? 0,
  }));

  return <ClassesPageClient classes={cards} archivedCount={archivedCount ?? 0} />;
}
