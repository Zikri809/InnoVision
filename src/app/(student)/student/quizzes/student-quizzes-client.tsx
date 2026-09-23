"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ClipboardList, Zap, ShieldCheck, Timer, Play, ScanFace, Layers, Clock, X } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { EmptyBoxIllustration } from "@/components/illustrations/empty-box";
import { formatDuration } from "@/lib/format/duration";
import { getModeLabel } from "@/lib/quizzes/labels";
import { formatDue } from "@/lib/format/window";

type QuizRow = {
  id: string;
  title: string;
  mode: "practice" | "assessment";
  status: "draft" | "live" | "closed";
  time_limit_sec: number | null;
  allow_retake?: boolean | null;
  max_attempts?: number | null;
  /** SQ-1: availability window (QC-3 columns, read-only in this domain). */
  opens_at?: string | null;
  closes_at?: string | null;
  created_at: string;
  classes: { title: string } | null;
  /** SQ-2: latest COMPLETED session id for this quiz, or null. */
  completedSessionId: string | null;
  /** SQ-2: results_revealed_at set (auto-reveal or lecturer reveal). */
  resultsRevealed: boolean;
};

/** SQ-1: "closing soon" styling threshold. */
const CLOSING_SOON_MS = 24 * 60 * 60 * 1000;

