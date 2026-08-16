import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UserNav } from "@/components/auth/user-nav";
import { FaceEnrollClient } from "./face-enroll-client";

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
      <div className="mx-auto max-w-3xl px-4 py-8">
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground" role="alert">
          Your profile is still being set up. Please refresh in a moment.
        </p>
      </div>
    );
  }
  if (profile.role !== "student") redirect("/lecturer/classes");

  return (
    <>
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="font-semibold">InnoVision</span>
        <UserNav email={user.email ?? ""} consentGiven={Boolean(profile.consent_given_at)} />
      </header>
      <FaceEnrollClient
        consentGiven={Boolean(profile.consent_given_at)}
        enrolled={profile.face_enrollment_status === "enrolled"}
      />
    </>
  );
}
