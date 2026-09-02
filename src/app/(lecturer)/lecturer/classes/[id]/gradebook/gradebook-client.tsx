"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowUpDown,
  Download,
  EyeOff,
  ListFilter,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { GradebookModel } from "@/lib/results/gradebook";
import {
  filterGradebookRows,
  sortGradebookRows,
  type GradebookSortKey,
  type GradebookStatusFilter,
} from "./gradebook-views";

/**
 * RA-1 gradebook matrix (client island — export button plus the toolbar
 * search/filter/sort are the interactive pieces; the matrix itself is
 * serializable-model rendering).
 *
 * A11y: real <table> with th scope, sticky first column, em-dash cells carry
 * sr-only "not attempted" text. Quiz headers include an unrevealed marker
 * (EyeOff icon + sr-only label) when results_revealed_at is null. Toolbar
 * shaping is client-only via the pure helpers in gradebook-views.ts; the
 * default view renders every roster row in enrollment order (the e39 e2e
 * contract).
 */
export function GradebookClient({
  model,
  truncated,
  quizLimit,
  classId,
  archived,
}: {
  model: GradebookModel;
  truncated: boolean;
  quizLimit: number;
  classId: string;
  archived: boolean;
}) {
  const t = useTranslations("lecturer.gradebook");
  const [exporting, setExporting] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<GradebookStatusFilter>("all");
  const [sortKey, setSortKey] = useState<GradebookSortKey>("default");

  const hasQuizzes = model.quizzes.length > 0;
  const hasStudents = model.rows.length > 0;
  const filtersActive =
    searchQuery.trim() !== "" || statusFilter !== "all" || sortKey !== "default";

  const visibleRows = useMemo(
    () =>
      sortGradebookRows(
        filterGradebookRows(model.rows, searchQuery, statusFilter),
        sortKey,
      ),
    [model.rows, searchQuery, statusFilter, sortKey],
  );

  // SelectValue resolves labels from items registered in the popup, which
  // only mount once opened — map raw values to labels up front like the
  // class-detail quiz-mode select does.
  const statusLabels: Record<GradebookStatusFilter, string> = {
    all: t("filterAll"),
    attempted: t("filterAttempted"),
    unattempted: t("filterUnattempted"),
  };
  const sortLabels: Record<GradebookSortKey, string> = {
    default: t("sortDefault"),
    "name-asc": t("sortNameAsc"),
    "name-desc": t("sortNameDesc"),
    "matric-asc": t("sortMatricAsc"),
    "matric-desc": t("sortMatricDesc"),
    "overall-desc": t("sortOverallDesc"),
    "overall-asc": t("sortOverallAsc"),
  };

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await fetch(`/api/classes/${classId}/gradebook-export`, {
        method: "GET",
      });
      if (!res.ok) {
        toast.error(t("exportError"));
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
      const filename = match
        ? decodeURIComponent(match[1])
        : `${(model.className ?? "gradebook").replace(/[^\w\- ]+/g, "")}-gradebook.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t("exportError"));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Hero band ── */}
      <section className="relative overflow-hidden rounded-[28px] border-[3px] border-border bg-gradient-to-br from-emerald-100 via-emerald-50 to-blue-50 dark:from-emerald-950/40 dark:via-card dark:to-blue-950/40 p-7 shadow-[var(--shadow-clay)] md:p-8">
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-white/50" />
        <div className="relative">
          <div className="flex items-center justify-between gap-4">
            <Link
              href={archived ? "/lecturer/classes/archived" : `/lecturer/classes/${classId}`}
              className="inline-flex items-center gap-1.5 text-sm font-extrabold text-muted-foreground transition-colors hover:text-primary"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden /> {t("backToClass")}
            </Link>
            {hasQuizzes && hasStudents && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleExport}
                disabled={exporting}
                className="border-[3px] border-primary/40 bg-card/90 text-xs font-extrabold text-primary hover:bg-primary hover:text-primary-foreground hover:border-primary transition-all shadow-[var(--shadow-clay-sm)]"
              >
                {exporting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                )}
                {exporting ? t("exporting") : t("exportButton")}
              </Button>
            )}
          </div>
          <h1 className="mt-4 font-heading text-3xl font-semibold [text-wrap:balance]">
            {t("title")}
          </h1>
          <p className="mt-1.5 text-sm font-semibold text-muted-foreground">
            {model.className} · {t("rosterCount", { count: model.rows.length })} ·{" "}
            {t("quizCount", { count: model.quizzes.length })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t("subtitle")}</p>
        </div>
      </section>

      {truncated && (
        <p role="status" className="rounded-2xl border-[3px] border-amber-600/30 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900">
          {t("truncatedColumns", { limit: quizLimit })}
        </p>
      )}

      {hasQuizzes && hasStudents && (
        <section aria-label={t("toolbarLabel")} className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative w-full sm:min-w-0 sm:flex-1">
              <label htmlFor="gradebook-search" className="sr-only">
                {t("searchPlaceholder")}
              </label>
              <Search
                className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                id="gradebook-search"
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

            <div className="flex shrink-0 flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5">
                <ListFilter
                  className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block"
                  aria-hidden
                />
                <Select
                  value={statusFilter}
                  onValueChange={(v) => setStatusFilter(v as GradebookStatusFilter)}
                >
                  <SelectTrigger
                    id="gradebook-status-filter"
                    aria-label={t("filterStatusLabel")}
                    className="h-12 w-44 rounded-2xl border-[3px] border-border bg-card text-sm font-bold shadow-[var(--shadow-clay-sm)]"
                  >
                    <SelectValue>
                      {(v) => statusLabels[v as GradebookStatusFilter] ?? String(v)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("filterAll")}</SelectItem>
                    <SelectItem value="attempted">{t("filterAttempted")}</SelectItem>
                    <SelectItem value="unattempted">{t("filterUnattempted")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-1.5">
                <ArrowUpDown
                  className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block"
                  aria-hidden
                />
                <Select
                  value={sortKey}
                  onValueChange={(v) => setSortKey(v as GradebookSortKey)}
                >
                  <SelectTrigger
                    id="gradebook-sort"
                    aria-label={t("sortLabel")}
                    className="h-12 w-44 rounded-2xl border-[3px] border-border bg-card text-sm font-bold shadow-[var(--shadow-clay-sm)]"
                  >
                    <SelectValue>
                      {(v) => sortLabels[v as GradebookSortKey] ?? String(v)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">{t("sortDefault")}</SelectItem>
                    <SelectItem value="name-asc">{t("sortNameAsc")}</SelectItem>
                    <SelectItem value="name-desc">{t("sortNameDesc")}</SelectItem>
                    <SelectItem value="matric-asc">{t("sortMatricAsc")}</SelectItem>
                    <SelectItem value="matric-desc">{t("sortMatricDesc")}</SelectItem>
                    <SelectItem value="overall-desc">{t("sortOverallDesc")}</SelectItem>
                    <SelectItem value="overall-asc">{t("sortOverallAsc")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div
              role="status"
              aria-live="polite"
              className="text-xs font-extrabold text-muted-foreground"
            >
              {t("visibleCount", {
                visible: visibleRows.length,
                total: model.rows.length,
              })}
            </div>
            {filtersActive && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  setSearchQuery("");
                  setStatusFilter("all");
                  setSortKey("default");
                }}
                className="font-extrabold"
              >
                <X className="mr-1 h-3.5 w-3.5" aria-hidden />
                {t("clearFilters")}
              </Button>
            )}
          </div>
        </section>
      )}

      {!hasQuizzes ? (
        <section className="rounded-[28px] border-[3px] border-dashed border-border bg-card p-10 text-center">
          <h2 className="font-heading text-xl font-semibold">{t("emptyNoQuizzesTitle")}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {t("emptyNoQuizzesSubtitle")}
          </p>
        </section>
      ) : !hasStudents ? (
        <section className="rounded-[28px] border-[3px] border-dashed border-border bg-card p-10 text-center">
          <h2 className="font-heading text-xl font-semibold">{t("emptyNoStudentsTitle")}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {t("emptyNoStudentsSubtitle")}
          </p>
        </section>
      ) : (
        <section className="overflow-x-auto rounded-[28px] border-[3px] border-border bg-card shadow-[var(--shadow-clay)]">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b-[3px] border-border">
                <th scope="col" className="sticky left-0 z-10 min-w-[130px] sm:min-w-[180px] bg-card px-3 sm:px-4 py-3 text-left font-heading font-semibold border-r border-border/40 sm:border-r-0 shadow-[2px_0_4px_rgba(0,0,0,0.04)] sm:shadow-none">
                  {t("colStudent")}
                </th>
                <th scope="col" className="hidden sm:table-cell min-w-[90px] px-3 py-3 text-left font-heading font-semibold">
                  {t("colMatric")}
                </th>
                {model.quizzes.map((quiz) => (
                  <th
                    key={quiz.id}
                    scope="col"
                    className="min-w-[110px] sm:min-w-[120px] border-l-2 border-border/60 px-3 py-3 text-center align-top"
                  >
                    <Link
                      href={`/lecturer/quizzes/${quiz.id}/results`}
                      className="group block font-heading font-semibold hover:text-primary transition-colors"
                      title={quiz.title}
                    >
                      <span className="block max-w-[140px] sm:max-w-none truncate sm:whitespace-normal group-hover:underline underline-offset-2">
                        {quiz.title}
                      </span>
                    </Link>
                    <span className="mt-0.5 block text-[11px] font-bold text-muted-foreground">
                      {t("questionCount", { count: quiz.questionCount })}
                    </span>
                    {!quiz.revealed && (
                      <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-amber-900">
                        <EyeOff className="h-3 w-3" aria-hidden />
                        <span className="sr-only">{t("unrevealed")}</span>
                        <span aria-hidden>{t("unrevealedShort")}</span>
                      </span>
                    )}
                  </th>
                ))}
                <th scope="col" className="min-w-[80px] sm:min-w-[90px] border-l-[3px] border-border px-3 py-3 text-center font-heading font-semibold">
                  {t("colCumulative")}
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr className="border-b-2 border-border/40">
                  <td colSpan={model.quizzes.length + 3} className="px-4 py-10 text-center">
                    <p className="font-heading text-lg font-semibold">{t("noMatchTitle")}</p>
                    <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                      {t("noMatchSubtitle")}
                    </p>
                    <div className="mt-4">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSearchQuery("");
                          setStatusFilter("all");
                          setSortKey("default");
                        }}
                        className="font-extrabold"
                      >
                        {t("clearFilters")}
                      </Button>
                    </div>
                  </td>
                </tr>
              ) : (
                visibleRows.map((row) => (
                  <tr key={row.studentId} className="border-b-2 border-border/40 last:border-b-0">
                    <th scope="row" className="sticky left-0 z-10 bg-card px-3 sm:px-4 py-2.5 text-left font-bold border-r border-border/40 sm:border-r-0 shadow-[2px_0_4px_rgba(0,0,0,0.04)] sm:shadow-none">
                      <span className="block max-w-[120px] sm:max-w-none truncate sm:whitespace-normal">
                        {row.fullName ?? row.studentId}
                      </span>
                      {row.matricNo && (
                        <span className="block text-[11px] font-mono font-normal text-muted-foreground sm:hidden">
                          {row.matricNo}
                        </span>
                      )}
                    </th>
                    <td className="hidden sm:table-cell px-3 py-2.5 font-mono text-xs text-muted-foreground">
                      {row.matricNo ?? "—"}
                    </td>
                    {row.cells.map((cell, i) => (
                      <td key={model.quizzes[i].id} className="border-l-2 border-border/60 px-3 py-2.5 text-center tabular-nums">
                        {cell ? (
                          <span className="font-bold">
                            {cell.percent}
                            <span className="text-muted-foreground">%</span>
                            {cell.attempt !== null && cell.attempt > 1 && (
                              <span className="sr-only"> ({t("attemptSuffix", { n: cell.attempt })})</span>
                            )}
                          </span>
                        ) : (
                          <span>
                            {t("notAttempted")}
                            <span className="sr-only"> not attempted</span>
                          </span>
                        )}
                      </td>
                    ))}
                    <td className="border-l-[3px] border-border bg-muted/30 px-3 py-2.5 text-center tabular-nums">
                      <span className="font-heading font-bold">
                        {row.cumulativePercent !== null ? (
                          <>
                            {row.cumulativePercent}
                            <span className="text-muted-foreground">%</span>
                          </>
                        ) : (
                          t("notAttempted")
                        )}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr className="border-t-[3px] border-border bg-muted/40">
                <th scope="row" className="sticky left-0 z-10 bg-card px-3 sm:px-4 py-2.5 text-left font-heading font-semibold border-r border-border/40 sm:border-r-0 shadow-[2px_0_4px_rgba(0,0,0,0.04)] sm:shadow-none">
                  {t("footerAverage")}
                </th>
                <td className="hidden sm:table-cell" aria-hidden />
                {model.quizzes.map((quiz) => (
                  <td key={quiz.id} className="border-l-2 border-border/60 px-3 py-2.5 text-center tabular-nums font-bold">
                    {quiz.averagePercent !== null ? (
                      <>
                        {quiz.averagePercent}
                        <span className="text-muted-foreground">%</span>
                      </>
                    ) : (
                      t("notAttempted")
                    )}
                  </td>
                ))}
                <td aria-hidden className="border-l-[3px] border-border" />
              </tr>
            </tfoot>
          </table>
        </section>
      )}
    </div>
  );
}
