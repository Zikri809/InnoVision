import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  // Missing profile (signup trigger race) is transient — redirect to the class
  // landing for the default role; that page shows a retry state, avoiding a
  // cross-role redirect loop.
  if (!profile) {
    redirect("/student/classes");
  }

  // Role-aware landing: lecturers go to class management, students to their
  // class list. /dashboard is kept as a thin redirect hub.
  redirect(profile.role === "lecturer" ? "/lecturer/classes" : "/student/classes");
}
