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
import {
  GraduationCap,
  Layers,
  ClipboardList,
  Plus,
  ArrowRight,
  Archive,
  Loader2,
  SquarePen,
} from "lucide-react";
import {
  ResponsiveModal,
  ResponsiveModalTrigger,
  ResponsiveModalClose,
  ResponsiveModalContent,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalDescription,
} from "@/components/ui/responsive-modal";
import type { LecturerClassCard } from "@/lib/types/aliases";
import { EmptyState } from "@/components/ui/empty-state";
import { EmptyBoxIllustration } from "@/components/illustrations/empty-box";

/**
 * Lecturer "My Classes" dashboard — hero band, quick stats, active classes
 * grid, and a dedicated archived section for audit and dispute safety.
 *
 * Create-class surfaces mirror the student join flow (one form, one place):
 * scroll-aware FAB <sm, section-header button ≥lg, sticky sidebar card ≥lg.
 * The A2 row card keeps the join code visible (the lecturer's share-out) and
 * the whole card is the tap target.
 */
export function ClassesPageClient({
  classes,
  archivedCount = 0,
}: {
  classes: LecturerClassCard[];
  archivedCount?: number;
}) {
  const router = useRouter();
  const t = useTranslations("lecturer.classes");
  const tCommon = useTranslations("common");

  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mobileCreateOpen, setMobileCreateOpen] = useState(false);

  // Ref lock guards against a fast double-click before React re-renders.
  const submitLock = useRef(false);

  const activeClasses = classes.filter((c) => !c.archived_at);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (submitLock.current) return;
    setError(null);
    submitLock.current = true;
    setCreating(true);
    try {
      const res = await fetch("/api/classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? tCommon("errorGeneric"));
        return;
      }
      setTitle("");
      setMobileCreateOpen(false);
      router.refresh();
    } catch {
      setError(tCommon("errorGeneric"));
    } finally {
      submitLock.current = false;
      setCreating(false);
    }
  }

  const totalQuizzes = activeClasses.reduce((n, c) => n + c.quizCount, 0);

  // ONE form definition, two surfaces (sidebar ≥lg + drawer <lg). The
  // id/htmlFor pair is unique per instance — a shared id made BOTH labels
  // resolve to the first (hidden) input in DOM order, stripping the drawer
  // field's accessible name and breaking getByLabel("Class title"). Cancel
  // is a parameter: ResponsiveModalClose throws outside a Dialog context,
  // and the sidebar renders this form with no dialog mounted.
  const createForm = (idSuffix: string, cancel: React.ReactNode = null) => (
    <form onSubmit={handleCreate} className="space-y-4">
      <div>
        <Label htmlFor={`class-title-${idSuffix}`} className="sr-only">
          {t("classTitleLabel")}
        </Label>
        <Input
          id={`class-title-${idSuffix}`}
          placeholder={t("classTitlePlaceholder")}
          value={title}
          disabled={creating}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={200}
          className="h-12 rounded-[16px]"
        />
      </div>
      <div aria-live="polite">
        {error && (
          <p className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="flex gap-3">
        {cancel}
        <Button type="submit" className="h-12 flex-1 rounded-[16px] text-base font-bold" disabled={creating || !title.trim()}>
          {creating ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              {t("creatingBtn")}
            </>
          ) : (
            t("createBtn")
          )}
        </Button>
      </div>
    </form>
  );

  return (
    <div className="space-y-6 pb-24 sm:space-y-8 sm:pb-0">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 dark:from-orange-950/40 dark:via-card dark:to-blue-950/40 p-4 shadow-[var(--shadow-clay)] sm:p-7 md:p-9">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 max-sm:hidden rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50 dark:bg-white/5" />
        <div aria-hidden className="pointer-events-none absolute -bottom-12 left-1/3 h-28 w-28 max-sm:hidden rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-100/60 dark:bg-blue-500/5" />
        <div className="relative">
          <span className="inline-flex max-sm:hidden items-center gap-2 rounded-full border-[3px] border-border bg-card px-3.5 py-1 text-xs font-extrabold text-primary">
            <GraduationCap className="h-4 w-4" aria-hidden /> {t("heroTitle")}
          </span>
          <h1 className="mt-4 max-sm:mt-0 font-heading text-2xl font-semibold [text-wrap:balance] sm:text-3xl md:text-4xl">
            {t("heroSubtitle")}
          </h1>
          <p className="mt-1.5 max-w-xl text-sm font-semibold text-muted-foreground md:text-base">
            {t("createCardSubtitle")}
          </p>

          {/* quick stats (desktop: cards, mobile: compact inline strip) */}
          <div className="mt-3 flex flex-wrap items-center gap-2 sm:hidden">
            <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-border bg-card px-3 py-1 text-xs font-bold text-primary shadow-[var(--shadow-clay-sm)]">
              <Layers className="h-3.5 w-3.5" aria-hidden />
              <span>{t("classCount", { count: activeClasses.length })}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-border bg-card px-3 py-1 text-xs font-bold text-accent shadow-[var(--shadow-clay-sm)]">
              <ClipboardList className="h-3.5 w-3.5" aria-hidden />
              <span>{t("quizCount", { count: totalQuizzes })}</span>
            </span>
            {archivedCount > 0 && (
              <Link
                href="/lecturer/classes/archived"
                className="inline-flex items-center gap-1.5 rounded-full border-2 border-border bg-card px-3 py-1 text-xs font-bold text-muted-foreground shadow-[var(--shadow-clay-sm)] hover:text-primary"
              >
                <Archive className="h-3.5 w-3.5" aria-hidden />
                <span>{t("archivedClassesLabel")}: {archivedCount}</span>
              </Link>
            )}
          </div>

          <div className="mt-6 hidden grid-cols-2 gap-4 sm:grid max-w-lg sm:grid-cols-3">
            <div className="rounded-2xl border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay-sm)]">
              <div className="flex items-center gap-2 text-primary">
                <Layers className="h-5 w-5" aria-hidden />
                <span className="font-heading text-2xl font-bold">{activeClasses.length}</span>
              </div>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                {t("classCount", { count: activeClasses.length })}
              </p>
            </div>

            <div className="rounded-2xl border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay-sm)]">
              <div className="flex items-center gap-2 text-accent">
                <ClipboardList className="h-5 w-5" aria-hidden />
                <span className="font-heading text-2xl font-bold">{totalQuizzes}</span>
              </div>
              <p className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                {t("quizCount", { count: totalQuizzes })}
              </p>
            </div>

            {archivedCount > 0 && (
              <Link
                href="/lecturer/classes/archived"
                className="group col-span-2 rounded-2xl border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay-sm)] transition-[transform,box-shadow,border-color] duration-180 hover:-translate-y-0.5 hover:border-primary/50 sm:col-span-1"
                aria-label={t("viewArchivedClassesAria", { count: archivedCount })}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-muted-foreground group-hover:text-primary">
                    <Archive className="h-5 w-5" aria-hidden />
                    <span className="font-heading text-2xl font-bold">{archivedCount}</span>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform duration-180 group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
                </div>
                <p className="mt-0.5 text-xs font-extrabold text-muted-foreground group-hover:text-foreground">
                  {t("archivedClassesLabel")}
                </p>
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* ── Create + list ── */}
      <section>
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="font-heading text-xl font-semibold">{t("myClasses")}</h2>
            {activeClasses.length > 0 && (
              <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-extrabold text-primary">
                {activeClasses.length}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Create trigger <lg (≥lg has the sticky sidebar card). The
                dock's center "+" also creates classes via the action sheet —
                this header button is the direct single-purpose shortcut that
                the e2e helper's "New Class" exact-match relies on. */}
            <ResponsiveModal open={mobileCreateOpen} onOpenChange={(open) => { setMobileCreateOpen(open); if (!open) setError(null); }}>
              <ResponsiveModalTrigger asChild>
                <Button
                  size="xs"
                  className="hit-slop h-8 max-sm:h-8 gap-1.5 rounded-xl px-3 text-xs font-bold lg:hidden shadow-[0_2px_0_var(--primary-deep)]"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  <span>{t("newClassBtn")}</span>
                </Button>
              </ResponsiveModalTrigger>
              <ResponsiveModalContent className="sm:max-w-sm">
                <ResponsiveModalHeader className="flex-row items-center gap-3.5 pb-5 text-left">
                  <div className="grid size-12 shrink-0 place-items-center rounded-[15px] bg-orange-100 text-primary dark:bg-orange-950/50">
                    <SquarePen className="h-6 w-6" aria-hidden />
                  </div>
                  <div className="min-w-0">
                    <ResponsiveModalTitle>{t("createCardTitle")}</ResponsiveModalTitle>
                    <ResponsiveModalDescription>
                      {t("createCardSubtitle")}
                    </ResponsiveModalDescription>
                  </div>
                </ResponsiveModalHeader>
                <div className="pt-2">
                  {createForm(
                    "mobile",
                    <ResponsiveModalClose asChild>
                      <Button type="button" variant="ghost" className="h-12 flex-1 rounded-[16px] text-base">
                        {t("cancelBtn")}
                      </Button>
                    </ResponsiveModalClose>,
                  )}
                </div>
              </ResponsiveModalContent>
            </ResponsiveModal>

            {archivedCount > 0 && activeClasses.length === 0 && (
              <Link
                href="/lecturer/classes/archived"
                className="inline-flex items-center gap-1.5 rounded-full border-[3px] border-border bg-card px-3.5 py-1 text-xs font-extrabold text-muted-foreground shadow-[var(--shadow-clay-sm)] transition-[transform,border-color,color] duration-180 hover:-translate-y-0.5 hover:border-primary hover:text-primary active:translate-y-0 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40"
              >
                <Archive className="h-3.5 w-3.5" aria-hidden />
                <span>{t("viewArchivedClasses", { count: archivedCount })}</span>
                <ArrowRight className="h-3 w-3" aria-hidden />
              </Link>
            )}
          </div>
        </div>

        {activeClasses.length === 0 ? (
          <EmptyState
            illustration={EmptyBoxIllustration}
            title={t("emptyTitle")}
            subtitle={t("emptySubtitle")}
            className="rounded-[28px] border-[3px] bg-card/60 px-8 py-16"
            action={
              archivedCount > 0 ? (
                <p className="mt-4 text-xs font-semibold text-muted-foreground">
                  <Link
                    href="/lecturer/classes/archived"
                    className="font-extrabold text-primary underline underline-offset-4 hover:text-primary/80 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40"
                  >
                    {t("viewArchivedClasses", { count: archivedCount })} →
                  </Link>
                </p>
              ) : null
            }
          />
        ) : (
          <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,240px),1fr))]">
            {activeClasses.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/lecturer/classes/${c.id}`}
                  className="group flex items-center gap-3.5 rounded-[22px] border-[3px] border-border bg-card p-4 shadow-[var(--shadow-clay)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[8px_10px_0_rgba(194,65,12,0.16)] active:translate-y-[3px] active:shadow-[0_2px_0_rgba(194,65,12,0.16)] focus-visible:outline-[3px] focus-visible:outline-ring focus-visible:outline-offset-2"
                >
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-primary/15 font-heading text-lg font-bold text-primary">
                    {c.title.trim().charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-heading text-base font-semibold leading-snug">
                      {c.title}
                    </span>
                    <span className="mt-0.5 flex items-center gap-2 text-xs font-extrabold text-muted-foreground">
                      <span>{t("quizCount", { count: c.quizCount })}</span>
                      {/* The join code is the lecturer's share-out — keep it
                          one glance away, mono + tracking as before. */}
                      <span className="rounded-full border-2 border-border bg-muted px-2 font-mono text-[10.5px] font-bold tracking-wider">
                        {c.join_code}
                      </span>
                    </span>
                  </span>
                  <span
                    aria-hidden
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-[11px] border-[3px] border-border bg-card text-primary transition-transform duration-200 group-hover:translate-x-0.5"
                  >
                    <ArrowRight className="h-4 w-4" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Desktop sticky sidebar create card (≥lg). Hidden <lg where the
          header button + drawer own the flow. */}
      <Card className="hidden lg:block lg:sticky lg:top-6">
        <CardHeader>
          <div className="mb-1 grid h-11 w-11 place-items-center rounded-2xl bg-orange-100 text-primary">
            <Plus className="h-5 w-5" aria-hidden />
          </div>
          <CardTitle>{t("createCardTitle")}</CardTitle>
          <CardDescription>
            {t("createCardSubtitle")}
          </CardDescription>
        </CardHeader>
        <CardContent>{createForm("desktop")}</CardContent>
      </Card>

      {/* ── Mobile create drawer ──
          One form, one place. The header "New Class" button (above) is the
          trigger; the dock's center "+" opens the general action sheet.
          vaul drawer <sm keeps the input above the keyboard
          (repositionInputs); dialog ≥sm. */}
    </div>
  );
}
