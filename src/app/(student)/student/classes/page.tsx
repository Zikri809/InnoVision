import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UserNav } from "@/components/auth/user-nav";
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
    .select("role, consent_given_at")
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

  // The view's generated types mark columns nullable (views can't express
  // NOT NULL to the type generator); the underlying classes columns are NOT
  // NULL, so narrow to the non-null shape the client expects.
  const rows = (classes ?? [])
    .filter((c) => c.id && c.title && c.created_at)
    .map((c) => ({ id: c.id!, title: c.title!, created_at: c.created_at! }));

  return (
    <>
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="font-semibold">InnoVision</span>
        <UserNav email={user.email ?? ""} consentGiven={Boolean(profile.consent_given_at)} />
      </header>
      <StudentClassesClient classes={rows} />
    </>
  );
}
