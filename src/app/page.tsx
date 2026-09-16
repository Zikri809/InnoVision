import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import QRCode from "react-qr-code";
import {
  ArrowRight,
  Asterisk,
  Bot,
  Camera,
  Check,
  FileText,
  Hand,
  Hash,
  LineChart,
  Link2,
  QrCode,
  ShieldCheck,
  Sparkle,
  Sparkles,
  Target,
  Upload,
} from "lucide-react";
import type { CSSProperties } from "react";
import { createClient } from "@/lib/supabase/server";
import { LanguageToggle } from "@/components/layout/language-toggle";
import { GestureDemo } from "@/components/landing/gesture-demo";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Logged-in users skip the marketing page and go straight to their dashboard.
  if (user) redirect("/dashboard");

  const t = await getTranslations("landing");
  const tNav = await getTranslations("nav");

  // Hero word reel: 4 phrases + a duplicate of the first so the 14s loop
  // cut lands on an identical frame (translateY(-400%) === frame 0).
  const words = [t("heroWord1"), t("heroWord2"), t("heroWord3"), t("heroWord4")];

  const journey = [
    { n: "1", icon: Hash, title: t("journey1Title"), body: t("journey1Body") },
    { n: "2", icon: Camera, title: t("journey2Title"), body: t("journey2Body") },
    { n: "3", icon: Hand, title: t("journey3Title"), body: t("journey3Body") },
  ];

  const bento = [
    {
      icon: Hand,
      tint: "bg-orange-100 text-orange-600",
      span: "lg:col-span-2",
      title: t("feature1Title"),
      body: t("feature1Body"),
      extra: (
        <div aria-hidden className="mt-5 flex gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <span
              key={n}
              style={{ transitionDelay: `${n * 40}ms` }}
              className={`grid h-10 w-10 place-items-center rounded-[12px] border-[3px] font-heading text-lg font-bold transition-transform duration-200 group-hover:-translate-y-1 ${
                n === 2
                  ? "border-accent bg-accent text-accent-foreground shadow-[0_4px_0_var(--accent-deep)]"
                  : "border-border bg-muted text-foreground shadow-[0_4px_0_var(--border)]"
              }`}
            >
              {n}
            </span>
          ))}
        </div>
      ),
    },
    {
      icon: ShieldCheck,
      tint: "bg-blue-100 text-blue-600",
      span: "",
      title: t("feature2Title"),
      body: t("feature2Body"),
    },
    {
      icon: Sparkles,
      tint: "bg-green-100 text-green-600",
      span: "",
      title: t("feature3Title"),
      body: t("feature3Body"),
    },
    {
      icon: Target,
      tint: "bg-pink-100 text-pink-600",
      span: "",
      title: t("feature4Title"),
      body: t("feature4Body"),
    },
    {
      icon: LineChart,
      tint: "bg-yellow-100 text-yellow-600",
      span: "",
      title: t("feature5Title"),
      body: t("feature5Body"),
    },
    {
      icon: Link2,
      tint: "bg-violet-100 text-violet-600",
      span: "lg:col-span-2",
      title: t("feature6Title"),
      body: t("feature6Body"),
      extra: (
        <div aria-hidden className="mt-5 flex items-center gap-2">
          {["4", "F", "7", "K", "Q", "Z"].map((c, i) => (
            <span
              key={i}
              className="grid h-10 w-9 place-items-center rounded-[12px] border-[3px] border-border bg-muted font-heading text-lg font-bold text-foreground shadow-[0_4px_0_var(--border)]"
            >
              {c}
            </span>
          ))}
          <ArrowRight className="h-5 w-5 text-primary" />
        </div>
      ),
    },
  ];

  const marqueeItems = [
    { value: t("stat1Value"), label: t("stat1Label"), accent: true },
    { value: t("stat2Value"), label: t("stat2Label"), accent: false },
    { value: t("stat3Value"), label: t("stat3Label"), accent: true },
    { value: t("stat4Value"), label: t("stat4Label"), accent: false },
  ];

  // --i phase-shifts each check within the shared 9s keyframe timeline:
  // CSS calc() on the custom property staggers without extra keyframes.
  const pipeStyle = (i: number) => ({ "--i": i }) as CSSProperties;
  const pipeSteps = [t("pipe1"), t("pipe2"), t("pipe3"), t("pipe4"), t("pipe5")];

  const lecturerBullets = [t("lecturerBullet1"), t("lecturerBullet2"), t("lecturerBullet3")];

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden">
      <a href="#main" className="skip-link">{tNav("skipToContent")}</a>
      {/* ===== Nav ===== */}
      <header className="sticky top-0 z-50 border-b-[3px] border-border bg-background/85 pt-[var(--safe-top)] backdrop-blur">
        <div className="mx-auto flex h-[74px] w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex shrink-0 items-center gap-2.5">
            <span className="grid h-10 w-10 -rotate-4 place-items-center rounded-[14px] bg-primary font-heading text-lg font-bold text-primary-foreground shadow-[0_4px_0_var(--primary-deep)]">
              E2
            </span>
            <span className="hidden font-heading text-[23px] font-semibold min-[480px]:inline">{tNav("brand")}</span>
          </Link>
          <nav className="hidden items-center gap-7 md:flex">
            <a href="#features" className="text-[15px] font-bold text-muted-foreground transition-colors hover:text-primary">{tNav("features")}</a>
            <a href="#why-us" className="text-[15px] font-bold text-muted-foreground transition-colors hover:text-primary">{tNav("whyUs")}</a>
            <a href="#cta" className="text-[15px] font-bold text-muted-foreground transition-colors hover:text-primary">{tNav("joinIn")}</a>
          </nav>
          {/* Anchor chips ≥sm only: at 375px they truncated to "Fe…" and
              squeezed the auth cluster; phones reach these sections by
              scrolling and the hero CTAs cover the same destinations. */}
          <nav aria-label={tNav("primaryNav")} className="hidden min-w-0 items-center gap-2 overflow-x-auto scrollbar-none sm:flex md:hidden">
            <a href="#features" className="shrink-0 whitespace-nowrap rounded-full border-[3px] border-border bg-card px-3 py-1 text-xs font-extrabold text-muted-foreground transition-colors hover:text-primary">{tNav("features")}</a>
            <a href="#why-us" className="shrink-0 whitespace-nowrap rounded-full border-[3px] border-border bg-card px-3 py-1 text-xs font-extrabold text-muted-foreground transition-colors hover:text-primary">{tNav("whyUs")}</a>
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
        {/* ===== Hero — asymmetric split: story left, live demo right ===== */}
        <section className="relative overflow-hidden py-14 md:py-24">
          <div aria-hidden className="landing-blob pointer-events-none absolute -left-6 top-24 h-40 w-40 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-orange-200/50 md:left-[3%]" />
          <div aria-hidden className="landing-blob pointer-events-none absolute right-[6%] top-44 h-28 w-28 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-200/50 [animation-delay:-6s]" />
          <div aria-hidden className="landing-blob pointer-events-none absolute bottom-24 left-[10%] hidden h-24 w-24 rounded-[50%_50%_42%_58%/55%_48%_52%_45%] bg-pink-200/50 md:block [animation-delay:-11s]" />

          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:gap-10">
            <div className="text-center lg:text-left">
              <span className="clay-pill clay-pop">
                <Sparkle className="h-4 w-4" aria-hidden />
                {t("badge")}
              </span>
              <h1 className="clay-pop mt-6 font-heading text-[clamp(40px,6.4vw,68px)] font-semibold leading-[1.05] [animation-delay:70ms] [text-wrap:balance]">
                {t("heroTitle")}{" "}
                <span className="relative inline-block whitespace-nowrap text-primary">
                  {/* Reel viewport: 1.25em tall so Fredoka descenders ("g" in
                      "high-five") never clip; rows share the same leading. */}
                  <span className="inline-grid h-[1.25em] overflow-hidden align-bottom">
                    <span className="landing-word-reel">
                      {words.map((w) => (
                        <span key={w} className="block leading-[1.25em]">{w}</span>
                      ))}
                      <span aria-hidden className="block leading-[1.25em]">{words[0]}</span>
                    </span>
                  </span>
                  <svg className="landing-squiggle absolute -bottom-2 left-0 h-3 w-full" viewBox="0 0 220 14" fill="none" preserveAspectRatio="none" aria-hidden>
                    <path d="M3 10 C 30 2, 55 12, 82 7 S 135 3, 160 8 S 205 12, 217 6" stroke="var(--primary)" strokeWidth="5" strokeLinecap="round" />
                  </svg>
                </span>
              </h1>
              <p className="clay-pop mx-auto mt-6 max-w-xl text-lg font-semibold text-muted-foreground [animation-delay:140ms] md:text-[19px] lg:mx-0">
                {t("heroSubtitle")}
              </p>
              <div className="clay-pop mt-8 flex flex-wrap items-center justify-center gap-4 [animation-delay:220ms] lg:justify-start">
                <Link href="/register" className="clay-btn-primary">
                  {t("joinClass")}
                  <ArrowRight className="h-5 w-5" aria-hidden />
                </Link>
                <a href="#journey" className="clay-btn-ghost">{t("seeMagic")}</a>
              </div>
            </div>

            <div className="clay-pop [animation-delay:320ms]">
              <GestureDemo />
            </div>
          </div>
        </section>

        {/* ===== Journey — 3 comic-strip steps + QR ===== */}
        <section id="journey" className="py-20 md:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="mx-auto mb-16 max-w-2xl text-center">
              <span className="clay-pill">{t("howItWorks")}</span>
              <h2 className="mt-4 font-heading text-[clamp(30px,4.4vw,44px)] font-semibold [text-wrap:balance]">
                {t("journeyTitle")}
              </h2>
            </div>
            <ol className="grid gap-6 md:grid-cols-3">
              {journey.map(({ n, icon: Icon, title, body }, i) => (
                <li
                  key={n}
                  className="clay-card clay-pop group relative p-7 pt-9 transition-[transform,box-shadow] duration-200 hover:-translate-y-1.5 hover:-rotate-[0.5deg] hover:shadow-[8px_10px_0_rgba(194,65,12,0.16)]"
                  style={{ animationDelay: `${240 + i * 90}ms` }}
                >
                  <span className="absolute -top-5 left-6 grid h-11 w-11 -rotate-6 place-items-center rounded-[14px] border-[3px] border-border bg-primary font-heading text-xl font-bold text-primary-foreground shadow-[0_4px_0_var(--primary-deep)]">
                    {n}
                  </span>
                  <Icon className="absolute right-6 top-6 h-8 w-8 text-primary/50 transition-colors group-hover:text-primary" aria-hidden />
                  <h3 className="mt-3 font-heading text-xl font-semibold">{title}</h3>
                  <p className="mt-2 text-[15px] font-semibold text-muted-foreground">{body}</p>
                  {i < 2 && (
                    <ArrowRight aria-hidden className="absolute -right-7 top-1/2 hidden h-7 w-7 -translate-y-1/2 text-primary/50 md:block" />
                  )}
                </li>
              ))}
            </ol>
            <div className="clay-card mt-12 flex flex-col items-center gap-6 p-6 sm:flex-row sm:gap-8">
              <div className="shrink-0 rounded-2xl border-[3px] border-border bg-white p-3 shadow-[0_4px_0_var(--border)]">
                {/* Custom scheme, not a web URL: scanning must never send
                    anyone to a domain we don't own — this is a demo pattern. */}
                <QRCode value="innovision://join/DEMO24" size={88} bgColor="#ffffff" fgColor="#431407" />
              </div>
              <div className="text-center sm:text-left">
                <div className="font-heading text-lg font-semibold">{t("journeyQrLabel")}</div>
                <div className="mt-1 text-sm font-semibold text-muted-foreground">{t("journeyQrHint")}</div>
              </div>
              <QrCode aria-hidden className="ml-auto hidden h-10 w-10 shrink-0 text-primary/40 sm:block" />
            </div>
          </div>
        </section>

        {/* ===== Features — bento grid (2 wide, 4 standard) ===== */}
        <section id="features" className="py-20 md:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="mx-auto mb-14 max-w-2xl text-center">
              <span className="clay-pill">{t("bentoEyebrow")}</span>
              <h2 className="mt-4 font-heading text-[clamp(30px,4.4vw,44px)] font-semibold [text-wrap:balance]">
                {t("bentoTitle")}
              </h2>
            </div>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {bento.map(({ icon: Icon, tint, span, title, body, extra }) => (
                <div
                  key={title}
                  className={`clay-card clay-pop group p-7 transition-[transform,box-shadow] duration-200 hover:-translate-y-1.5 hover:-rotate-[0.5deg] hover:shadow-[8px_10px_0_rgba(194,65,12,0.16)] ${span}`}
                >
                  <div className={`mb-4 grid h-14 w-14 place-items-center rounded-[18px] shadow-[0_4px_0_rgba(194,65,12,0.12)] ${tint}`}>
                    <Icon className="h-7 w-7" aria-hidden />
                  </div>
                  <h3 className="font-heading text-xl font-semibold">{title}</h3>
                  <p className="mt-2 text-[15px] font-semibold text-muted-foreground">{body}</p>
                  {extra}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ===== Stats — tilted full-bleed marquee (pauses on hover) ===== */}
        <section id="why-us" aria-label={t("statsTitle")} className="relative overflow-hidden py-10 md:py-14">
          <h2 className="sr-only">{t("statsTitle")}</h2>
          <div className="-rotate-1 border-y-[3px] border-border bg-card/80 py-6 backdrop-blur-sm">
            {/* Track = two identical halves; translateX(-50%) loops seamlessly. */}
            <div className="landing-marquee overflow-hidden">
              <div className="landing-marquee-track flex w-max">
                {[0, 1].map((half) => (
                  <div key={half} aria-hidden={half === 1} className="flex items-center gap-10 pr-10">
                    {marqueeItems.map((s, i) => (
                      <span key={i} className="flex items-center gap-3 whitespace-nowrap">
                        <Asterisk className={`h-9 w-9 ${s.accent ? "text-accent" : "text-primary"}`} aria-hidden />
                        <span className={`font-heading text-4xl font-bold md:text-5xl ${s.accent ? "text-accent" : "text-primary"}`}>
                          {s.value}
                        </span>
                        <span className="text-base font-extrabold text-muted-foreground md:text-lg">{s.label}</span>
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ===== Lecturers — AI pipeline story ===== */}
        <section id="lecturer" className="relative overflow-hidden py-20 md:py-24">
          <div aria-hidden className="landing-blob pointer-events-none absolute -right-8 top-20 h-36 w-36 rounded-[58%_42%_55%_45%/48%_55%_45%_52%] bg-blue-200/50 [animation-delay:-4s]" />
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-2">
            <div>
              <span className="clay-pill">{t("lecturerEyebrow")}</span>
              <h2 className="mt-4 font-heading text-[clamp(30px,4.4vw,44px)] font-semibold [text-wrap:balance]">
                {t("lecturerTitle")}
              </h2>
              <p className="mt-4 max-w-xl text-[17px] font-semibold text-muted-foreground">{t("lecturerBody")}</p>
              <ul className="mt-7 space-y-3.5">
                {lecturerBullets.map((b) => (
                  <li key={b} className="flex items-start gap-3 font-semibold">
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-green-200 text-green-700 shadow-[0_2px_0_rgba(194,65,12,0.15)]">
                      <Check className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="min-w-0">{b}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
                <Link href="/register" className="clay-btn-accent">{t("lecturerCta")}</Link>
                <span className="flex items-baseline gap-2">
                  <span className="font-heading text-3xl font-bold text-primary">{t("lecturerStatValue")}</span>
                  <span className="text-sm font-bold text-muted-foreground">{t("lecturerStatLabel")}</span>
                </span>
              </div>
            </div>

            <div className="clay-card clay-pop p-6" style={{ boxShadow: "var(--shadow-clay-accent), var(--shadow-clay-in)" }}>
              <div className="flex flex-wrap items-center gap-3 border-b-[3px] border-border pb-4">
                <span className="grid h-11 w-11 place-items-center rounded-[14px] bg-accent text-accent-foreground shadow-[0_4px_0_var(--accent-deep)]">
                  <Bot className="h-6 w-6" aria-hidden />
                </span>
                <span className="flex items-center gap-2 rounded-full border-[3px] border-border bg-muted px-3.5 py-1.5 text-sm font-extrabold text-foreground">
                  <FileText className="h-4 w-4 text-primary" aria-hidden />
                  lecture-12.pdf
                </span>
                <span className="ml-auto flex items-center gap-1.5 text-sm font-bold text-muted-foreground">
                  <Upload className="h-4 w-4" aria-hidden />
                  24 pages
                </span>
              </div>
              <div className="mt-5 space-y-2.5">
                {pipeSteps.map((label, i) => (
                  <div key={label} className="flex items-center gap-3 rounded-2xl border-[3px] border-border bg-card px-4 py-3 shadow-[0_4px_0_var(--border)]">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-muted font-heading text-sm font-bold text-foreground">
                      {i + 1}
                    </span>
                    <span className="font-extrabold text-foreground">{label}</span>
                    <span className="landing-pipe-check ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-full bg-green-200 text-green-700" style={pipeStyle(i)}>
                      <Check className="h-4 w-4" aria-hidden />
                    </span>
                  </div>
                ))}
              </div>
              <div aria-hidden className="mt-5 flex gap-1.5">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <span key={i} className={`h-2.5 flex-1 rounded-full ${i < 5 ? "bg-primary" : "bg-muted"}`} />
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ===== CTA ===== */}
        <section id="cta" className="py-20 md:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="relative overflow-hidden rounded-[32px] border-[3px] border-accent-deep bg-gradient-to-br from-accent to-blue-800 px-8 py-16 text-center text-accent-foreground shadow-[var(--shadow-clay-accent)] md:py-20">
              <div aria-hidden className="pointer-events-none absolute -right-12 -top-16 h-48 w-48 rounded-full bg-white/10" />
              <div aria-hidden className="pointer-events-none absolute -bottom-10 left-[6%] h-32 w-32 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/10" />
              <h2 className="relative font-heading text-[clamp(28px,4.4vw,44px)] font-semibold [text-wrap:balance]">
                {t("ctaTitle")}
              </h2>
              <p className="relative mx-auto mt-4 max-w-xl text-[17px] font-semibold text-white/90">
                {t("ctaSubtitle")}
              </p>
              <Link href="/register" className="clay-btn-primary relative mt-8">
                {t("ctaButton")}
                <ArrowRight className="h-5 w-5" aria-hidden />
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* ===== Footer ===== */}
      <footer className="border-t-[3px] border-border py-10">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-4 text-sm font-semibold text-muted-foreground sm:px-6">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 -rotate-4 place-items-center rounded-[10px] bg-primary font-heading text-sm font-bold text-primary-foreground shadow-[0_3px_0_var(--primary-deep)]">
              E2
            </span>
            <span className="font-heading text-[17px] font-semibold text-foreground">Easy2U</span>
          </div>
          <div>{t("footerCopy")}</div>
        </div>
      </footer>
    </div>
  );
}
