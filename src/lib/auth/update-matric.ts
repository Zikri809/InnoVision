"use server";

import { createServerActionClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeMatric } from "@/lib/auth/matric";
import { getLocale } from "@/lib/i18n/locale";
import { tFor } from "@/lib/i18n/messages";

export type UpdateMatricResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Profile-modal matric self-edit (students only — the RLS self-update policy
 * requires role='student'; lecturers get a clean failure here too, but the UI
 * never offers them the control).
 *
 * Normalizes + validates via the shared helper (same rules as registration
 * and the 0027 CHECK), pre-checks uniqueness through the service-role client
 * (profiles SELECT is self-only for the RLS client), then updates own row.
 * The matric_no unique index is the race-safe net: a losing race
 * surfaces as PostgREST error code 23505 → friendly "taken" message.
 */
export async function updateMyMatric(rawMatric: string): Promise<UpdateMatricResult> {
  const locale = await getLocale();
  const t = tFor(locale);

  const supabase = await createServerActionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: t("authErrors.sessionExpired") };

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.role !== "student") {
    return { ok: false, error: t("authErrors.studentsOnly") };
  }

  const matric = normalizeMatric(rawMatric ?? "");
  if (!matric.ok) {
    const key =
      matric.reason === "empty"
        ? "authErrors.matricRequired"
        : matric.reason === "reserved"
          ? "authErrors.matricReserved"
          : "authErrors.matricInvalid";
    return { ok: false, error: t(key) };
  }

  const adminProbe = createAdminClient();
  const { data: clash } = await adminProbe
    .from("profiles")
    .select("id")
    .ilike("matric_no", matric.value)
    .neq("id", user.id)
    .limit(1);
  if (clash && clash.length > 0) {
    return { ok: false, error: t("authErrors.matricTaken") };
  }

  const { error } = await supabase
    .from("profiles")
    .update({ matric_no: matric.value })
    .eq("id", user.id);

  if (error) {
    console.error("updateMyMatric failed:", error.message);
    if (/duplicate key|matric_no_unique|23505/i.test(error.message)) {
      return { ok: false, error: t("authErrors.matricTaken") };
    }
    return { ok: false, error: t("authErrors.signupFailed") };
  }

  return { ok: true, value: matric.value };
}
