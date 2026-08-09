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

  const { data: classes } = await supabase
    .from("classes")
    .select("id, title, created_at, class_enrollments!inner(enrolled_at)")
    .eq("class_enrollments.student_id", user.id)
    .order("created_at", { ascending: false })
    .limit(CLASS_LIST_LIMIT);

  return (
    <>
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="font-semibold">InnoVision</span>
        <UserNav email={user.email ?? ""} consentGiven={Boolean(profile.consent_given_at)} />
      </header>
      <StudentClassesClient classes={classes ?? []} />
    </>
  );
}
