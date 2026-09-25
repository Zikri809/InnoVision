import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDemoModeEnabled, DEMO_JOIN_CODE } from "@/lib/demo/gate";
import { DEMO_LECTURER_EMAIL } from "@/lib/demo/walkup-reset";
import { DemoResetButton } from "./demo-reset-button";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("demo");
  return { title: t("pageTitle") };
}

/**
 * /demo — booth control room (PLAN_DEMO_MODE.md D9). Reachable ONLY under
 * NEXT_PUBLIC_DEMO_MODE=1 (else notFound) AND only to the seeded demo lecturer
 * (flag-gating is not authorization — visitor phones share the booth LAN).
 *
 * Deliberately NOT in proxy.ts's matcher: the page self-gates (flag + auth) and
 * must render for an anonymous visitor as a 404, never a /login redirect.
 */

interface Check {
  label: string;
  ok: boolean;
  detail?: string;
}

async function sidecarUp(): Promise<boolean> {
  const base = (process.env.INSIGHTFACE_BASE_URL || "http://localhost:8000").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default async function DemoPage() {
  if (!isDemoModeEnabled()) notFound();

  const t = await getTranslations("demo");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Not the demo lecturer → same 404 as flag-off (no oracle).
  if (!user || user.email !== DEMO_LECTURER_EMAIL) notFound();

  const admin = createAdminClient();

  const checks: Check[] = [];
  checks.push({ label: t("checkFlag"), ok: true, detail: "NEXT_PUBLIC_DEMO_MODE=1" });

  // Demo class + walk-up quiz.
  const { data: demoClass } = await admin
    .from("classes")
    .select("id")
    .eq("join_code", DEMO_JOIN_CODE)
    .maybeSingle();
  checks.push({
    label: t("checkClass"),
    ok: Boolean(demoClass?.id),
    detail: `join code ${DEMO_JOIN_CODE}`,
  });

  if (demoClass?.id) {
    const { data: liveQuiz } = await admin
      .from("quizzes")
      .select("id, title, status")
      .eq("class_id", demoClass.id)
      .eq("mode", "practice")
      .eq("status", "live")
      .limit(1)
      .maybeSingle();
    checks.push({
      label: t("checkQuiz"),
      ok: Boolean(liveQuiz?.id),
      detail: liveQuiz?.title,
    });
  }

  // AI keys (generation/showcase features fail without them).
  checks.push({ label: t("checkAiKey"), ok: Boolean(process.env.AI_API_KEY?.trim()) });
  checks.push({
    label: t("checkTinyfishKey"),
    ok: Boolean(process.env.TINYFISH_API_KEY?.trim()),
  });
  checks.push({
    label: t("checkSidecar"),
    ok: await sidecarUp(),
    detail: process.env.INSIGHTFACE_BASE_URL || "http://localhost:8000",
  });

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="font-heading text-3xl font-extrabold">{t("pageTitle")}</h1>
      <p className="mt-2 text-sm font-semibold text-muted-foreground">
        {t("pageSubtitle", { email: DEMO_LECTURER_EMAIL })}
      </p>

      <section className="mt-8">
        <h2 className="font-heading text-lg font-bold">{t("preflightHeading")}</h2>
        <ul className="mt-3 space-y-2">
          {checks.map((c) => (
            <li
              key={c.label}
              className="flex items-center gap-3 rounded-2xl border-[3px] border-border bg-card px-4 py-3 text-sm font-semibold shadow-[var(--shadow-clay-sm)]"
            >
              <span
                aria-hidden
                className={
                  c.ok
                    ? "inline-flex size-6 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : "inline-flex size-6 items-center justify-center rounded-full bg-destructive/15 text-destructive"
                }
              >
                {c.ok ? "✓" : "✕"}
              </span>
              <span className={c.ok ? undefined : "text-destructive"}>
                {c.label}
                {c.detail ? (
                  <span className="ml-2 font-normal text-muted-foreground">{c.detail}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs font-semibold text-muted-foreground">{t("manualChecks")}</p>
      </section>

      <section className="mt-10">
        <h2 className="font-heading text-lg font-bold">{t("resetHeading")}</h2>
        <div className="mt-3">
          <DemoResetButton />
        </div>
      </section>

      <section className="mt-10 text-sm font-semibold text-muted-foreground">
        <h2 className="font-heading text-lg font-bold text-foreground">{t("runSheetHeading")}</h2>
        <p className="mt-2">{t("runSheetBody", { code: DEMO_JOIN_CODE })}</p>
      </section>
    </main>
  );
}
