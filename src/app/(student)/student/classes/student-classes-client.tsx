"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Sparkles, Layers, ClipboardList, KeyRound, ArrowRight, Loader2 } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { GraduationCapIllustration } from "@/components/illustrations/graduation-cap";

export type StudentClassCard = {
  id: string;
  title: string;
  created_at: string;
  quizCount: number;
};

export function StudentClassesClient({ classes }: { classes: StudentClassCard[] }) {
  const router = useRouter();
  const t = useTranslations("student.classes");
  const tCommon = useTranslations("common");

  const [code, setCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const submitLock = useRef(false);

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (submitLock.current) return;
    setError(null);
    setNotice(null);
    submitLock.current = true;
    setJoining(true);
    try {
      const res = await fetch("/api/classes/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          setNotice(t("alreadyEnrolled"));
        } else {
          setError(body.message ?? body.error ?? tCommon("errorGeneric"));
        }
        return;
      }
      setCode("");
      setNotice(t("joinedNotice", { title: body.class?.title ?? "" }));
      router.refresh();

    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      submitLock.current = false;
      setJoining(false);
    }
  }

  const totalQuizzes = classes.reduce((n, c) => n + c.quizCount, 0);

  return (
    <div className="space-y-8">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-blue-100 via-blue-50 to-orange-50 p-7 shadow-[var(--shadow-clay)] md:p-9">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50" />
        <div aria-hidden className="pointer-events-none absolute -bottom-12 left-1/3 h-28 w-28 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-orange-100/70" />
        <div className="relative">
          <span className="inline-flex items-center gap-2 rounded-full border-[3px] border-border bg-card px-3.5 py-1 text-xs font-extrabold text-accent">
            <Sparkles className="h-4 w-4" aria-hidden /> {t("heroTitle")}
          </span>
          <h1 className="mt-4 font-heading text-3xl font-semibold [text-wrap:balance] md:text-4xl">
            {t("heroSubtitle")}
          </h1>
          <p className="mt-2 max-w-xl text-sm font-semibold text-muted-foreground md:text-base">
            {t("joinCardSubtitle")}
          </p>

          {/* quick stats */}
          <div className="mt-6 grid max-w-md grid-cols-2 gap-4">
            <div className="rounded-2xl border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay-sm)]">
              <div className="flex items-center gap-2 text-primary">
                <Layers className="h-5 w-5" aria-hidden />
                <span className="font-heading text-2xl font-bold">{classes.length}</span>
              </div>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                {t("classCount", { count: classes.length })}
              </p>
            </div>
            <Link href="/student/quizzes" className="block rounded-2xl border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[0_6px_0_var(--border)]">
              <div className="flex items-center gap-2 text-accent">
                <ClipboardList className="h-5 w-5" aria-hidden />
                <span className="font-heading text-2xl font-bold">{totalQuizzes}</span>
              </div>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                {t("liveQuizCount", { count: totalQuizzes })} <span aria-hidden="true">→</span>
              </p>
            </Link>
          </div>
        </div>
      </section>

      {/* ── Join + list ── */}
      <section className="grid items-start gap-6 lg:grid-cols-[340px_1fr]">
        <Card className="lg:sticky lg:top-6">
          <CardHeader>
            <div className="mb-1 grid h-11 w-11 place-items-center rounded-2xl bg-blue-100 text-accent">
              <KeyRound className="h-5 w-5" aria-hidden />
            </div>
            <CardTitle>{t("joinCardTitle")}</CardTitle>
            <CardDescription>
              {t("joinCardSubtitle")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleJoin} className="space-y-4">
              <div>
                <Label htmlFor="join-code" className="sr-only">
                  {t("joinCardTitle")}
                </Label>
                <Input
                  id="join-code"
                  // Stable accessible name for E2E (the sr-only Label follows
                  // i18n copy).
                  aria-label="Join code"
                  placeholder={t("joinCodePlaceholder")}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  maxLength={12}
                  className="font-mono uppercase tracking-widest"
                />
              </div>
              <div aria-live="polite">
                {error && (
                  <p className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive" role="alert">
                    {error}
                  </p>
                )}
                {notice && (
                  <p className="rounded-xl border-[3px] border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm font-bold text-emerald-800" role="status">
                    {notice}
                  </p>
                )}
              </div>
              <Button type="submit" variant="accent" className="w-full" disabled={joining || !code.trim()}>
                {joining ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                    {t("joiningBtn")}
                  </>
                ) : (
                  t("joinBtn")
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Class cards */}
        <div>
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="font-heading text-xl font-semibold">{t("myClasses")}</h2>
            {classes.length > 0 && (
              <span className="text-sm font-extrabold text-muted-foreground">
                {t("classCount", { count: classes.length })}
              </span>
            )}
          </div>

          {classes.length === 0 ? (
            <EmptyState
              illustration={GraduationCapIllustration}
              title={t("emptyTitle")}
              subtitle={t("emptySubtitle")}
              className="rounded-[28px] border-[3px] bg-card/60 px-8 py-16"
            />
          ) : (
            <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
              {classes.map((c) => (
                <li key={c.id}>
                  <Link
                    href="/student/quizzes"
                    className="group flex h-full flex-col rounded-[22px] border-[3px] border-border bg-card p-5 shadow-[var(--shadow-clay)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[8px_10px_0_rgba(194,65,12,0.16)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-blue-100 font-heading text-lg font-bold text-accent">
                        {c.title.trim().charAt(0).toUpperCase()}
                      </span>
                      <span className="rounded-full border-[3px] border-border bg-muted px-2.5 py-0.5 text-xs font-extrabold text-muted-foreground">
                        {t("liveQuizCount", { count: c.quizCount })}
                      </span>
                    </div>
                    <h3 className="mt-3.5 font-heading text-lg font-semibold leading-snug [text-wrap:balance]">
                      {c.title}
                    </h3>
                    <div className="mt-auto flex items-center justify-end pt-3">
                      <span className="inline-flex items-center gap-1 text-sm font-extrabold text-accent transition-transform duration-200 group-hover:translate-x-0.5">
                        {t("viewQuizzes")} <ArrowRight className="h-4 w-4" aria-hidden />
                      </span>
                    </div>
                  </Link>
                </li>
              ))}

              <li>
                <button
                  type="button"
                  onClick={() => document.getElementById("join-code")?.focus()}
                  className="flex h-full min-h-[164px] w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-[22px] border-[3px] border-dashed border-border bg-transparent p-5 text-muted-foreground transition-[border-color,color,transform] duration-200 hover:-translate-y-1 hover:border-accent hover:text-accent"
                >
                  <span className="grid h-10 w-10 place-items-center rounded-2xl border-[3px] border-current">
                    <KeyRound className="h-5 w-5" aria-hidden />
                  </span>
                  <span className="text-sm font-extrabold">{t("joinCardTitle")}</span>
                </button>
              </li>
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
