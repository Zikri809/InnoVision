"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Archive, ArrowRight, LibraryBig, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  MODE_CLASS,
  STATUS_CLASS,
  getModeLabel,
  getStatusLabel,
} from "@/lib/quizzes/labels";
import type { QuizMode, QuizStatus } from "@/lib/types/aliases";
import { EmptyState } from "@/components/ui/empty-state";
import { EmptyBoxIllustration } from "@/components/illustrations/empty-box";
import { MagnifyingGlassIllustration } from "@/components/illustrations/magnifying-glass";

export type QuizzesHubRow = {
  id: string;
  title: string;
  mode: QuizMode;
  status: QuizStatus;
  createdAt: string;
  classId: string | null;
  classTitle: string | null;
  classArchived: boolean;
};

/**
 * /lecturer/quizzes — cross-class quiz library. Every quiz the lecturer owns,
 * newest first, with class tags and status/mode badges; taps through to the
 * builder (drafts) or results (live/closed). Client-side title/class search
 * keeps the server payload dumb; 500 rows sorted client-side is instant.
 */
export function QuizzesHubClient({ quizzes }: { quizzes: QuizzesHubRow[] }) {
  const t = useTranslations("nav");
  const locale = useLocale();

  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return quizzes;
    return quizzes.filter(
      (quiz) =>
        quiz.title.toLowerCase().includes(q) ||
        (quiz.classTitle ?? "").toLowerCase().includes(q),
    );
  }, [quizzes, query]);

  function formatDate(iso: string): string {
    try {
      return new Intl.DateTimeFormat(locale === "ms" ? "ms-MY" : "en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kuala_Lumpur",
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  return (
    <div className="space-y-6 max-sm:space-y-5">
      {/* ── Hero band (flat below sm, matching classes/archived) ──
          max-sm:overflow-visible/max-sm:rounded-none: the flat phone hero has
          no border, background, or blobs to clip, and a rounded overflow-hidden
          clip over the page background trips a Chromium rasterization bug that
          paints the paragraph's first glyph as a tiny fragment (mobile only). */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-orange-100 via-orange-50 to-blue-50 dark:from-orange-950/40 dark:via-card dark:to-blue-950/40 p-6 shadow-[var(--shadow-clay)] md:p-8 max-sm:border-0 max-sm:bg-none max-sm:p-0 max-sm:shadow-none max-sm:overflow-visible max-sm:rounded-none">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50 dark:bg-white/5 max-sm:hidden" />
        <div aria-hidden className="pointer-events-none absolute -bottom-12 left-1/3 h-28 w-28 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-100/60 dark:bg-blue-500/5 max-sm:hidden" />
        <div className="relative space-y-3">
          <span className="inline-flex items-center gap-1.5 rounded-full border-[3px] border-border bg-card px-3.5 py-1 text-xs font-extrabold text-primary max-sm:hidden">
            <LibraryBig className="h-3.5 w-3.5" aria-hidden />
            {t("lecturerQuizzesHeroBadge")}
          </span>
          <h1 className="font-heading text-3xl font-semibold [text-wrap:balance] md:text-4xl max-sm:text-2xl">
            {t("lecturerQuizzes")}
          </h1>
          <p className="max-w-2xl text-sm font-semibold text-muted-foreground md:text-base">
            {t("lecturerQuizzesSubtitle")}
          </p>
        </div>
      </section>

      {/* ── Search toolbar ── */}
      {quizzes.length > 0 && (
        <section className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative max-w-md flex-1">
            <label htmlFor="quiz-hub-search" className="sr-only">
              {t("lecturerQuizzesSearchPlaceholder")}
            </label>
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="quiz-hub-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("lecturerQuizzesSearchPlaceholder")}
              className="h-12 rounded-2xl border-[3px] border-border bg-card pl-11 pr-10 text-sm font-bold shadow-[var(--shadow-clay-sm)] focus-visible:ring-4 focus-visible:ring-primary/20"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label={t("lecturerQuizzesSearchAria")}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>

          <div role="status" aria-live="polite" className="text-xs font-extrabold text-muted-foreground">
            {query
              ? t("lecturerQuizzesSearchResults", { count: filtered.length, query })
              : t("lecturerQuizzesCount", { count: quizzes.length })}
          </div>
        </section>
      )}

      {/* ── List ── */}
      {quizzes.length === 0 ? (
        <EmptyState
          illustration={EmptyBoxIllustration}
          title={t("lecturerQuizzesEmptyTitle")}
          subtitle={t("lecturerQuizzesEmptySubtitle")}
          className="rounded-[28px] border-[3px] bg-card/60 px-8 py-16"
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          illustration={MagnifyingGlassIllustration}
          title={t("lecturerQuizzesEmptySearchTitle", { query })}
          subtitle={t("lecturerQuizzesEmptySearchSubtitle")}
          className="rounded-[28px] border-[3px] bg-card/60 px-8 py-16"
        />
      ) : (
        <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]">
          {filtered.map((quiz) => (
            <li key={quiz.id}>
              <Link
                href={
                  quiz.status === "draft"
                    ? `/lecturer/quizzes/${quiz.id}/builder?from=quizzes`
                    : `/lecturer/quizzes/${quiz.id}/results`
                }
                className="group flex h-full flex-col rounded-[22px] border-[3px] border-border bg-card p-5 shadow-[var(--shadow-clay)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[8px_10px_0_rgba(194,65,12,0.16)] active:translate-y-[3px] focus-visible:outline-[3px] focus-visible:outline-ring focus-visible:outline-offset-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <span
                    className={cn(
                      "rounded-full border-[3px] px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider",
                      STATUS_CLASS[quiz.status],
                    )}
                  >
                    {getStatusLabel(quiz.status, locale)}
                  </span>
                  <span
                    className={cn(
                      "rounded-full border-[3px] px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider",
                      MODE_CLASS[quiz.mode],
                    )}
                  >
                    {getModeLabel(quiz.mode, locale)}
                  </span>
                </div>

                <h2 className="mt-3 break-words line-clamp-2 font-heading text-lg font-semibold leading-snug [text-wrap:balance]">
                  {quiz.title}
                </h2>

                {quiz.classTitle && (
                  <p
                    className={
                      quiz.classArchived
                        ? "mt-1 flex items-center gap-1 truncate text-xs font-bold text-muted-foreground/70"
                        : "mt-1 truncate text-xs font-bold text-muted-foreground"
                    }
                  >
                    <span className="truncate">{quiz.classTitle}</span>
                    {quiz.classArchived && (
                      <>
                        <span aria-hidden="true">·</span>
                        <Archive className="h-3 w-3 shrink-0" aria-hidden />
                        <span className="sr-only">{t("lecturerQuizzesArchivedTag")}</span>
                      </>
                    )}
                  </p>
                )}

                <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-xs font-extrabold text-muted-foreground">
                  <span>{formatDate(quiz.createdAt)}</span>
                  <span className="inline-flex items-center gap-1 text-sm font-extrabold text-primary transition-transform duration-200 group-hover:translate-x-0.5">
                    {quiz.status === "draft"
                      ? t("lecturerQuizzesOpenBuilder")
                      : t("lecturerQuizzesOpenResults")}
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
