import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UserNav } from "@/components/auth/user-nav";
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

  if (profile.role !== "lecturer") redirect("/student/classes");

  const { data: classes } = await supabase
    .from("classes")
    .select("id, title, join_code, created_at")
    .eq("lecturer_id", user.id)
    .order("created_at", { ascending: false })
    .limit(CLASS_LIST_LIMIT);

  return (
    <>
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="font-semibold">InnoVision</span>
        <UserNav email={user.email ?? ""} consentGiven={Boolean(profile.consent_given_at)} />
      </header>
      <ClassesPageClient classes={classes ?? []} />
    </>
  );
}
