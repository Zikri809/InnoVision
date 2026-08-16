import Link from "next/link";
import { redirect } from "next/navigation";
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

const features = [
  {
    icon: Hand,
    tint: "bg-orange-100 text-orange-600",
    title: "Wave to Answer",
    body: "Just hold up 1–5 fingers to choose. Our friendly hand-tracking reads your gesture and locks it in.",
  },
  {
    icon: ShieldCheck,
    tint: "bg-blue-100 text-blue-600",
    title: "Friendly Check-ins",
    body: "A quick glance at the camera now and then keeps things fair — no scary proctoring software.",
  },
  {
    icon: Sparkles,
    tint: "bg-green-100 text-green-600",
    title: "Instant Quiz Magic",
    body: "Teachers drop in their notes and — poof! — a ready-to-play quiz appears in seconds.",
  },
  {
    icon: Target,
    tint: "bg-pink-100 text-pink-600",
    title: "Practice & Level Up",
    body: "Try as many times as you want in practice mode, with instant feedback to help you improve.",
  },
  {
    icon: LineChart,
    tint: "bg-yellow-100 text-yellow-600",
    title: "See Your Progress",
    body: "Colorful dashboards show your scores and streaks, so you always know how you're doing.",
  },
  {
    icon: Link2,
    tint: "bg-violet-100 text-violet-600",
    title: "Join in a Snap",
    body: "Pop in a class code, do a one-time face enroll, and you're ready for every quiz.",
  },
] as const;

const stats = [
  { value: "99%", label: "Fair & accurate", accent: false },
  { value: "3×", label: "Faster for teachers", accent: true },
  { value: "0", label: "Apps to install", accent: false },
  { value: "∞", label: "Practice tries", accent: true },
] as const;

const options = ["Stack", "Queue", "Tree", "Graph"] as const;

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Logged-in users skip the marketing page and go straight to their dashboard.
  if (user) redirect("/dashboard");

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden">
      {/* ===== Nav ===== */}
      <header className="sticky top-0 z-50 border-b-[3px] border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-[74px] w-full max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid h-10 w-10 -rotate-4 place-items-center rounded-[14px] bg-primary font-heading text-lg font-bold text-primary-foreground shadow-[0_4px_0_var(--primary-deep)]">
              IV
            </span>
            <span className="font-heading text-[23px] font-semibold">InnoVision</span>
          </Link>
          <nav className="hidden items-center gap-7 md:flex">
            <a href="#features" className="text-[15px] font-bold text-muted-foreground transition-colors hover:text-primary">Features</a>
            <a href="#stats" className="text-[15px] font-bold text-muted-foreground transition-colors hover:text-primary">Why us</a>
            <a href="#cta" className="text-[15px] font-bold text-muted-foreground transition-colors hover:text-primary">Join in</a>
          </nav>
          <div className="flex items-center gap-3">
            <Link href="/login" className="clay-btn-ghost px-5 py-2.5 text-sm">Sign in</Link>
            <Link href="/register" className="clay-btn-primary px-5 py-2.5 text-sm">Play now</Link>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* ===== Hero ===== */}
        <section className="relative overflow-hidden py-16 md:py-24">
          {/* decorative blobs */}
          <div aria-hidden className="pointer-events-none absolute left-[4%] top-16 h-28 w-28 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-orange-200/60" />
          <div aria-hidden className="pointer-events-none absolute right-[8%] top-48 h-20 w-20 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-200/60" />
          <div aria-hidden className="pointer-events-none absolute bottom-16 left-[12%] hidden h-16 w-16 rounded-[50%_50%_42%_58%/55%_48%_52%_45%] bg-pink-200/60 md:block" />

          <div className="mx-auto max-w-6xl px-6 text-center">
            <span className="clay-pill clay-pop">Quizzes just got way more fun</span>
            <h1 className="clay-pop mx-auto mt-6 max-w-3xl font-heading text-[clamp(38px,6.4vw,68px)] font-semibold leading-[1.05] [animation-delay:70ms]">
              Answer with a <span className="text-primary">wave of your hand</span> —{" "}
              <span className="text-accent">no clicks needed!</span>
            </h1>
            <p className="clay-pop mx-auto mt-5 max-w-xl text-[19px] font-semibold text-muted-foreground [animation-delay:140ms]">
              Hold up your fingers to pick an answer. InnoVision watches, cheers you on,
              and keeps everything fair. Learning has never felt this playful.
            </p>
            <div className="clay-pop mt-9 flex flex-wrap items-center justify-center gap-4 [animation-delay:220ms]">
              <Link href="/register" className="clay-btn-primary">Join a class</Link>
              <a href="#features" className="clay-btn-ghost">See the magic</a>
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
              <span className="clay-pill">Why you&apos;ll love it</span>
              <h2 className="mt-4 font-heading text-[clamp(30px,4.4vw,44px)] font-semibold">
                Made for students, loved by teachers
              </h2>
              <p className="mt-3.5 text-[17px] font-semibold text-muted-foreground">
                Friendly, fair, and just a little bit magical.
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
              <h2 className="relative font-heading text-[clamp(28px,4.4vw,44px)] font-semibold">
                Ready to make quizzes the best part of class?
              </h2>
              <p className="relative mx-auto mt-4 max-w-xl text-[17px] font-semibold text-white/90">
                Grab a join code from your teacher and wave your way to better grades.
              </p>
              <Link href="/register" className="clay-btn-primary relative mt-8">Join your class</Link>
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
          <div>© 2025 InnoVision · Learning, but make it fun</div>
        </div>
      </footer>
    </div>
  );
}
