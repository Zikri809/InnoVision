import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { normalizeJoinCode } from "@/lib/classes/join-code";
import { JoinConfirmClient } from "./join-confirm-client";

/**
 * /join/[code] — the QR-code scan target for class enrollment.
 *
 * TOP-LEVEL on purpose (the /matric-capture pattern): it must render for
 * authenticated users of both roles and — via the middleware — bounce
 * anonymous scanners into the login wall with the join target preserved.
 *
 * Middleware contract (do NOT "fix" either side):
 *   • /join is deliberately NOT in PUBLIC_ROUTES — that is what makes the
 *     anonymous bounce happen (middleware.ts appends redirect=<pathname>).
 *   • It must also never BE a public route: shouldBounceAuthenticated would
 *     then bounce LOGGED-IN users from here to /dashboard, destroying the
 *     lecturer and student branches below.
 *
 * No-oracle rule: this page performs ZERO class lookups by code — no title
 * fetch, no existence probe. The API (/api/classes/join) is the sole
 * authority on code validity; the confirm card shows the code, and the
 * class title arrives only inside the join response.
 */

async function NeutralCard({ message, href, cta }: { message: string; href: string; cta: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="flex max-w-sm flex-col items-center gap-4 rounded-2xl border-[3px] border-border bg-card p-6 text-center shadow-[var(--shadow-clay-sm)]">
        <p className="font-heading text-lg font-semibold [text-wrap:balance]">{message}</p>
        <Link
          href={href}
          className="rounded-2xl border-[3px] border-border bg-card px-5 py-2.5 text-sm font-extrabold shadow-[0_4px_0_var(--border)]"
        >
          {cta}
        </Link>
      </div>
    </div>
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("join");
  return { title: `${t("confirmTitle")} — InnoVision` };
}

type Params = { params: Promise<{ code: string }> };

export default async function JoinPage({ params }: Params) {
  const { code } = await params;
  const t = await getTranslations("join");

  // Params arrive ALREADY decoded (Next route matcher) — do NOT
  // decodeURIComponent again: a malformed segment (/join/%) would throw
  // URIError → 500 instead of the neutral card, and double-decoding is a
  // latent normalization differential. Raw charset validation is the
  // /s/[code] precedent. Every valid join-code char is unreserved ASCII, so
  // anything percent-encoded is invalid anyway.
  const normalized = normalizeJoinCode(code);
  if (!normalized) {
    // Same neutral treatment regardless of WHY it is invalid (format,
    // unknown) — the page never probes existence.
    return (
      <NeutralCard
        message={t("invalidCode")}
        href="/student/classes"
        cta={t("backToClasses")}
      />
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Defense-in-depth: middleware already bounces anonymous users off /join
  // (it is not a PUBLIC_ROUTE). Kept in sync with the /s/[code] precedent so
  // the page stays correct if middleware routing ever changes.
  if (!user) {
    redirect(`/login?redirect=/join/${encodeURIComponent(normalized)}`);
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile) {
    // Signup-trigger race: treat like an invalid code (neutral, no oracle).
    return (
      <NeutralCard
        message={t("invalidCode")}
        href="/student/classes"
        cta={t("backToClasses")}
      />
    );
  }

  if (profile.role === "lecturer") {
    return (
      <NeutralCard
        message={t("lecturerNotice")}
        href="/lecturer/classes"
        cta={t("lecturerBack")}
      />
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <JoinConfirmClient code={normalized} />
    </div>
  );
}
