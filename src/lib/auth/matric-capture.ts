"use server";

import { createServerActionClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/classes/rate-limit";
import { clientIpFromHeaders } from "@/lib/request-ip";
import { normalizeMatric } from "@/lib/auth/matric";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { LOCALE_COOKIE_NAME } from "@/i18n/config";
import { tFor } from "@/lib/i18n/messages";
import type { SupportedLocale } from "@/lib/types/aliases";

const envLimit = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// audit-3 R2-TOP-F5: the budget was 5/min, sized as if each student had a
// distinct egress IP. Classroom NAT shares ONE egress IP, so the first lecture
// onboarding a whole lab would 429 honest students after five captures — the
// same failure login.ts:19-22 already documents ("classroom NAT shares one
// egress IP — the SSO limiter's 60/min precedent"). Match the login-IP
// precedent (30/min): the per-IP cap exists to blunt the existence oracle in
// the service-role pre-check, and the partial unique index stays authoritative
// for correctness, so a looser cap costs no security.
const CAPTURE_RATE = { limit: envLimit("MATRIC_CAPTURE_RATE_LIMIT", 30), windowMs: 60_000 };

export interface MatricCaptureResult {
  error?: string;
}

async function locale(): Promise<SupportedLocale> {
  const cookieStore = await cookies();
  return cookieStore.get(LOCALE_COOKIE_NAME)?.value === "ms" ? "ms" : "en";
}

/**
 * AU-2 — one-time matric capture for OAuth-provisioned students.
 *
 * Password registration captures the matric via signup metadata (0027's
 * handle_new_user trigger); Microsoft SSO users arrive with a profile whose
 * matric_no is NULL and are gated at /matric-capture until they set it. The
 * 0027 contract is enforced server-side HERE (normalizeMatric: exactly 6
 * digits, 99xxxx reserved) — a malformed value must fail before the write,
 * not opaquely at the CHECK constraint.
 *
 * The write is a direct self-update of matric_no: the restricted-columns
 * trigger (0019) blocks only role/consent_given_at, and profiles RLS limits
 * updates to the owner. The partial unique index (matric_no where not null)
 * is the race-safe duplicate net; its violation maps to the SAME friendly
 * "already registered" copy the signup flow uses. The service-role pre-check
 * carries the same residual existence oracle register.ts accepts (blunted by
 * the 30/min NAT-tolerant cap; the unique index stays authoritative).
 */
export async function captureOwnMatric({
  matricNo,
}: {
  matricNo: string;
}): Promise<MatricCaptureResult> {
  const t = tFor(await locale());

  try {
    const hdrs = await headers();
    const ip = clientIpFromHeaders(hdrs);
    if (!rateLimit(`matric-capture:${ip}`, CAPTURE_RATE)) {
      return { error: t("authErrors.tooManyAttempts") };
    }
  } catch {
    // headers() unavailable outside a request scope — never block the flow.
  }

  const matric = normalizeMatric(matricNo ?? "");
  if (matric.ok === false && matric.reason === "empty") {
    return { error: t("authErrors.matricRequired") };
  }
  if (matric.ok === false && matric.reason === "reserved") {
    return { error: t("authErrors.matricReserved") };
  }
  if (!matric.ok) {
    return { error: t("authErrors.matricInvalid") };
  }

  const supabase = await createServerActionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: t("authErrors.sessionExpired") };

  // Role-scoped write: only students may hold a matric (server-side check —
  // never trust the client; the gate page's lecturer bounce is not a guard).
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return { error: t("authErrors.sessionExpired") };
  if (profile.role !== "student") return { error: t("authErrors.studentsOnly") };

  // Duplicate pre-check via the service-role client (register.ts precedent):
  // friendly message instead of an opaque 500 on the unique index.
  // audit-3 A-F5: ADVISORY only — the unique index remains authoritative, and
  // the null-returning accessor keeps an unset SUPABASE_SERVICE_ROLE_KEY from
  // throwing. The throw used to wedge SSO students permanently: the capture
  // page always errored, and (student)/layout.tsx redirects every
  // matric-less student back to it.
  const { tryCreateAdminClient } = await import("@/lib/supabase/admin");
  const admin = tryCreateAdminClient();
  if (admin) {
    const { data: taken } = await admin
      .from("profiles")
      .select("id")
      .ilike("matric_no", matric.value)
      .neq("id", user.id)
      .limit(1);
    if ((taken ?? []).length > 0) {
      return { error: t("authErrors.matricTaken") };
    }
  }

  // audit-2 M-12: set-once is enforced AT THE WRITE — the UPDATE carries
  // `.is("matric_no", null)`, so a concurrent/racing second capture (or any
  // overwrite attempt) matches zero rows instead of silently reassigning an
  // identity. The 0046 DB trigger is the backstop for other callers.
  const { error, count } = await supabase
    .from("profiles")
    .update({ matric_no: matric.value }, { count: "exact" })
    .eq("id", user.id)
    .is("matric_no", null);

  if (error) {
    console.error("captureOwnMatric update error:", error.message);
    // Unique-index race (a concurrent claim between pre-check and update)
    // surfaces as a PostgREST error here.
    if (/duplicate key|matric_no_unique/i.test(error.message)) {
      return { error: t("authErrors.matricTaken") };
    }
    return { error: t("authErrors.matricInvalid") };
  }
  if ((count ?? 0) === 0) {
    // The caller already holds a matric — refuse rather than reassign.
    return { error: t("authErrors.matricAlreadySet") };
  }

  revalidatePath("/matric-capture");
  revalidatePath("/student/classes");
  return {};
}
