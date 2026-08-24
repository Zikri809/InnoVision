import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { FaceEnrollClient } from "./face-enroll-client";
import { ProfilePendingPanel } from "@/components/layout/load-state";

/**
 * Face enrollment page — student-only. Shows consent recap + checkbox when
 * consent is null, blink liveness, and a guided 3-angle capture (front, left,
 * right — CompreFace migration). POSTs `{ frames: [front, left, right] }`;
 * server-side pose validation + duplicate-identity detection. Redirects back
 * to the student quizzes list (or shows the pending-review surface).
 *
 * "Revoke consent" action whose copy states the mid-assessment consequence
 * (in-progress sessions get flagged; re-consent does NOT un-flag).
 */
export default async function FaceEnrollPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, consent_given_at, face_enrollment_status")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile) {
    return (
      <ProfilePendingPanel />
    );
  }
  if (profile.role !== "student") redirect("/lecturer/classes");

  return (
    <FaceEnrollClient
      consentGiven={Boolean(profile.consent_given_at)}
      enrolled={profile.face_enrollment_status === "enrolled"}
    />
  );
}