export function StudentQuizzesClient({
  quizzes,
  enrolled,
  classFilter = null,
  classFilterTitle = null,
}: {
  quizzes: QuizRow[];
  enrolled: boolean;
  /** SQ-4: ?class=<id> drill-down (server-validated shape; RLS scopes rows). */
  classFilter?: string | null;
  /** SQ-4: the filtered class's title (null when the id is unknown/unenrolled). */
  classFilterTitle?: string | null;
}) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("student.quizzes");
  const tCommon = useTranslations("common");
  // Mobile polish round 3: <sm renders the compact list layout (Flavor 1 —
  // clay glyph rows) via an early return, so the desktop JSX below is
  // untouched and every count()-style desktop assertion stays exact.
  const isMobile = useMediaQuery("(max-width: 639px)");

  const submitLock = useRef(false);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Record<string, string>>({});

  async function handleStart(quizId: string) {
    if (submitLock.current) return;
    setError(null);
    submitLock.current = true;
    setStartingId(quizId);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quizId }),
      });
      const body = await res.json().catch(() => ({}));

      if (res.ok && body.session?.id) {
        router.push(`/play/${body.session.id}`);
        return;
      }

      if (res.status === 409 && body.error === "already_attempted") {
        if (body.session_id) {
          router.push(`/play/${body.session_id}`);
          return;
        }
        setNotice((prev) => ({
          ...prev,
          [quizId]: tCommon("completed"),
        }));
        return;
      }

      if (res.status === 404) {
        setError(tCommon("errorGeneric"));
        return;
      }

      // QC-3 schedule states (enrolled callers legitimately learn them).
      if (res.status === 409 && body.error === "quiz_not_open") {
        setError(t("quizNotOpen"));
        return;
      }
      if (res.status === 409 && body.error === "quiz_window_closed") {
        setError(t("quizWindowClosed"));
        return;
      }

      // audit-5 M2: the assessment face-eligibility gate. Both are 403 client
      // errors, never an outage — show the actionable copy instead of the raw
      // code the fallback would render.
      if (res.status === 403 && body.error === "consent_required") {
        setError(t("consentRequiredStart"));
        return;
      }
      if (res.status === 403 && body.error === "face_enrollment_pending") {
        setError(t("faceEnrollmentPending"));
        return;
      }

      setError(body.message ?? body.error ?? tCommon("errorGeneric"));
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      submitLock.current = false;
      setStartingId(null);
    }
  }

  const practiceCount = quizzes.filter((q) => q.mode === "practice").length;
  const assessmentCount = quizzes.filter((q) => q.mode === "assessment").length;

  // SQ-1: deadline chip state per card. The view is LIVE-only, so "closed"
  // (past closes_at but still listed) only happens under cron lag — styled
  // grey and truthful. Polish round (C6): far-future "Due in N days" chips
  // are DELETED — grey passive chips on every card were noise; only the
  // actionable amber (<24h) chip and the rare closed state remain. A
  // `Date.now()` read in a client component is fine (the render is not
  // SSR-stable-critical; chips re-render per visit).
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  function deadlineChip(q: QuizRow): {
    label: string;
    tone: "amber" | "grey";
  } | null {
    if (!q.closes_at) return null;
    const ts = Date.parse(q.closes_at);
    if (Number.isNaN(ts)) return null;
    if (ts <= nowMs) return { label: t("chipClosed"), tone: "grey" };
    if (ts - nowMs >= CLOSING_SOON_MS) return null;
    const due = formatDue(q.closes_at, locale);
    if (!due) return null;
    return { label: t("chipDue", { due }), tone: "amber" };
  }

  // ═══ Mobile layout (Flavor 1 — clay glyph rows) ═══
  // Same data, same states, same accessible names as desktop: the Start /
  // Mula button, the disabled "Awaiting results" button, the "View results"
  // link (name includes the quiz title) and the amber deadline chip all
  // render per the E46/E40/E37/E5 contracts.
  if (isMobile) {
    return (
      <div className="space-y-4">
        {/* Large title + live line (hero band, stat chips removed) */}
        <section className="pt-1">
          <h1 className="font-heading text-[30px] font-semibold leading-[1.05] [text-wrap:balance]">
            {t("heroTitle")}
          </h1>
          <p className="mt-1.5 flex items-center text-[13px] font-bold text-muted-foreground">
            <span aria-hidden className="mr-2 inline-block size-[7px] shrink-0 animate-pulse rounded-full bg-emerald-500" />
            <span>
              <span className="font-extrabold text-primary">{quizzes.length} {t("statLive")}</span>
              {classFilterTitle ? <> · {classFilterTitle}</> : null}
            </span>
          </p>
        </section>

        {/* SQ-4: removable class filter chip */}
        {classFilter && (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full border-[3px] border-accent/40 bg-blue-100 px-3.5 py-1.5 text-xs font-extrabold text-accent dark:border-accent/40 dark:bg-blue-500/15 dark:text-blue-300">
              {t("filterChipLabel")}
              {classFilterTitle && <span className="text-accent dark:text-blue-300">{classFilterTitle}</span>}
              <Link
                href="/student/quizzes"
                aria-label={t("filterChipRemove")}
                className="hit-slop ml-0.5 grid size-7 place-items-center rounded-full transition-colors hover:bg-blue-200 dark:hover:bg-blue-500/25"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </span>
          </div>
        )}

        {/* Face-enrollment pill — one line (banner body copy lives on the
            enroll screen; the dock's Face Setup tab badge stays as backup) */}
        {!enrolled && (
          <Link
            href="/student/face/enroll"
            className="flex items-center gap-3 border-y-2 border-border py-3 transition-colors active:opacity-70"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-700 dark:border-2 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300">
              <ScanFace className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-extrabold leading-tight text-foreground">
                {t("enrollBannerTitle")}
              </span>
              <span className="block text-[11px] font-bold leading-tight text-muted-foreground">
                {t("enrollPillSub")}
              </span>
            </span>
            <span className="shrink-0 text-[12.5px] font-extrabold text-primary">
              {t("enrollNowBtn")}
            </span>
          </Link>
        )}

        <div aria-live="polite">
          {error && (
            <p className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        {quizzes.length === 0 ? (
          <EmptyState
            illustration={EmptyBoxIllustration}
            title={t("emptyTitle")}
            subtitle={t("emptySubtitle")}
            className="rounded-[22px] border-[3px] bg-card/60 px-6 py-12"
          />
        ) : (
          <ul>
            {quizzes.map((q) => {
              const isPractice = q.mode === "practice";
              const chip = deadlineChip(q);
              // Completed + unrevealed + no retake: the disabled button IS the
              // status — it gets its own full-width line so the wide label
              // doesn't crush the text column, and the meta line skips it.
              const awaitingLocked =
                !isPractice && !!q.completedSessionId && !q.resultsRevealed && !q.allow_retake;

              const glyph = (
                <span
                  className={`grid size-11 shrink-0 place-items-center rounded-2xl shadow-[0_3px_0] ${
                    isPractice
                      ? "bg-emerald-100 text-emerald-600 shadow-emerald-200 dark:border-2 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-300 dark:shadow-none"
                      : "bg-blue-100 text-accent shadow-blue-200 dark:border-2 dark:border-accent/40 dark:bg-blue-500/15 dark:text-blue-300 dark:shadow-none"
                  }`}
                >
                  {isPractice ? <Zap className="h-5 w-5" aria-hidden /> : <ShieldCheck className="h-5 w-5" aria-hidden />}
                </span>
              );

              const text = (
                <span className="min-w-0 flex-1">
                  {/* Fredoka title + inline amber due chip */}
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-heading text-[16.5px] font-medium leading-tight text-foreground [text-wrap:balance]">
                      {q.title}
                    </span>
                    {chip && (
                      <span
                        className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold tabular-nums ${
                          chip.tone === "amber"
                            ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        <Clock className="h-3 w-3" aria-hidden />
                        {chip.label}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] font-bold leading-snug text-muted-foreground">
                    {getModeLabel(q.mode, locale)} · {q.classes?.title ?? "Class"}
                    {q.mode === "assessment" && q.time_limit_sec != null && (
                      <> · {formatDuration(q.time_limit_sec, locale)}</>
                    )}
                    {q.completedSessionId ? null : (
                      <>
                        {" · "}
                        {isPractice
                          ? t("unlimitedTries")
                          : q.allow_retake && (q.max_attempts ?? 1) > 1
                            ? t("retakeAllowed", { count: q.max_attempts ?? 1 })
                            : t("oneAttempt")}
                      </>
                    )}
                  </span>
                  {/* Completed + unrevealed: status sits under the details in
                      amber — reads as a status line, wraps as a whole unit,
                      and can't orphan a separator fragment. */}
                  {q.completedSessionId && !q.resultsRevealed && (
                    <span
                      role="status"
                      className="mt-1.5 inline-flex w-fit items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-extrabold text-amber-800 dark:border dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
                    >
                      <Clock className="h-3 w-3" aria-hidden />
                      {t("cardAwaitingResults")}
                    </span>
                  )}
                </span>
              );

              return (
                <li key={q.id} className="border-b-2 border-border pb-4 pt-4 flex items-center gap-3">
                  {glyph}
                  {text}
                  {/* action column — same contract as desktop; locked rows
                      intentionally end at the text (mobile-only; the disabled
                      "Awaiting results" button remains on ≥sm, where the
                      parked e2e assertions run) */}
                  {notice[q.id] ? (
                    <span className="shrink-0 text-[11px] font-bold text-muted-foreground" role="status">
                      {notice[q.id]}
                    </span>
                  ) : q.completedSessionId && q.resultsRevealed ? (
                    <Link
                      href={`/play/${q.completedSessionId}`}
                      className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-emerald-100 px-3.5 text-[12.5px] font-extrabold text-emerald-800 transition-transform active:scale-95 dark:bg-emerald-500/15 dark:text-emerald-300"
                      aria-label={`${t("cardViewResults")} - ${q.title}`}
                    >
                      {t("cardViewResults")}
                    </Link>
                  ) : !awaitingLocked ? (
                    <Button
                      variant={isPractice ? "default" : "accent"}
                      onClick={() => handleStart(q.id)}
                      disabled={startingId === q.id}
                      className="h-10 shrink-0 rounded-xl px-4"
                    >
                      {startingId === q.id ? t("startingBtn") : t("startBtn")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 dark:from-orange-950/40 dark:via-card dark:to-blue-950/40 p-4 shadow-[var(--shadow-clay)] sm:p-7 md:p-9">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 max-sm:hidden rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50 dark:bg-white/5" />
        <div aria-hidden className="pointer-events-none absolute -bottom-12 left-1/3 h-28 w-28 max-sm:hidden rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-100/60 dark:bg-blue-500/5" />
        <div className="relative">
          <span className="inline-flex max-sm:hidden items-center gap-2 rounded-full border-[3px] border-border bg-card px-3.5 py-1 text-xs font-extrabold text-primary">
            <ClipboardList className="h-4 w-4" aria-hidden /> {t("heroTitle")}
          </span>
          <h1 className="mt-4 max-sm:mt-0 font-heading text-2xl font-semibold [text-wrap:balance] sm:text-3xl md:text-4xl">
            {t("heroSubtitle")}
          </h1>
          <p className="mt-1.5 max-w-xl text-sm font-semibold text-muted-foreground md:text-base">
            {t("unlimitedTries")}
          </p>

          {/* quick stats — compact strip on mobile, cards on sm+ */}
          <div className="mt-3 flex flex-wrap items-center gap-2 sm:hidden">
            <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-border bg-card px-3 py-1 text-xs font-bold text-emerald-600 shadow-[var(--shadow-clay-sm)]">
              <Zap className="h-3.5 w-3.5" aria-hidden />
              <span>{practiceCount} {t("statPractice")}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-border bg-card px-3 py-1 text-xs font-bold text-accent shadow-[var(--shadow-clay-sm)]">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
              <span>{assessmentCount} {t("statAssessment")}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-border bg-card px-3 py-1 text-xs font-bold text-primary shadow-[var(--shadow-clay-sm)]">
              <ClipboardList className="h-3.5 w-3.5" aria-hidden />
              <span>{quizzes.length} {t("statLive")}</span>
            </span>
          </div>

          <div className="mt-6 hidden grid-cols-2 gap-4 sm:grid max-w-lg sm:grid-cols-3">
            <div className="rounded-2xl border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay-sm)]">
              <div className="flex items-center gap-2 text-emerald-600">
                <Zap className="h-5 w-5" aria-hidden />
                <span className="font-heading text-2xl font-bold tabular-nums">{practiceCount}</span>
              </div>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">{t("statPractice")}</p>
            </div>
            <div className="rounded-2xl border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay-sm)]">
              <div className="flex items-center gap-2 text-accent">
                <ShieldCheck className="h-5 w-5" aria-hidden />
                <span className="font-heading text-2xl font-bold tabular-nums">{assessmentCount}</span>
              </div>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">{t("statAssessment")}</p>
            </div>
            <div className="rounded-2xl border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay-sm)]">
              <div className="flex items-center gap-2 text-primary">
                <ClipboardList className="h-5 w-5" aria-hidden />
                <span className="font-heading text-2xl font-bold tabular-nums">{quizzes.length}</span>
              </div>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">{t("statLive")}</p>
            </div>
          </div>
        </div>
      </section>

      <div aria-live="polite">
        {error && (
          <p className="rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>

      {!enrolled && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-[24px] border-[3px] border-amber-300 bg-amber-50 p-5 shadow-[0_4px_0_rgba(217,119,6,0.15)] dark:border-amber-500/40 dark:bg-amber-500/10 dark:shadow-none">
          <div className="flex items-start gap-3.5">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-amber-100 text-amber-700 dark:border-[3px] dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300">
              <ScanFace className="h-6 w-6" aria-hidden />
            </span>
            <div>
              <p className="font-heading text-base font-semibold text-amber-800 dark:text-amber-200">
                {t("enrollBannerTitle")}
              </p>
              <p className="mt-1 max-w-md text-sm font-semibold text-amber-700 dark:text-amber-300">
                {t("enrollBannerBody")}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => router.push("/student/face/enroll")}
          >
            {t("enrollNowBtn")}
          </Button>
        </div>
      )}

      {/* ── SQ-4: removable class filter chip ── */}
      {classFilter && (
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border-[3px] border-accent/40 bg-blue-100 px-3.5 py-1.5 text-xs font-extrabold text-accent dark:border-accent/40 dark:bg-blue-500/15 dark:text-blue-300">
            {t("filterChipLabel")}
            {classFilterTitle && <span className="text-accent dark:text-blue-300">{classFilterTitle}</span>}
            <Link
              href="/student/quizzes"
              aria-label={t("filterChipRemove")}
              className="hit-slop ml-0.5 grid size-7 place-items-center rounded-full transition-colors hover:bg-blue-200 dark:hover:bg-blue-500/25"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </span>
        </div>
      )}

      {/* ── Quiz cards ── */}
      {quizzes.length === 0 ? (
        <EmptyState
          illustration={EmptyBoxIllustration}
          title={t("emptyTitle")}
          subtitle={t("emptySubtitle")}
          className="rounded-[28px] border-[3px] bg-card/60 px-8 py-16"
        />
      ) : (
        <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
          {quizzes.map((q) => {
            const isPractice = q.mode === "practice";
            const chip = deadlineChip(q);
            return (
              <li key={q.id}>
                <Card className="flex h-full flex-col transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[8px_10px_0_rgba(194,65,12,0.16)] max-sm:active:translate-y-[3px]">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-3">
                      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${
                        isPractice
                          ? "bg-emerald-100 text-emerald-600 dark:border-[3px] dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-300"
                          : "bg-blue-100 text-accent dark:border-[3px] dark:border-accent/40 dark:bg-blue-500/15 dark:text-blue-300"
                      }`}>
                        {isPractice ? <Zap className="h-6 w-6" aria-hidden /> : <ShieldCheck className="h-6 w-6" aria-hidden />}
                      </span>
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                        <span className={`rounded-full border-[3px] px-3 py-1 text-xs font-extrabold ${
                          isPractice
                            ? "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-300"
                            : "border-accent/40 bg-blue-100 text-accent dark:border-accent/40 dark:bg-blue-500/15 dark:text-blue-300"
                        }`}>
                          {getModeLabel(q.mode, locale)}
                        </span>
                        {q.mode === "assessment" && q.time_limit_sec != null && (
                          <span className="inline-flex items-center gap-1 rounded-full border-[3px] border-border bg-muted px-3 py-1 text-xs font-extrabold tabular-nums text-muted-foreground">
                            <Timer className="h-3.5 w-3.5" aria-hidden />
                            {formatDuration(q.time_limit_sec, locale)}
                          </span>
                        )}
                      </div>
                    </div>
                    <CardTitle className="text-lg [text-wrap:balance]">{q.title}</CardTitle>
                    <CardDescription>
                      {q.classes?.title ?? "Class"}
                    </CardDescription>
                    {chip && (
                      // SQ-1: deadline chip. Amber = closing within 24h
                      // (future); grey = comfortably open or cron-lag closed.
                      // Plain span, no role="status" — the label is static
                      // after mount, and a live region would make SRs
                      // announce every card's chip on page load.
                      <span
                        className={`mt-2 inline-flex w-fit items-center gap-1.5 rounded-full border-[3px] px-3 py-1 text-xs font-extrabold tabular-nums ${
                          chip.tone === "amber"
                            ? "border-amber-300 bg-amber-50 text-amber-800"
                            : "border-border bg-muted text-muted-foreground"
                        }`}
                      >
                        <Clock className="h-3.5 w-3.5" aria-hidden />
                        {chip.label}
                      </span>
                    )}
                  </CardHeader>
                  <CardContent className="mt-auto flex max-sm:flex-col max-sm:items-stretch max-sm:gap-2 items-center justify-between gap-3 pt-1">
                    {notice[q.id] ? (
                      <p className="text-sm font-bold text-muted-foreground" role="status">
                        {notice[q.id]}
                      </p>
                    ) : q.completedSessionId && q.resultsRevealed ? (
                      // SQ-2: completed + revealed → real link, accessible
                      // name includes the quiz title (never identical "View
                      // results" ×N for screen readers).
                      <Link
                        href={`/play/${q.completedSessionId}`}
                        className="inline-flex items-center gap-1.5 rounded-full border-[3px] border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-extrabold text-emerald-800 transition-colors hover:bg-emerald-100"
                        aria-label={`${t("cardViewResults")} - ${q.title}`}
                      >
                        <ScanFace className="h-3.5 w-3.5" aria-hidden />
                        {t("cardViewResults")}
                      </Link>
                    ) : q.completedSessionId ? (
                      // SQ-2: completed + NOT revealed → "Awaiting results".
                      // With retake: a status chip — it reflects completed
                      // attempt 1 while the Start button reflects the
                      // resumable attempt 2 (coexistence pinned by E40).
                      q.allow_retake ? (
                        <span className="rounded-full border-[3px] border-border bg-muted px-3 py-1 text-xs font-extrabold text-muted-foreground" role="status">
                          {t("cardAwaitingResults")}
                        </span>
                      ) : null
                    ) : (
                      <span className="text-sm font-semibold text-muted-foreground">
                        {isPractice
                          ? t("unlimitedTries")
                          : q.allow_retake && (q.max_attempts ?? 1) > 1
                            ? t("retakeAllowed", { count: q.max_attempts ?? 1 })
                            : t("oneAttempt")}
                      </span>
                    )}
                    {!isPractice && q.completedSessionId && !q.resultsRevealed && !q.allow_retake ? (
                      // Completed + unrevealed + no retake: one affordance —
                      // the disabled button itself carries the awaiting state.
                      // sm:ml-auto pins it to the right action column even
                      // when it's the footer's only child (justify-between
                      // would otherwise strand a lone child on the LEFT,
                      // mixing button placements across the grid).
                      <Button
                        variant="outline"
                        disabled
                        className="cursor-not-allowed opacity-70 sm:ml-auto max-sm:w-full max-sm:justify-center"
                      >
                        {t("cardAwaitingResults")}
                      </Button>
                    ) : (
                      <Button
                        variant={isPractice ? "default" : "accent"}
                        onClick={() => handleStart(q.id)}
                        disabled={startingId === q.id}
                        className="sm:ml-auto max-sm:w-full max-sm:justify-center"
                      >
                        <Play className="h-4 w-4" aria-hidden />
                        {startingId === q.id ? t("startingBtn") : t("startBtn")}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}

          <li>
            <Link
              href="/student/classes"
              className="group flex h-full min-h-[180px] w-full flex-col items-center justify-center gap-2 rounded-[22px] border-[3px] border-dashed border-border bg-transparent p-6 text-center text-muted-foreground transition-[border-color,color,transform] duration-200 hover:-translate-y-1 hover:border-primary hover:text-primary"
            >
              <span className="grid h-11 w-11 place-items-center rounded-2xl border-[3px] border-current">
                <Layers className="h-5 w-5" aria-hidden />
              </span>
              <span className="text-sm font-extrabold">{tCommon("myClasses")}</span>
            </Link>
          </li>
        </ul>
      )}
    </div>
  );
}
