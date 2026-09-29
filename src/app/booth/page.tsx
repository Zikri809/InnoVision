import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDemoModeEnabled, DEMO_JOIN_CODE } from "@/lib/demo/gate";
import { DEMO_LECTURER_EMAIL } from "@/lib/demo/walkup-reset";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("booth");
  return { title: t("pageTitle") };
}

/**
 * /booth — projector/print booth card (exhibition D10). Reachable ONLY under
 * NEXT_PUBLIC_DEMO_MODE=1 (else notFound) AND only to the seeded demo
 * lecturer (flag-gating is not authorization — visitor phones share the
 * booth network).
 *
 * Deliberately NOT in proxy.ts's matcher, same as /demo: the page self-gates
 * (flag + auth) and must render for anyone else as a 404, never a /login
 * redirect.
 *
 * The origin is read from the request host, so tunnel rotations need zero
 * regeneration: whatever origin the presenter loads this page from is the
 * origin baked into every QR. Cards target the DEMO-LECTURER subject copies
 * (ECN444/RSK444/SPK444) so the farah/rajesh accounts stay pristine for the
 * lecturer-track demo.
 */

const SUBJECT_CODES = ["ECN444", "RSK444", "SPK444"] as const;

export default async function BoothPage() {
  if (!isDemoModeEnabled()) notFound();

  const t = await getTranslations("booth");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Not the demo lecturer → same 404 as flag-off (no oracle).
  if (!user || user.email !== DEMO_LECTURER_EMAIL) notFound();

  const hdrs = await headers();
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "localhost:3000";
  const proto =
    hdrs.get("x-forwarded-proto") ??
    (/^(localhost|127\.)/.test(host) ? "http" : "https");
  const origin = `${proto}://${host}`;

  const admin = createAdminClient();
  const codes = [DEMO_JOIN_CODE, ...SUBJECT_CODES];
  const { data: classes } = await admin
    .from("classes")
    .select("title, join_code")
    .in("join_code", codes);
  const titles = new Map((classes ?? []).map((c) => [c.join_code, c.title]));

  const cards = await Promise.all(
    codes.map(async (code, i) => {
      const url = `${origin}/join/${code}`;
      const qr = await QRCode.toDataURL(url, { width: 640, margin: 2 });
      return {
        code,
        url,
        qr,
        title: i === 0 ? t("entryTitle") : (titles.get(code) ?? code),
        sub: i === 0 ? t("entrySub") : t("subjectSub"),
        missing: !titles.has(code),
      };
    }),
  );

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="font-heading text-3xl font-extrabold">{t("pageTitle")}</h1>
      <p className="mt-2 text-sm font-semibold text-muted-foreground">
        {t("pageSubtitle", { email: DEMO_LECTURER_EMAIL })}
      </p>
      <p className="mt-2 text-sm font-bold">{t("stepHint")}</p>

      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        {cards.map((c) => (
          <section
            key={c.code}
            className="rounded-2xl border-[3px] border-border bg-card px-4 py-5 text-center shadow-[var(--shadow-clay-sm)]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.qr} alt={`QR: ${c.url}`} width={300} height={300} className="mx-auto size-[300px]" />
            <h2 className="font-heading mt-3 text-lg font-extrabold">{c.title}</h2>
            <p className="mt-1 text-sm font-semibold text-muted-foreground">{c.sub}</p>
            <p className="mt-2 text-sm font-bold">
              {t("codeLabel", { code: c.code })}
            </p>
            <p className="mt-1 break-all text-xs font-semibold text-muted-foreground">{c.url}</p>
            {c.missing ? (
              <p className="mt-2 text-sm font-bold text-destructive">{t("missingNote")}</p>
            ) : null}
          </section>
        ))}
      </div>

      <p className="mt-6 text-xs font-semibold text-muted-foreground">{t("cameraNote")}</p>
    </main>
  );
}
