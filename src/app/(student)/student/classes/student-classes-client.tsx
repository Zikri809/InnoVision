"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import {
  ResponsiveModal,
  ResponsiveModalClose,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { Sparkles, Layers, ClipboardList, KeyRound, ArrowRight, Loader2, Plus } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { GraduationCapIllustration } from "@/components/illustrations/graduation-cap";
import { cn } from "@/lib/utils";

export type StudentClassCard = {
  id: string;
  title: string;
  created_at: string;
  quizCount: number;
};

const JOIN_CODE_LENGTH = 6;

export function StudentClassesClient({ classes }: { classes: StudentClassCard[] }) {
  const router = useRouter();
  const t = useTranslations("student.classes");
  const tCommon = useTranslations("common");

  const [joinOpen, setJoinOpen] = useState(false);
  const [code, setCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(false);

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (submitLock.current) return;
    setError(null);
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
          toast.info(t("alreadyEnrolled"));
        } else {
          setError(body.message ?? body.error ?? tCommon("errorGeneric"));
        }
        return;
      }
      setCode("");
      toast.success(t("joinedNotice", { title: body.class?.title ?? "" }));
      // Success beat: let the toast land, then dismiss the drawer.
      setTimeout(() => setJoinOpen(false), 900);
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
    <div className="space-y-6 pb-24 sm:space-y-8 sm:pb-0">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-blue-100 via-blue-50 to-orange-50 dark:from-blue-950/40 dark:via-card dark:to-orange-950/40 p-5 shadow-[var(--shadow-clay)] sm:p-7 md:p-9">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 max-sm:hidden rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50 dark:bg-white/5" />
        <div aria-hidden className="pointer-events-none absolute -bottom-12 left-1/3 h-28 w-28 max-sm:hidden rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-orange-100/70 dark:bg-orange-500/5" />
        <div className="relative">
          {/* Hero chrome is a desktop flourish (polish plan W2): below sm
              the chip + blobs + gradient card shrink to a flat section —
              the H1 is the page's first viewport statement. */}
          <span className="inline-flex max-sm:hidden items-center gap-2 rounded-full border-[3px] border-border bg-card px-3.5 py-1 text-xs font-extrabold text-accent">
            <Sparkles className="h-4 w-4" aria-hidden /> {t("heroTitle")}
          </span>
          <h1 className="mt-4 max-sm:mt-0 font-heading text-3xl max-sm:text-2xl font-semibold [text-wrap:balance] md:text-4xl">
            {t("heroSubtitle")}
          </h1>
          <p className="mt-2 max-w-xl text-sm font-semibold text-muted-foreground md:text-base">
            {t("joinCardSubtitle")}
          </p>

          {/* quick stats — zero-state rule (plan W2): never render zero stat
              cards as the product's opening statement. Below sm with no
              classes the strip is replaced by one caption line. */}
          {classes.length === 0 ? (
            <></>
          ) : (
            <>
              <div className="mt-6 grid max-w-md grid-cols-2 gap-4 max-sm:hidden">
                <div className="rounded-2xl border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay-sm)]">
                  <div className="flex items-center gap-2 text-primary">
                    <Layers className="h-5 w-5" aria-hidden />
                    <span className="font-heading text-2xl font-bold tabular-nums">{classes.length}</span>
                  </div>
                  <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                    {t("classCount", { count: classes.length })}
                  </p>
                </div>
                <Link href="/student/quizzes" className="block rounded-2xl border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[0_6px_0_var(--border)]">
                  <div className="flex items-center gap-2 text-accent">
                    <ClipboardList className="h-5 w-5" aria-hidden />
                    <span className="font-heading text-2xl font-bold tabular-nums">{totalQuizzes}</span>
                  </div>
                  <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                    {t("liveQuizCount", { count: totalQuizzes })} <span aria-hidden="true">→</span>
                  </p>
                </Link>
              </div>
              <p className="mt-4 text-xs font-extrabold text-muted-foreground sm:hidden">
                {/* classCount/liveQuizCount already embed the number (ICU
                    plural) — prefixing it again rendered "8 8 Classes". */}
                {t("classCount", { count: classes.length })} ·{" "}
                {t("liveQuizCount", { count: totalQuizzes })}
              </p>
            </>
          )}
        </div>
      </section>

      {/* ── Class list ── */}
      <section>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-heading text-xl font-semibold">{t("myClasses")}</h2>
          {classes.length > 0 ? (
            <div className="flex items-center gap-3">
              <span className="text-sm font-extrabold text-muted-foreground">
                {t("classCount", { count: classes.length })}
              </span>
              {/* Desktop counterpart of the mobile FAB (the sticky join card
                  is gone; the top navbar stays untouched). Hidden <sm where
                  the FAB owns the action — the two never coexist, so the
                  shared "Join a class" name stays strict-mode-safe. */}
              <Button variant="ghost" className="hidden sm:inline-flex" onClick={() => setJoinOpen(true)}>
                <KeyRound className="mr-2 h-4 w-4" aria-hidden />
                {t("joinCardTitle")}
              </Button>
            </div>
          ) : null}
        </div>

        {classes.length === 0 ? (
          // Zero-state rule (plan W2): with no classes the empty state owns
          // the join CTA — one button opens the same join drawer (the form
          // exists in exactly one place, so `aria-label="Join code"` is
          // unique for helpers.joinClass).
          <div className="rounded-[28px] border-[3px] bg-card/60 px-5 py-6 sm:px-8 sm:py-16">
            <EmptyState
              illustration={GraduationCapIllustration}
              title={t("emptyTitle")}
              subtitle={t("emptySubtitle")}
              className="border-0 px-0 py-2 sm:border-2 sm:px-6 sm:py-10"
              iconClassName="h-12 sm:h-16"
            />
            <div className="mx-auto mt-4 max-w-sm sm:mt-6">
              <Button variant="accent" className="w-full" onClick={() => setJoinOpen(true)}>
                <KeyRound className="mr-2 h-4 w-4" aria-hidden />
                {t("joinCta")}
              </Button>
            </div>
          </div>
        ) : (
          <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,240px),1fr))]">
            {classes.map((c) => (
              <li key={c.id}>
                <Link
                  // SQ-4: drill-down — the quizzes list filters to this class
                  // (?class=<id>). A2 row tile: the whole card is the tap
                  // target — no nested fake-link, no "View quizzes" verb (the
                  // chevron says drill-down). ≥lg keeps the chunky tile feel
                  // via the shared clay card classes below.
                  href={`/student/quizzes?class=${c.id}`}
                  className="group flex items-center gap-3.5 rounded-[22px] border-[3px] border-border bg-card p-4 shadow-[var(--shadow-clay)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[8px_10px_0_rgba(194,65,12,0.16)] active:translate-y-[3px] active:shadow-[0_2px_0_rgba(194,65,12,0.16)] focus-visible:outline-[3px] focus-visible:outline-ring focus-visible:outline-offset-2"
                >
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-blue-100 font-heading text-lg font-bold text-accent dark:bg-blue-950/50">
                    {c.title.trim().charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-heading text-base font-semibold leading-snug">
                      {c.title}
                    </span>
                    <span className="mt-0.5 block text-xs font-extrabold text-muted-foreground">
                      {t("liveQuizCount", { count: c.quizCount })}
                    </span>
                    {/* Accessible name preserved for e2e (11 specs click
                        link /View quizzes/i); visually the chevron alone. */}
                    <span className="sr-only">{t("viewQuizzes")}</span>
                  </span>
                  <span
                    aria-hidden
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-[11px] border-[3px] border-border bg-card text-accent transition-transform duration-200 group-hover:translate-x-0.5"
                  >
                    <ArrowRight className="h-4 w-4" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Join drawer ──
          One form, one place. FAB (classes exist) and the empty-state CTA
          both open this. Desktop (≥sm) renders as a centered dialog via
          ResponsiveModal; mobile is a vaul bottom drawer with handleOnly
          drag + repositionInputs (keyboard-safe). */}
      {classes.length > 0 && <JoinFAB onClick={() => setJoinOpen(true)} label={t("joinCardTitle")} />}

      <ResponsiveModal open={joinOpen} onOpenChange={(open) => { setJoinOpen(open); if (!open) setError(null); }}>
        {/* Actions live INLINE (not ResponsiveModalContent footer): the
            footer prop is drawer-only and would drop the submit button on
            the desktop dialog surface. */}
        <ResponsiveModalContent className="sm:max-w-sm">
          {/* Inline icon header (approved preview): icon tile left of the
              title + subtitle block. */}
          <ResponsiveModalHeader className="flex-row items-center gap-3.5 pb-5 text-left">
            <div className="grid size-12 shrink-0 place-items-center rounded-[15px] bg-blue-100 text-accent dark:bg-blue-950/50">
              <KeyRound className="h-6 w-6" aria-hidden />
            </div>
            <div className="min-w-0">
              <ResponsiveModalTitle>{t("joinCardTitle")}</ResponsiveModalTitle>
              <ResponsiveModalDescription>
                {t("joinDrawerSubtitle")}
              </ResponsiveModalDescription>
            </div>
          </ResponsiveModalHeader>
          <form id="join-class-form" onSubmit={handleJoin} className="space-y-6">
            {/* e2e contract: `aria-label="Join code"` lives on the OTP
                hidden input (helpers.joinClass + 6 specs fill it by label).
                autoComplete="one-time-code" offers SMS/paste codes on
                mobile; uppercase + chars-only is enforced by input-otp
                filtering. */}
            <div className="flex justify-center py-2">
              <InputOTP
                aria-label="Join code"
                maxLength={JOIN_CODE_LENGTH}
                value={code}
                onChange={setCode}
                autoComplete="one-time-code"
                autoFocus
                containerClassName="gap-2.5"
              >
                <InputOTPGroup className="gap-2.5">
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                </InputOTPGroup>
                <InputOTPSeparator />
                <InputOTPGroup className="gap-2.5">
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>
            <div aria-live="polite">
              {error && (
                <p className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-center text-sm font-bold text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
            {/* Buttons mirror the OTP row width and center with it — the
                action pair reads as one block instead of full-bleed bars. */}
            <div className="mx-auto flex w-[min(100%,320px)] justify-center gap-3 pt-2">
              <ResponsiveModalClose asChild>
                <Button variant="outline" className="h-12 flex-1 rounded-[16px] text-base">{t("cancelBtn")}</Button>
              </ResponsiveModalClose>
              <Button variant="accent" className="h-12 flex-1 rounded-[16px] text-base" type="submit" disabled={joining || code.length < JOIN_CODE_LENGTH}>
                {joining ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                    {t("joiningBtn")}
                  </>
                ) : (
                  t("joinBtn")
                )}
              </Button>
            </div>
          </form>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}

/**
 * Scroll-aware join FAB (mobile only — the desktop join entry is the drawer
 * opened from the empty state / hero, and ≥sm the FAB would fight the
 * layout's max-width rhythm). Ducks below the dock while scrolling down so
 * it never covers a card's chevron mid-read; springs back on scroll-up or
 * near the top. Listens on window scroll — AppShell is the scroll
 * container on mobile.
 */
function JoinFAB({ onClick, label }: { onClick: () => void; label: string }) {
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);

  useEffect(() => {
    lastY.current = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const goingDown = y > lastY.current;
      setHidden(goingDown && y > 40);
      lastY.current = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        // Mirrors the My Quizzes create FAB exactly (same posture, hide
        // recipe, and bottom offset that clears the flat dock): one FAB
        // language across student pages.
        "fixed bottom-[calc(104px+var(--safe-bottom))] right-3 z-40 grid size-14 cursor-pointer place-items-center rounded-[19px] border-[3px] border-transparent bg-primary text-[#fff7ed] sm:hidden",
        "shadow-[0_5px_0_var(--primary-deep)]",
        "transition-[transform,opacity,box-shadow] duration-200 ease-out",
        "active:translate-y-[3px] active:shadow-[0_2px_0_var(--primary-deep)]",
        "focus-visible:outline-[3px] focus-visible:outline-ring focus-visible:outline-offset-2",
        hidden && "pointer-events-none translate-y-24 opacity-0",
      )}
    >
      <Plus className="h-6 w-6" aria-hidden />
    </button>
  );
}
