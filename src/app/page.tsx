import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowRight, BookOpen, Check, Eye, FileText, Hand, ListChecks, LockKeyhole, MousePointerClick, ScanFace, ShieldCheck, Sparkles, Table2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { LanguageToggle } from "@/components/layout/language-toggle";
import { GestureDemo } from "@/components/landing/gesture-demo";
import { Reveal } from "@/components/landing/reveal";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect("/dashboard");

  const t = await getTranslations("landing");
  const tNav = await getTranslations("nav");
  const lecturerSteps = [
    { title: t("lecturerStep1Title"), body: t("lecturerStep1Body") },
    { title: t("lecturerStep2Title"), body: t("lecturerStep2Body") },
    { title: t("lecturerStep3Title"), body: t("lecturerStep3Body") },
  ];
  const studentSteps = [
    { title: t("studentStep1Title"), body: t("studentStep1Body") },
    { title: t("studentStep2Title"), body: t("studentStep2Body") },
    { title: t("studentStep3Title"), body: t("studentStep3Body") },
  ];
  const features = [
    { icon: Sparkles, title: t("featureDraftTitle"), body: t("featureDraftBody") },
    { icon: ListChecks, title: t("featureTypesTitle"), body: t("featureTypesBody") },
    { icon: Hand, title: t("featureGestureTitle"), body: t("featureGestureBody") },
    { icon: ShieldCheck, title: t("featureIntegrityTitle"), body: t("featureIntegrityBody") },
    { icon: Table2, title: t("featureGradebookTitle"), body: t("featureGradebookBody") },
    { icon: Eye, title: t("featureResultsTitle"), body: t("featureResultsBody") },
  ];
  const stats = [
    { value: t("statQuestionsValue"), label: t("statQuestionsLabel") },
    { value: t("statAnswerValue"), label: t("statAnswerLabel") },
    { value: t("statJoinValue"), label: t("statJoinLabel") },
    { value: t("statLanguagesValue"), label: t("statLanguagesLabel") },
  ];

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden">
      {/* If JS never runs, the scroll-reveal wrappers must not stay hidden. */}
      <noscript>
        <style>{`[data-reveal="out"]{opacity:1 !important}`}</style>
      </noscript>
      <a href="#main" className="skip-link">{tNav("skipToContent")}</a>

      <header className="sticky top-0 z-50 border-b-[3px] border-border bg-background/95 pt-[var(--safe-top)] backdrop-blur">
        <div className="mx-auto flex h-[74px] w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label={tNav("brand")}>
            <span aria-hidden className="grid h-10 w-10 -rotate-4 place-items-center rounded-[14px] bg-primary font-heading text-lg font-bold text-primary-foreground shadow-[0_4px_0_var(--primary-deep)]">E2</span>
            <span className="hidden font-heading text-[23px] font-semibold min-[480px]:inline">{tNav("brand")}</span>
          </Link>
          <nav aria-label={tNav("primaryNav")} className="hidden items-center gap-7 lg:flex">
            <a href="#lecturers" className="text-[15px] font-bold text-muted-foreground transition-colors hover:text-primary-deep dark:hover:text-primary focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-ring">{t("navLecturers")}</a>
            <a href="#how-it-works" className="text-[15px] font-bold text-muted-foreground transition-colors hover:text-primary-deep dark:hover:text-primary focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-ring">{t("howItWorks")}</a>
            <a href="#features" className="text-[15px] font-bold text-muted-foreground transition-colors hover:text-primary-deep dark:hover:text-primary focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-ring">{tNav("features")}</a>
            <a href="#camera" className="text-[15px] font-bold text-muted-foreground transition-colors hover:text-primary-deep dark:hover:text-primary focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-ring">{t("navCamera")}</a>
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            <LanguageToggle variant="pill" className="h-11 rounded-2xl border-[3px] px-2.5 text-sm sm:hidden" />
            <LanguageToggle className="hidden sm:inline-flex" />
            <Link href="/login" className="clay-btn-ghost whitespace-nowrap px-3 py-2.5 text-sm sm:px-4">{tNav("signIn")}</Link>
            <Link href="/register" className="clay-btn-primary whitespace-nowrap px-3 py-2.5 text-sm sm:px-4">{t("navJoin")}</Link>
          </div>
        </div>
      </header>

      <main id="main" className="flex-1">
        <section className="border-b-[3px] border-border/70 py-16 md:py-24">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
            <Reveal>
              <p className="mb-5 flex items-center gap-2 text-sm font-extrabold uppercase tracking-[0.12em] text-primary-deep dark:text-primary">
                <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-primary" />{t("badge")}
              </p>
              <h1 className="max-w-2xl font-heading text-[clamp(38px,5.5vw,68px)] font-semibold leading-[1.06] [text-wrap:balance]">
                {t("heroTitle")} <span className="text-primary-deep dark:text-primary">{t("heroAccent")}</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg font-semibold leading-relaxed text-muted-foreground md:text-[19px]">{t("heroSubtitle")}</p>
              <div className="mt-8 flex flex-wrap items-center gap-4">
                <Link href="/register" className="clay-btn-primary">{t("joinClass")}<ArrowRight className="h-5 w-5" aria-hidden /></Link>
                <a href="#lecturers" className="clay-btn-ghost">{t("seeLecturerFlow")}</a>
              </div>
              <p className="mt-5 max-w-xl text-sm font-bold text-muted-foreground">{t("heroNote")}</p>
            </Reveal>
            <Reveal delay={120}>
              <GestureDemo />
            </Reveal>
          </div>
        </section>

        <section id="lecturers" className="scroll-mt-24 py-20 md:py-28">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <p className="mb-4 text-sm font-extrabold uppercase tracking-[0.12em] text-primary-deep dark:text-primary">{t("lecturerEyebrow")}</p>
              <h2 className="max-w-xl font-heading text-[clamp(34px,4.2vw,48px)] font-semibold leading-[1.1] [text-wrap:balance]">{t("lecturerTitle")}</h2>
              <p className="mt-5 max-w-xl text-[17px] font-semibold leading-relaxed text-muted-foreground">{t("lecturerBody")}</p>
              <ol className="mt-8 space-y-6">
                {lecturerSteps.map((step, index) => (
                  <li key={step.title} className="flex gap-4">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[13px] border-[3px] border-border bg-card font-heading text-base font-bold text-primary-deep shadow-[0_3px_0_var(--border)] dark:text-primary">{index + 1}</span>
                    <div><h3 className="font-heading text-lg font-semibold">{step.title}</h3><p className="mt-1 font-semibold text-muted-foreground">{step.body}</p></div>
                  </li>
                ))}
              </ol>
              <div className="mt-9 flex flex-wrap items-center gap-x-5 gap-y-3">
                <Link href="/register" className="clay-btn-accent">{t("lecturerCta")}</Link>
                <span className="text-sm font-bold text-muted-foreground">{t("lecturerInviteNote")}</span>
              </div>
            </Reveal>
            <Reveal delay={120}>
              <figure className="clay-card p-5 sm:p-7">
              <figcaption className="sr-only">{t("authorPreviewLabel")}</figcaption>
              <div className="flex items-center gap-3 border-b-[3px] border-border pb-5">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-orange-100 text-orange-700"><FileText className="h-6 w-6" aria-hidden /></span>
                <div className="min-w-0"><p className="text-xs font-extrabold uppercase tracking-wide text-muted-foreground">{t("authorSource")}</p><p className="truncate font-extrabold">{t("authorFile")}</p></div>
                <span className="ml-auto hidden shrink-0 rounded-full border-[3px] border-border bg-background px-3 py-1 text-xs font-extrabold sm:inline">PDF</span>
              </div>
              <div className="my-5 flex items-center gap-3 text-sm font-extrabold text-muted-foreground"><span aria-hidden className="h-[3px] flex-1 bg-border" />{t("authorTransition")}<span aria-hidden className="h-[3px] flex-1 bg-border" /></div>
              <div className="rounded-[20px] border-[3px] border-border bg-orange-50 p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-extrabold uppercase tracking-wide text-orange-700">{t("authorDraftLabel")}</span>
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-extrabold text-orange-800">{t("authorReviewStatus")}</span>
                </div>
                <p className="mt-4 font-heading text-xl font-semibold leading-snug text-orange-950">{t("authorQuestion")}</p>
                <div className="mt-5 grid gap-2 sm:grid-cols-2">
                  {(["authorOption1", "authorOption2", "authorOption3", "authorOption4"] as const).map((key, index) => (
                    <div key={key} className={"rounded-xl border-[3px] px-3 py-2.5 font-bold " + (index === 1 ? "border-accent bg-blue-50 text-blue-800" : "border-orange-200 bg-white text-orange-950")}>
                      <span className="mr-2 text-sm opacity-70">{String.fromCharCode(65 + index)}</span>{t(key)}
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-5 flex items-start gap-2.5 font-bold text-muted-foreground"><Check className="mt-0.5 h-5 w-5 shrink-0 text-green-700" aria-hidden /><span>{t("authorFootnote")}</span></div>
              </figure>
            </Reveal>
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-24 border-y-[3px] border-border bg-card py-20 md:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <Reveal>
              <div className="max-w-2xl">
                <p className="mb-4 text-sm font-extrabold uppercase tracking-[0.12em] text-primary-deep dark:text-primary">{t("studentEyebrow")}</p>
                <h2 className="font-heading text-[clamp(34px,4.2vw,48px)] font-semibold leading-[1.1] [text-wrap:balance]">{t("studentTitle")}</h2>
                <p className="mt-5 text-[17px] font-semibold leading-relaxed text-muted-foreground">{t("studentBody")}</p>
              </div>
            </Reveal>
            <ol className="mt-12 grid gap-8 md:grid-cols-3 md:gap-10">
              {studentSteps.map((step, index) => (
                <li key={step.title}>
                  <Reveal delay={index * 70}>
                    <div className="border-t-[3px] border-border pt-6">
                      <span className="font-heading text-3xl font-semibold text-primary-deep dark:text-primary">0{index + 1}</span>
                      <h3 className="mt-5 font-heading text-xl font-semibold">{step.title}</h3>
                      <p className="mt-2 font-semibold leading-relaxed text-muted-foreground">{step.body}</p>
                    </div>
                  </Reveal>
                </li>
              ))}
            </ol>
            <Reveal delay={180}>
              <Link href="/register" className="clay-btn-primary mt-10">{t("joinClass")}<ArrowRight className="h-5 w-5" aria-hidden /></Link>
            </Reveal>
          </div>
        </section>

        <section id="features" className="scroll-mt-24 border-y-[3px] border-border bg-card py-20 md:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <Reveal>
              <div className="max-w-2xl">
                <p className="mb-4 text-sm font-extrabold uppercase tracking-[0.12em] text-primary-deep dark:text-primary">{t("featuresEyebrow")}</p>
                <h2 className="font-heading text-[clamp(34px,4.2vw,48px)] font-semibold leading-[1.1] [text-wrap:balance]">{t("featuresTitle")}</h2>
                <p className="mt-5 text-[17px] font-semibold leading-relaxed text-muted-foreground">{t("featuresBody")}</p>
              </div>
            </Reveal>
            <ol className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3 lg:gap-8">
              {features.map((feature, index) => (
                <li key={feature.title}>
                  <Reveal delay={index * 60}>
                    <div className="clay-card h-full p-6">
                      <span className="grid h-12 w-12 place-items-center rounded-[14px] border-[3px] border-border bg-background text-primary-deep shadow-[0_3px_0_var(--border)] dark:text-primary">
                        <feature.icon className="h-6 w-6" aria-hidden />
                      </span>
                      <h3 className="mt-5 font-heading text-lg font-semibold">{feature.title}</h3>
                      <p className="mt-2 text-[15px] font-semibold leading-relaxed text-muted-foreground">{feature.body}</p>
                    </div>
                  </Reveal>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="camera" className="scroll-mt-24 py-20 md:py-24">
          <div className="mx-auto grid max-w-6xl gap-9 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:gap-16">
            <Reveal>
              <p className="mb-4 text-sm font-extrabold uppercase tracking-[0.12em] text-primary-deep dark:text-primary">{t("cameraEyebrow")}</p>
              <h2 className="font-heading text-[clamp(34px,4.2vw,48px)] font-semibold leading-[1.1] [text-wrap:balance]">{t("cameraTitle")}</h2>
              <p className="mt-5 max-w-lg text-[17px] font-semibold leading-relaxed text-muted-foreground">{t("cameraBody")}</p>
            </Reveal>
            <div className="grid gap-4 sm:grid-cols-2">
              <Reveal delay={90}>
                <div className="clay-card h-full p-6"><ScanFace className="h-7 w-7 text-primary-deep dark:text-primary" aria-hidden /><h3 className="mt-5 font-heading text-xl font-semibold">{t("cameraConsentTitle")}</h3><p className="mt-2 font-semibold leading-relaxed text-muted-foreground">{t("cameraConsentBody")}</p></div>
              </Reveal>
              <Reveal delay={180}>
                <div className="clay-card h-full p-6"><MousePointerClick className="h-7 w-7 text-accent" aria-hidden /><h3 className="mt-5 font-heading text-xl font-semibold">{t("cameraChoiceTitle")}</h3><p className="mt-2 font-semibold leading-relaxed text-muted-foreground">{t("cameraChoiceBody")}</p></div>
              </Reveal>
            </div>
          </div>
        </section>

        <section id="stats" aria-label={t("statsEyebrow")} className="scroll-mt-24 py-16 md:py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <Reveal>
              <p className="mb-8 text-center text-sm font-extrabold uppercase tracking-[0.12em] text-primary-deep dark:text-primary">{t("statsEyebrow")}</p>
              <div className="grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-4">
                {stats.map((stat, index) => (
                  <Reveal key={stat.label} delay={index * 70}>
                    <div className="clay-card flex h-full flex-col items-center justify-center gap-1.5 px-4 py-7 text-center">
                      <span className="font-heading text-[clamp(34px,4vw,44px)] font-semibold leading-none text-primary-deep dark:text-primary">{stat.value}</span>
                      <span className="text-sm font-bold text-muted-foreground">{stat.label}</span>
                    </div>
                  </Reveal>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        <section className="pb-20 pt-4 md:pb-28">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <Reveal>
              <div className="rounded-[28px] border-[3px] border-accent-deep bg-accent px-7 py-11 text-accent-foreground shadow-[var(--shadow-clay-accent)] sm:px-12 md:flex md:items-end md:justify-between md:gap-10 md:py-14">
              <div className="max-w-2xl">
                <div className="mb-5 flex items-center gap-2 text-sm font-extrabold uppercase tracking-[0.12em] text-white dark:text-blue-950"><BookOpen className="h-5 w-5" aria-hidden />{t("ctaEyebrow")}</div>
                <h2 className="font-heading text-[clamp(32px,4vw,46px)] font-semibold leading-[1.1] [text-wrap:balance]">{t("ctaTitle")}</h2>
                <p className="mt-4 text-[17px] font-semibold leading-relaxed text-white dark:text-blue-950">{t("ctaSubtitle")}</p>
              </div>
              <div className="mt-8 flex shrink-0 flex-col items-start gap-3 md:mt-0">
                <Link href="/register" className="clay-btn-primary">{t("joinClass")}<ArrowRight className="h-5 w-5" aria-hidden /></Link>
                <span className="flex items-center gap-2 text-sm font-bold text-white dark:text-blue-950"><LockKeyhole className="h-4 w-4" aria-hidden />{t("lecturerInviteNote")}</span>
              </div>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="border-t-[3px] border-border py-9">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-4 text-sm font-semibold text-muted-foreground sm:px-6">
          <div className="flex items-center gap-2"><span aria-hidden className="grid h-8 w-8 -rotate-4 place-items-center rounded-[10px] bg-primary font-heading text-sm font-bold text-primary-foreground shadow-[0_3px_0_var(--primary-deep)]">E2</span><span className="font-heading text-[17px] font-semibold text-foreground">{tNav("brand")}</span></div>
          <div>{t("footerCopy")}</div>
        </div>
      </footer>
    </div>
  );
}
