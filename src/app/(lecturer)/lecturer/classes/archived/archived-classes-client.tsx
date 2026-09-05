"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ClipboardList,
  RotateCcw,
  Search,
  X,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { filterArchivedClasses } from "@/lib/classes/search";
import type { ArchivedClassCard } from "@/lib/types/aliases";
import { EmptyState } from "@/components/ui/empty-state";
import { EmptyBoxIllustration } from "@/components/illustrations/empty-box";
import { MagnifyingGlassIllustration } from "@/components/illustrations/magnifying-glass";

export function ArchivedClassesClient({ classes }: { classes: ArchivedClassCard[] }) {
  const t = useTranslations("lecturer.archivedClasses");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();

  const [searchQuery, setSearchQuery] = useState("");
  const [confirmClass, setConfirmClass] = useState<ArchivedClassCard | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const filteredClasses = useMemo(() => {
    return filterArchivedClasses(classes, searchQuery);
  }, [classes, searchQuery]);

  async function handleConfirmRestore(classId: string) {
    if (restoringId) return;
    setRestoreError(null);
    setRestoringId(classId);
    try {
      const res = await fetch(`/api/classes/${classId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRestoreError(body.message || t("restoreErrorGeneric"));
        return;
      }
      setConfirmClass(null);
      router.refresh();
    } catch {
      setRestoreError(t("restoreErrorGeneric"));
    } finally {
      setRestoringId(null);
    }
  }

  function formatArchivedDate(dateStr: string | null) {
    if (!dateStr) return "";
    try {
      return new Intl.DateTimeFormat(locale === "ms" ? "ms-MY" : "en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kuala_Lumpur",
      }).format(new Date(dateStr));
    } catch {
      return dateStr;
    }
  }

  return (
    <div className="space-y-8">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 dark:from-orange-950/40 dark:via-card dark:to-blue-950/40 p-6 shadow-[var(--shadow-clay)] md:p-8">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50 dark:bg-white/5" />
        <div aria-hidden className="pointer-events-none absolute -bottom-12 left-1/3 h-28 w-28 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-100/60 dark:bg-blue-500/5" />
        <div className="relative space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Link
              href="/lecturer/classes"
              className="inline-flex items-center gap-2 rounded-2xl border-[3px] border-border bg-card px-4 py-2 text-xs font-extrabold text-foreground shadow-[var(--shadow-clay-sm)] transition-[transform,box-shadow] duration-180 hover:-translate-y-0.5 active:translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40 md:text-sm"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              <span>{t("backToClasses")}</span>
            </Link>

            <span className="inline-flex items-center gap-1.5 rounded-full border-[3px] border-border bg-card px-3.5 py-1 text-xs font-extrabold text-muted-foreground">
              <Archive className="h-3.5 w-3.5 text-primary" aria-hidden />
              {t("heroBadge")}
            </span>
          </div>

          <div>
            <h1 className="font-heading text-3xl font-semibold [text-wrap:balance] md:text-4xl">
              {t("heroTitle")}
            </h1>
            <p className="mt-2 max-w-2xl text-sm font-semibold text-muted-foreground md:text-base">
              {t("heroSubtitle")}
            </p>
          </div>
        </div>
      </section>

      {/* ── Search & Filter toolbar ── */}
      {classes.length > 0 && (
        <section className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative max-w-md flex-1">
            <label htmlFor="archive-search" className="sr-only">
              {t("searchPlaceholder")}
            </label>
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="archive-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="h-12 rounded-2xl border-[3px] border-border bg-card pl-11 pr-10 text-sm font-bold shadow-[var(--shadow-clay-sm)] focus-visible:ring-4 focus-visible:ring-primary/20"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label={t("clearSearchAria")}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>

          <div role="status" aria-live="polite" className="text-xs font-extrabold text-muted-foreground">
            {searchQuery
              ? t("searchResultsCount", { count: filteredClasses.length, query: searchQuery })
              : t("totalArchivedCount", { count: classes.length })}
          </div>
        </section>
      )}

      {/* ── Error Banner ── */}
      <div aria-live="polite">
        {restoreError && (
          <div
            role="alert"
            className="flex items-center justify-between rounded-2xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden />
              <span>{restoreError}</span>
            </div>
            <button
              type="button"
              onClick={() => setRestoreError(null)}
              aria-label={tCommon("close")}
              className="rounded-lg p-1 hover:bg-destructive/20"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* ── Main Content Area ── */}
      {classes.length === 0 ? (
        <EmptyState
          illustration={EmptyBoxIllustration}
          title={t("emptyArchivedTitle")}
          subtitle={t("emptyArchivedSubtitle")}
          className="rounded-[28px] border-[3px] bg-card/60 px-8 py-16"
          action={
            <div className="mt-6">
              <Link href="/lecturer/classes" className={buttonVariants({ variant: "default" })}>
                {t("backToActiveBtn")}
              </Link>
            </div>
          }
        />
      ) : filteredClasses.length === 0 ? (
        <EmptyState
          illustration={MagnifyingGlassIllustration}
          title={t("emptySearchTitle")}
          subtitle={t("emptySearchSubtitle", { query: searchQuery })}
          className="rounded-[28px] border-[3px] bg-card/60 px-8 py-16"
          action={
            <div className="mt-6">
              <Button type="button" variant="outline" onClick={() => setSearchQuery("")}>
                {t("clearSearchBtn")}
              </Button>
            </div>
          }
        />
      ) : (
        /* Grid of Archived Class Cards */
        <ul className="grid grid-cols-1 gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))] sm:gap-6">
          {filteredClasses.map((c) => (
            <li
              key={c.id}
              className="flex flex-col justify-between rounded-[22px] border-[3px] border-border bg-card p-5 shadow-[var(--shadow-clay-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[8px_10px_0_rgba(194,65,12,0.16)]"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-muted font-heading text-lg font-bold text-muted-foreground">
                    {c.title.trim().charAt(0).toUpperCase()}
                  </span>
                  <span className="rounded-full border-[3px] border-border/80 bg-muted/80 px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">
                    {t("archivedBadge")}
                  </span>
                </div>

                <h3 className="mt-3.5 break-words line-clamp-2 font-heading text-lg font-semibold leading-snug">
                  {c.title}
                </h3>

                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-extrabold text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <ClipboardList className="h-3.5 w-3.5" aria-hidden />
                    {t("quizCount", { count: c.quizCount })}
                  </span>
                  {c.archived_at && (
                    <>
                      <span>·</span>
                      <span>{t("archivedOn", { date: formatArchivedDate(c.archived_at) })}</span>
                    </>
                  )}
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between gap-2 border-t-[3px] border-border pt-4">
                <Link
                  href={`/lecturer/classes/${c.id}`}
                  className="inline-flex items-center gap-1 text-xs font-extrabold text-primary hover:underline"
                  aria-label={t("viewAuditAria", { title: c.title })}
                >
                  {t("viewAuditBtn")} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>

                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={restoringId !== null}
                  onClick={() => {
                    setRestoreError(null);
                    setConfirmClass(c);
                  }}
                  aria-label={t("restoreClassAria", { title: c.title })}
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t("restoreBtn")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* ── Restore Confirmation Dialog ── */}
      <Dialog
        open={confirmClass !== null}
        onOpenChange={(open) => {
          if (!open && !restoringId) setConfirmClass(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="mb-2 grid h-12 w-12 place-items-center rounded-2xl border-[3px] border-primary/20 bg-orange-100 text-primary">
              <RotateCcw className="h-6 w-6" aria-hidden />
            </div>
            <DialogTitle>{t("restoreModalTitle")}</DialogTitle>
            <DialogDescription>
              {confirmClass && t("restoreModalDescription", { title: confirmClass.title })}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="mt-4 gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmClass(null)}
              disabled={restoringId !== null}
            >
              {tCommon("cancel")}
            </Button>
            <Button
              type="button"
              variant="default"
              disabled={restoringId !== null}
              onClick={() => {
                if (confirmClass) handleConfirmRestore(confirmClass.id);
              }}
            >
              {restoringId !== null ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  {t("restoringBtn")}
                </>
              ) : (
                <>
                  <RotateCcw className="mr-2 h-4 w-4" aria-hidden />
                  {t("restoreConfirmBtn")}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
