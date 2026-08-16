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

  return <ClassesPageClient classes={classes ?? []} />;
}
