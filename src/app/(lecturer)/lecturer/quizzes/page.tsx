import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { QuizzesHubClient } from "./quizzes-hub-client";
import { ProfilePendingPanel, LoadErrorPanel } from "@/components/layout/load-state";

const QUIZ_LIST_LIMIT = 500;

export default async function LecturerQuizzesHubPage() {
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

  // Every quiz the lecturer owns across classes (RLS scopes to owner), with
  // the parent class title for tagging. Archived classes are included — the
  // hub is a library; archived rows show a muted class tag.
  const [{ data: quizzes, error: quizzesError }, { data: classes, error: classesError }] =
    await Promise.all([
      supabase
        .from("quizzes")
        .select("id, class_id, title, mode, status, created_at")
        .eq("created_by", user.id)
        .order("created_at", { ascending: false })
        .limit(QUIZ_LIST_LIMIT),
      supabase
        .from("classes")
        .select("id, title, archived_at")
        .eq("lecturer_id", user.id),
    ]);

  if (quizzesError || classesError) {
    console.error("Quizzes hub fetch error:", quizzesError ?? classesError);
    return (
      <LoadErrorPanel />
    );
  }

  const classById = new Map(
    (classes ?? []).map((c) => [c.id, { title: c.title, archived: Boolean(c.archived_at) }]),
  );

  const rows = (quizzes ?? []).map((q) => {
    const cls = q.class_id ? classById.get(q.class_id) : undefined;
    return {
      id: q.id,
      title: q.title,
      mode: q.mode,
      status: q.status,
      createdAt: q.created_at,
      classId: q.class_id ?? null,
      classTitle: cls?.title ?? null,
      classArchived: cls?.archived ?? false,
    };
  });

  return <QuizzesHubClient quizzes={rows} />;
}
