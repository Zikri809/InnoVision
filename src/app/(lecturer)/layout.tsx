import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/layout/app-shell";
import { NotificationBell } from "@/components/notifications/notification-bell";
import {
  mapRawRow,
  type NotificationItem,
} from "@/lib/notifications/types";

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

  const [profileRes, listRes, countRes] = await Promise.all([
    supabase.from("profiles").select("role, consent_given_at").eq("id", user.id).maybeSingle(),
    supabase
      .from("notifications")
      .select("id, seq, type, payload, read_at, created_at")
      .order("seq", { ascending: false })
      .limit(20),
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null),
  ]);
  const profile = profileRes.data;

  // Missing profile (signup trigger race) is transient; let the page render its
  // own retry state rather than redirecting into a cross-role loop.
  if (profile && profile.role !== "lecturer") redirect("/student/classes");

  const initialItems: NotificationItem[] = (listRes.data ?? [])
    .map((r) => mapRawRow(r as Parameters<typeof mapRawRow>[0]))
    .filter((x): x is NotificationItem => x !== null);

  return (
    <AppShell
      role="lecturer"
      email={user.email ?? ""}
      consentGiven={Boolean(profile?.consent_given_at)}
      notificationBell={
        <NotificationBell
          userId={user.id}
          role="lecturer"
          initialItems={initialItems}
          initialCount={countRes.count ?? 0}
        />
      }
    >
      {children}
    </AppShell>
  );
}
