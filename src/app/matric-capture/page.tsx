import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { MatricCaptureForm } from "./matric-capture-form";

export const dynamic = "force-dynamic";

/**
 * AU-2 — one-time matric capture gate for OAuth-provisioned students.
 *
 * TOP-LEVEL on purpose: the student layout redirects null-matric students
 * here, so this page must NOT live inside that layout (redirect loop). The
 * layout is the only gate — every student surface requires a matric, so a
 * signed-in student who somehow already HAS one is bounced to the dashboard
 * and a lecturer is bounced to their classes. Unauthenticated visitors go to
 * /login (middleware handles it too; explicit here for defense in depth).
 */
export default async function MatricCapturePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, matric_no")
    .eq("id", user.id)
    .maybeSingle();

  // Profile trigger race → transient; the play page's pending-panel pattern
  // (retry state) is not useful here since nothing else gates on this page.
  if (!profile) redirect("/login");
  if (profile.role !== "student") redirect("/lecturer/classes");
  // Already captured (or a password-registered student stumbling in): done.
  if (profile.matric_no) redirect("/dashboard");

  const t = await getTranslations("auth");

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute -left-10 top-16 h-32 w-32 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-orange-200/50" />
      <div aria-hidden className="pointer-events-none absolute -right-8 bottom-24 h-28 w-28 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-200/50" />

      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <span className="grid h-11 w-11 -rotate-4 place-items-center rounded-2xl bg-primary font-heading text-xl font-bold text-primary-foreground shadow-[0_4px_0_var(--primary-deep)]">
            IV
          </span>
          <span className="font-heading text-2xl font-semibold">InnoVision</span>
        </div>

        <div className="rounded-[28px] border-[3px] border-border bg-card p-8 shadow-[var(--shadow-clay)]">
          <h1 className="font-heading text-2xl font-semibold">{t("matricGateTitle")}</h1>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">
            {t("matricGateSubtitle")}
          </p>
          <MatricCaptureForm />
        </div>
      </div>
    </div>
  );
}
