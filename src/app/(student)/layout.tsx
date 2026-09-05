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
 * Student area layout: enforces auth + student role, then wraps every student
 * screen in the shared clay app shell. Individual pages no longer render their
 * own headers.
 */
export default async function StudentLayout({
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
    supabase.from("profiles").select("role, consent_given_at, full_name, matric_no, avatar_path, created_at, face_enrollment_status").eq("id", user.id).maybeSingle(),
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
  if (profile && profile.role !== "student") redirect("/lecturer/classes");

  // AU-2: OAuth-provisioned students arrive with matric_no NULL (password
  // registration and the 0027 backfill always set one). Every student surface
  // is gated behind the one-time capture page — top-level, OUTSIDE this
  // layout, so the redirect cannot loop. Password-registered students always
  // carry a matric and never see the gate.
  if (profile && profile.role === "student" && !profile.matric_no) {
    redirect("/matric-capture");
  }

  const initialItems: NotificationItem[] = (listRes.data ?? [])
    .map((r) => mapRawRow(r as Parameters<typeof mapRawRow>[0]))
    .filter((x): x is NotificationItem => x !== null);

  return (
    <AppShell
      role="student"
      email={user.email ?? ""}
      fullName={profile?.full_name ?? undefined}
      matricNo={profile?.matric_no ?? undefined}
      consentGiven={Boolean(profile?.consent_given_at)}
      avatarPath={profile?.avatar_path ?? null}
      memberSince={profile?.created_at ?? null}
      faceEnrolled={profile?.face_enrollment_status === "enrolled"}
      notificationBell={
        <NotificationBell
          userId={user.id}
          role="student"
          initialItems={initialItems}
          initialCount={countRes.count ?? 0}
        />
      }
    >
      {children}
    </AppShell>
  );
}
