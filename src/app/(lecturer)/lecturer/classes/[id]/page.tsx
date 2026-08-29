import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getClassRoster } from "@/lib/classes/roster";
import { ClassDetailClient } from "./class-detail-client";
import { ProfilePendingPanel, LoadErrorPanel } from "@/components/layout/load-state";

export default async function LecturerClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
      <ProfilePendingPanel />
    );
  }
  if (profile.role !== "lecturer") redirect("/student/classes");

  const { data: cls, error: classError } = await supabase
    .from("classes")
    .select("id, title, join_code, created_at, archived_at")
    .eq("id", id)
    .eq("lecturer_id", user.id)
    .maybeSingle();
  if (classError) {
    console.error("Class fetch error:", classError);
    return (
      <LoadErrorPanel />
    );
  }
  if (!cls) notFound();

  const { roster, error: rosterError } = await getClassRoster(supabase, id);
  if (rosterError) {
    console.error("Roster fetch error:", rosterError);
    // Surface a clear transient error state rather than an empty roster.
    return (
      <LoadErrorPanel />
    );
  }

  // Quizzes in this class (owner sees all statuses — RLS scopes to own classes).
  const [{ data: quizzes, error: quizzesError }, { data: ownedClasses, error: ownedClassesError }] =
    await Promise.all([
      supabase
        .from("quizzes")
        .select("id, class_id, title, mode, status, time_limit_sec, created_at")
        .eq("class_id", id)
        .order("created_at", { ascending: false })
        .limit(200),
      // AP-2: duplicate-destination options — every class this lecturer owns.
      supabase
        .from("classes")
        .select("id, title")
        .eq("lecturer_id", user.id)
        .is("archived_at", null)
        .order("created_at", { ascending: true }),
    ]);

  if (quizzesError) {
    console.error("Quizzes fetch error:", quizzesError);
    return (
      <LoadErrorPanel />
    );
  }
  // Non-critical: the duplicate dialog degrades to the current class only.
  if (ownedClassesError) {
    console.error("Owned-classes fetch error:", ownedClassesError);
  }

  return (
    <ClassDetailClient
      cls={cls}
      roster={roster}
      quizzes={quizzes ?? []}
      ownedClasses={ownedClasses ?? []}
    />
  );
}
