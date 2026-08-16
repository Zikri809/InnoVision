import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/layout/app-shell";

/**
 * Lecturer area layout: enforces auth + lecturer role, then wraps every
 * lecturer screen in the shared clay app shell. Individual pages no longer
 * render their own headers.
 */
export default async function LecturerLayout({
  children,
}: {
  children: ReactNode;
}) {
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

  // Missing profile (signup trigger race) is transient; let the page render its
  // own retry state rather than redirecting into a cross-role loop.
  if (profile && profile.role !== "lecturer") redirect("/student/classes");

  return (
    <AppShell
      role="lecturer"
      email={user.email ?? ""}
      consentGiven={Boolean(profile?.consent_given_at)}
    >
      {children}
    </AppShell>
  );
}
