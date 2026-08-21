import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getClassRoster } from "@/lib/classes/roster";
import { ClassDetailClient } from "./class-detail-client";

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
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground" role="alert">
          Your profile is still being set up. Please refresh in a moment.
        </p>
      </div>
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
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load the class right now. Please refresh.
        </p>
      </div>
    );
  }
  if (!cls) notFound();

  const { roster, error: rosterError } = await getClassRoster(supabase, id);
  if (rosterError) {
    console.error("Roster fetch error:", rosterError);
    // Surface a clear transient error state rather than an empty roster.
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load the roster right now. Please refresh.
        </p>
      </div>
    );
  }

  // Quizzes in this class (owner sees all statuses — RLS scopes to own classes).
  const { data: quizzes, error: quizzesError } = await supabase
    .from("quizzes")
    .select("id, title, mode, status, time_limit_sec, created_at")
    .eq("class_id", id)
    .order("created_at", { ascending: false })
    .limit(200);

  if (quizzesError) {
    console.error("Quizzes fetch error:", quizzesError);
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
          Could not load the quizzes right now. Please refresh.
        </p>
      </div>
    );
  }

  return <ClassDetailClient cls={cls} roster={roster} quizzes={quizzes ?? []} />;
}
