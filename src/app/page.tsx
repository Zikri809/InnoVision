import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  Hand,
  ShieldCheck,
  Sparkles,
  LineChart,
  Target,
  Link2,
  Check,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { LanguageToggle } from "@/components/layout/language-toggle";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Logged-in users skip the marketing page and go straight to their dashboard.
  if (user) redirect("/dashboard");

  const t = await getTranslations("landing");
  const tNav = await getTranslations("nav");

  const features = [
    {
      icon: Hand,
      tint: "bg-orange-100 text-orange-600",
      title: t("feature1Title"),
      body: t("feature1Body"),
    },
    {
      icon: ShieldCheck,
      tint: "bg-blue-100 text-blue-600",
      title: t("feature2Title"),
      body: t("feature2Body"),
    },
    {
      icon: Sparkles,
      tint: "bg-green-100 text-green-600",
      title: t("feature3Title"),
      body: t("feature3Body"),
    },
    {
      icon: Target,
      tint: "bg-pink-100 text-pink-600",
      title: t("feature4Title"),
      body: t("feature4Body"),
    },
    {
      icon: LineChart,
      tint: "bg-yellow-100 text-yellow-600",
      title: t("feature5Title"),
      body: t("feature5Body"),
    },
    {
      icon: Link2,
      tint: "bg-violet-100 text-violet-600",
      title: t("feature6Title"),
      body: t("feature6Body"),
    },
  ];

  const stats = [
    { value: t("stat1Value"), label: t("stat1Label"), accent: false },
    { value: t("stat2Value"), label: t("stat2Label"), accent: true },
    { value: t("stat3Value"), label: t("stat3Label"), accent: false },
    { value: t("stat4Value"), label: t("stat4Label"), accent: true },
  ];

  const options = ["Stack", "Queue", "Tree", "Graph"] as const;

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden">
      <a href="#main" className="skip-link">{tNav("skipToContent")}</a>
      {/* ===== Nav ===== */}
      <header className="sticky top-0 z-50 border-b-[3px] border-border bg-background/85 pt-[var(--safe-top)] backdrop-blur">
        <div className="mx-auto flex h-[74px] w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex shrink-0 items-center gap-2.5">
            <span className="grid h-10 w-10 -rotate-4 place-items-center rounded-[14px] bg-primary font-heading text-lg font-bold text-primary-foreground shadow-[0_4px_0_var(--primary-deep)]">
              IV
            </span>
            <span className="hidden font-heading text-[23px] font-semibold min-[480px]:inline">{tNav("brand")}</span>
          </Link>
          <nav className="hidden items-center gap-7 md:flex">
            <a href="#features" className="text-[15px] font-bold text-muted-foreground transition-colors hover:text-primary">{tNav("features")}</a>
            <a href="#stats" className="text-[15px] font-bold text-muted-foreground transition-colors hover:text-primary">{tNav("whyUs")}</a>
            <a href="#cta" className="text-[15px] font-bold text-muted-foreground transition-colors hover:text-primary">{tNav("joinIn")}</a>
          </nav>
          {/* Anchor chips ≥sm only: at 375px they truncated to "Fe…" and
              squeezed the auth cluster; phones reach these sections by
              scrolling and the hero CTAs cover the same destinations. */}
          <nav aria-label={tNav("primaryNav")} className="hidden min-w-0 items-center gap-2 overflow-x-auto scrollbar-none sm:flex md:hidden">
            <a href="#features" className="shrink-0 whitespace-nowrap rounded-full border-[3px] border-border bg-card px-3 py-1 text-xs font-extrabold text-muted-foreground transition-colors hover:text-primary">{tNav("features")}</a>
            <a href="#stats" className="shrink-0 whitespace-nowrap rounded-full border-[3px] border-border bg-card px-3 py-1 text-xs font-extrabold text-muted-foreground transition-colors hover:text-primary">{tNav("whyUs")}</a>
            <a href="#cta" className="shrink-0 whitespace-nowrap rounded-full border-[3px] border-border bg-card px-3 py-1 text-xs font-extrabold text-muted-foreground transition-colors hover:text-primary">{tNav("joinIn")}</a>
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            <LanguageToggle />
            {/* Brand wordmark hides <sm (app-shell pattern): at 375px the
                full row overflowed and clipped the Register button off-screen. */}
            <Link href="/login" className="clay-btn-ghost whitespace-nowrap px-4 py-2.5 text-sm">{tNav("signIn")}</Link>
            <Link href="/register" className="clay-btn-primary whitespace-nowrap px-4 py-2.5 text-sm">{tNav("register")}</Link>
          </div>
        </div>
      </header>

      <main id="main" className="flex-1">
        {/* ===== Hero ===== */}
        <section className="relative overflow-hidden py-16 md:py-24">
          {/* decorative blobs */}
          <div aria-hidden className="pointer-events-none absolute left-[4%] top-16 h-28 w-28 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-orange-200/60" />
          <div aria-hidden className="pointer-events-none absolute right-[8%] top-48 h-20 w-20 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-200/60" />
          <div aria-hidden className="pointer-events-none absolute bottom-16 left-[12%] hidden h-16 w-16 rounded-[50%_50%_42%_58%/55%_48%_52%_45%] bg-pink-200/60 md:block" />

          <div className="mx-auto max-w-6xl px-6 text-center">
            <span className="clay-pill clay-pop">{t("heroSubtitle")}</span>
            <h1 className="clay-pop mx-auto mt-6 max-w-3xl font-heading text-[clamp(38px,6.4vw,68px)] font-semibold leading-[1.05] [animation-delay:70ms] [text-wrap:balance]">
              {t("heroTitle")}
            </h1>
            <p className="clay-pop mx-auto mt-5 max-w-xl text-[19px] font-semibold text-muted-foreground [animation-delay:140ms]">
              {t("feature1Body")}
            </p>
            <div className="clay-pop mt-9 flex flex-wrap items-center justify-center gap-4 [animation-delay:220ms]">
              <Link href="/register" className="clay-btn-primary">{t("joinClass")}</Link>
              <a href="#features" className="clay-btn-ghost">{t("seeMagic")}</a>
            </div>

            {/* gesture-quiz mock */}
            <div className="clay-pop mx-auto mt-16 max-w-3xl [animation-delay:320ms]">
              <div className="clay-card p-3 text-left" style={{ boxShadow: "var(--shadow-clay), var(--shadow-clay-in)" }}>
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="flex gap-1.5">
                    {[true, true, true, false, false, false].map((on, i) => (
                      <span key={i} className={`h-2.5 w-7 rounded-full ${on ? "bg-primary" : "bg-muted"}`} />
                    ))}
                  </div>
                  <span className="font-heading text-sm font-semibold text-primary">Q3 of 6</span>
                </div>
                <div className="m-2 rounded-[20px] border-[3px] border-border bg-gradient-to-b from-orange-50 to-orange-100 p-6 md:p-7">
                  <div className="font-heading text-sm font-semibold tracking-wide text-primary">QUESTION 3</div>
                  <div className="mt-2 font-heading text-xl font-semibold md:text-[22px]">
                    Which data structure works like a line at the cafeteria? (first in, first out)
                  </div>
                  <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                    {options.map((opt, i) => {
                      const selected = opt === "Queue";
                      return (
                        <div
                          key={opt}
                          className={`flex items-center gap-3 rounded-2xl border-[3px] px-4 py-4 font-extrabold transition-all ${
                            selected
                              ? "border-accent bg-blue-50 text-accent shadow-[0_4px_0_#bfdbfe]"
                              : "border-border bg-card text-muted-foreground shadow-[0_4px_0_var(--border)]"
                          }`}
                        >
                          <span className={`grid h-9 w-9 place-items-center rounded-[11px] font-heading font-semibold ${
                            selected ? "bg-accent text-accent-foreground" : "bg-muted text-foreground"
                          }`}>
                            {String.fromCharCode(65 + i)}
                          </span>
                          <span className="flex items-center gap-2">
                            {opt}
                            {selected && <Hand className="h-4 w-4" aria-hidden />}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-2.5 px-5 pb-2 pt-3 text-sm font-bold text-muted-foreground">
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-green-200 text-green-700">
                    <Check className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  You&apos;re verified! Hold up <b className="text-accent">2 fingers</b> — nice, that&apos;s a Queue!
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===== Features ===== */}
        <section id="features" className="py-20">
          <div className="mx-auto max-w-6xl px-6">
            <div className="mx-auto mb-14 max-w-2xl text-center">
              <span className="clay-pill">{t("howItWorks")}</span>
              <h2 className="mt-4 font-heading text-[clamp(30px,4.4vw,44px)] font-semibold [text-wrap:balance]">
                {t("statsTitle")}
              </h2>
              <p className="mt-3.5 text-[17px] font-semibold text-muted-foreground">
                {t("heroSubtitle")}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {features.map(({ icon: Icon, tint, title, body }) => (
                <div
                  key={title}
                  className="clay-card p-7 transition-[transform,box-shadow] duration-200 hover:-translate-y-1.5 hover:-rotate-[0.5deg] hover:shadow-[8px_10px_0_rgba(194,65,12,0.16)]"
                >
                  <div className={`mb-4 grid h-14 w-14 place-items-center rounded-[18px] shadow-[0_4px_0_rgba(0,0,0,0.08)] ${tint}`}>
                    <Icon className="h-7 w-7" aria-hidden />
                  </div>
                  <h3 className="font-heading text-xl font-semibold">{title}</h3>
                  <p className="mt-2 text-[15px] font-semibold text-muted-foreground">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ===== Stats ===== */}
        <section id="stats" className="py-6">
          <div className="mx-auto max-w-6xl px-6">
            <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
              {stats.map(({ value, label, accent }) => (
                <div key={label} className="clay-card px-4 py-8 text-center">
                  <div className={`font-heading text-[44px] font-bold ${accent ? "text-accent" : "text-primary"}`}>
                    {value}
                  </div>
                  <div className="mt-1.5 text-sm font-bold text-muted-foreground">{label}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ===== CTA ===== */}
        <section id="cta" className="py-20">
          <div className="mx-auto max-w-6xl px-6">
            <div className="relative overflow-hidden rounded-[32px] border-[3px] border-accent-deep bg-gradient-to-br from-accent to-blue-800 px-8 py-16 text-center text-accent-foreground shadow-[var(--shadow-clay-accent)] md:py-20">
              <div aria-hidden className="pointer-events-none absolute -right-12 -top-16 h-48 w-48 rounded-full bg-white/10" />
              <div aria-hidden className="pointer-events-none absolute -bottom-10 left-[6%] h-32 w-32 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/10" />
              <h2 className="relative font-heading text-[clamp(28px,4.4vw,44px)] font-semibold [text-wrap:balance]">
                {t("ctaTitle")}
              </h2>
              <p className="relative mx-auto mt-4 max-w-xl text-[17px] font-semibold text-white/90">
                {t("ctaSubtitle")}
              </p>
              <Link href="/register" className="clay-btn-primary relative mt-8">{t("ctaButton")}</Link>
            </div>
          </div>
        </section>
      </main>

      {/* ===== Footer ===== */}
      <footer className="border-t-[3px] border-border py-10">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-6 text-sm font-semibold text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 -rotate-4 place-items-center rounded-[10px] bg-primary font-heading text-sm font-bold text-primary-foreground shadow-[0_3px_0_var(--primary-deep)]">
              IV
            </span>
            <span className="font-heading text-[17px] font-semibold text-foreground">InnoVision</span>
          </div>
          <div>{t("footerCopy")}</div>
        </div>
      </footer>
    </div>
  );
}
