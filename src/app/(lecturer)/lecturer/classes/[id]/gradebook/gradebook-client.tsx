"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, Download, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GradebookModel } from "@/lib/results/gradebook";

/**
 * RA-1 gradebook matrix (client island — export button is the only
 * interactive piece; the matrix itself is serializable-model rendering).
 *
 * A11y: real <table> with th scope, sticky first column, em-dash cells carry
 * sr-only "not attempted" text. Quiz headers include an unrevealed marker
 * (EyeOff icon + sr-only label) when results_revealed_at is null.
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

  const hasQuizzes = model.quizzes.length > 0;
  const hasStudents = model.rows.length > 0;

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
                      /{quiz.questionCount}
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
              {model.rows.map((row) => (
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
              ))}
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
