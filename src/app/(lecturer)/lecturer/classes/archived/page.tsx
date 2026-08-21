import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ArchivedClassesClient } from "./archived-classes-client";

const ARCHIVED_LIST_LIMIT = 200;

export default async function LecturerArchivedClassesPage() {
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
        <p className="rounded-2xl border-[3px] border-dashed border-border bg-card/60 p-8 text-center text-sm font-semibold text-muted-foreground" role="alert">
          Your profile is still being set up. Please refresh in a moment.
        </p>
      </div>
    );
  }

  if (profile.role !== "lecturer") redirect("/student/classes");

  // Fetch only archived classes for this lecturer
  const { data: classes, error } = await supabase
    .from("classes")
    .select("id, title, join_code, created_at, archived_at")
    .eq("lecturer_id", user.id)
    .not("archived_at", "is", null)
    .order("archived_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(ARCHIVED_LIST_LIMIT);

  if (error) {
    console.error("Archived classes fetch error:", error);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 p-4 text-sm font-bold text-destructive" role="alert">
          Could not load archived classes right now. Please refresh.
        </p>
      </div>
    );
  }

  // Quiz count aggregation scoped strictly to archived classes
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

  return <ArchivedClassesClient classes={cards} />;
}
