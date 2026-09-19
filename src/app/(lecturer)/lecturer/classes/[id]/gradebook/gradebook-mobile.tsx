"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { ResponsiveModal, ResponsiveModalContent, ResponsiveModalHeader, ResponsiveModalTitle, ResponsiveModalDescription } from "@/components/ui/responsive-modal";
import type { GradebookModel, GradebookRow } from "@/lib/results/gradebook";

/**
 * Gradebook mobile composition (plan W5, <sm): the N×M table becomes a
 * student list + bottom sheets — two-axis scroll is unusable at 375px.
 * Desktop table untouched; this component renders only below 640px via the
 * gate in GradebookClient (below the data/filters owner).
 *
 * One open-sheet state ({student|quiz}) means cross-navigation closes and
 * replaces — sheets never stack.
 */

type OpenState =
  | { kind: "student"; studentId: string }
  | { kind: "quiz"; quizId: string }
  | null;

function scoreTone(percent: number | null): string {
  if (percent === null) return "border-border bg-muted text-muted-foreground";
  if (percent >= 75) return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300";
  if (percent >= 50) return "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200";
  return "border-destructive/40 bg-destructive/10 text-destructive";
}

/**
 * Option A (de-slop pass): the list is neutral by default — meter fill only
 * takes a semantic color below the pass band (amber 50-64, red <50). Green
 * as a celebration color on every passing row turned the screen into
 * semantic color soup; scanning works by fill LENGTH, not hue.
 */
function meterFill(percent: number | null): string {
  if (percent === null) return "bg-transparent";
  if (percent < 50) return "bg-destructive";
  if (percent < 65) return "bg-amber-400";
  return "bg-primary";
}

export function GradebookMobile({
  model,
  visibleRows,
}: {
  model: GradebookModel;
  /** Already filtered/sorted by GradebookClient (single source of truth). */
  visibleRows: GradebookRow[];
}) {
  const t = useTranslations("lecturer.gradebook");
  // Same cross-surface pending label as the desktop table (X2-9).
  const tPlay = useTranslations("play");
  const [open, setOpen] = useState<OpenState>(null);

  const openStudent = useMemo(
    () => (open?.kind === "student" ? visibleRows.find((r) => r.studentId === open.studentId) ?? null : null),
    [open, visibleRows],
  );
  const openQuiz = useMemo(
    () => (open?.kind === "quiz" ? model.quizzes.find((q) => q.id === open.quizId) ?? null : null),
    [open, model.quizzes],
  );

  // Overall class average = mean of attempted students' cumulative %.
  // (Desktop footer only shows per-quiz averages; this is the mobile summary.)
  const classAverage = useMemo(() => {
    const attempted = model.rows
      .map((r) => r.cumulativePercent)
      .filter((p): p is number => p !== null);
    if (attempted.length === 0) return null;
    return Math.round(attempted.reduce((sum, p) => sum + p, 0) / attempted.length);
  }, [model.rows]);

  if (visibleRows.length === 0 || model.quizzes.length === 0) {
    return null; // empty states render in the shared flow above
  }

  return (
    <div className="space-y-4">
      {/* Class summary: one clay meter + caption. Counts are a caption, not
          three stat ovals; the avg is the only headline number worth showing. */}
      <section
        aria-label={t("classAvgLabel")}
        className="rounded-[22px] border-[3px] border-border bg-card px-5 py-4 shadow-[var(--shadow-clay)]"
      >
        <div className="flex items-center gap-4">
          <p className="font-heading text-3xl font-bold tabular-nums leading-none text-foreground">
            {classAverage === null ? (
              <span className="text-base font-bold text-muted-foreground">{t("noAttemptsYet")}</span>
            ) : (
              <>
                {classAverage}
                <span className="text-lg text-muted-foreground">%</span>
              </>
            )}
          </p>
          <div className="min-w-0">
            <h2 className="text-xs font-extrabold uppercase tracking-wider text-muted-foreground">
              {t("classAvgLabel")}
            </h2>
            <p className="mt-0.5 text-2xs font-bold text-muted-foreground">
              {t("rosterCount", { count: model.rows.length })} · {t("quizCount", { count: model.quizzes.length })}
            </p>
          </div>
        </div>
        <div
          className="mt-3 h-4 overflow-hidden rounded-full border-[3px] border-border bg-muted shadow-[inset_0_2px_0_rgba(0,0,0,0.05)]"
          aria-hidden="true"
        >
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", meterFill(classAverage))}
            style={{ width: `${classAverage ?? 0}%` }}
          />
        </div>
      </section>

      {/* Quiz strip: per-quiz average chips → per-quiz sheet */}
      <div className="flex gap-2 overflow-x-auto pb-1 [scroll-snap-type:x_mandatory]">
        {model.quizzes.map((quiz) => (
          <button
            key={quiz.id}
            type="button"
            onClick={() => setOpen({ kind: "quiz", quizId: quiz.id })}
            className="flex min-w-[136px] cursor-pointer flex-1 basis-0 flex-col [scroll-snap-align:start] rounded-2xl border-[3px] border-border bg-card px-3.5 py-2.5 text-left shadow-[0_4px_0_var(--border)] transition-transform duration-150 active:translate-y-[2px] focus-visible:outline-[3px] focus-visible:outline-ring focus-visible:outline-offset-2"
            title={quiz.title}
          >
            <span className="flex items-start gap-1.5 text-label font-bold text-muted-foreground">
              <span className="line-clamp-2">{quiz.title}</span>
              {!quiz.revealed && (
                <span className="mt-1 inline-block size-1.5 shrink-0 rounded-full bg-amber-500" />
              )}
            </span>
            {/* mt-auto pins every percentage to the chip's bottom edge, so
                titles of different wrap counts can't misalign the numbers. */}
            <span className="mt-auto pt-0.5 font-heading text-lg font-bold tabular-nums text-foreground">
              {quiz.averagePercent === null ? "—" : `${quiz.averagePercent}%`}
            </span>
          </button>
        ))}
      </div>

      {/* Student list: meter per row — scan by fill length, not hue. Plain
          tabular numeral; no capsule around a bare number. */}
      <ul className="overflow-hidden rounded-[22px] border-[3px] border-border bg-card shadow-[var(--shadow-clay)]">
        {visibleRows.map((row, i) => (
          <li key={row.studentId}>
            <button
              type="button"
              onClick={() => setOpen({ kind: "student", studentId: row.studentId })}
              className={cn(
                "flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60 active:bg-muted focus-visible:outline-[3px] focus-visible:outline-ring focus-visible:outline-offset-2",
                i > 0 && "border-t-[3px] border-border/50",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-extrabold text-foreground">
                  {row.fullName ?? row.matricNo ?? row.studentId}
                </span>
                {row.fullName && row.matricNo && (
                  <span className="block text-2xs font-bold text-muted-foreground">{row.matricNo}</span>
                )}
                <span
                  className="mt-1.5 block h-2.5 overflow-hidden rounded-full border-2 border-border bg-muted"
                  aria-hidden="true"
                >
                  <span
                    className={cn("block h-full rounded-full", meterFill(row.cumulativePercent))}
                    style={{ width: `${row.cumulativePercent ?? 0}%` }}
                  />
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span
                  className={cn(
                    "block font-heading text-base font-bold tabular-nums",
                    row.cumulativePercent === null && "text-muted-foreground",
                    row.cumulativePercent !== null &&
                      row.cumulativePercent < 50 &&
                      "text-destructive",
                    row.cumulativePercent !== null &&
                      row.cumulativePercent >= 50 &&
                      row.cumulativePercent < 65 &&
                      "text-amber-600 dark:text-amber-400",
                  )}
                >
                  {row.cumulativePercent !== null
                    ? `${row.cumulativePercent}%`
                    : row.hasPending
                      ? // audit-4 M7: attempted-but-awaiting-marks must not
                        // read as "—" (the desktop "not attempted" analogue).
                        tPlay("shortText.pending")
                      : "—"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {/* Per-student sheet — same language as the list: overall meter in the
          header, neutral meter cards per quiz (color only below pass band). */}
      <ResponsiveModal open={openStudent !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <ResponsiveModalContent>
          <ResponsiveModalHeader>
            <ResponsiveModalTitle className="break-words font-heading text-lg">
              {openStudent?.fullName ?? openStudent?.matricNo}
            </ResponsiveModalTitle>
            <ResponsiveModalDescription className="mt-1 flex items-center gap-2.5">
              <span
                className="block h-2.5 w-24 shrink-0 overflow-hidden rounded-full border-2 border-border bg-muted"
                aria-hidden="true"
              >
                <span
                  className={cn("block h-full rounded-full", meterFill(openStudent?.cumulativePercent ?? null))}
                  style={{
                    width: `${openStudent?.cumulativePercent ?? 0}%`,
                  }}
                />
              </span>
              <span
                className={cn(
                  "font-bold tabular-nums",
                  openStudent?.cumulativePercent == null && "text-muted-foreground",
                )}
              >
                {t("colCumulative")}:{" "}
                {openStudent?.cumulativePercent != null
                  ? `${openStudent.cumulativePercent}%`
                  : openStudent?.hasPending
                    ? tPlay("shortText.pending")
                    : "—"}
              </span>
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <ul className="mt-3 divide-y divide-border/60">
            {openStudent?.cells.map((cell, i) => {
              const quiz = model.quizzes[i];
              const percent = cell?.percent ?? null;
              const pending = (cell?.pendingCount ?? 0) > 0;
              return (
                <li key={quiz.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span className="min-w-0 truncate text-sm font-bold text-foreground" title={quiz.title}>
                    {quiz.title}
                  </span>
                  {pending ? (
                    // Neutral pending state: the score is provisional while an
                    // AI mark is outstanding, so no percentage is shown.
                    <span className="shrink-0 rounded-md border-[2px] border-border bg-muted px-2 py-0.5 text-xs font-bold text-muted-foreground">
                      {tPlay("shortText.pending")}
                    </span>
                  ) : (
                  <span
                    className={cn(
                      "shrink-0 text-sm font-extrabold tabular-nums",
                      percent === null && "text-muted-foreground",
                      percent !== null && percent < 50 && "text-destructive",
                      percent !== null && percent >= 50 && percent < 65 && "text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {percent === null ? "—" : `${percent}%`}
                    {cell?.score != null && (
                      <span className="ml-1.5 text-2xs font-bold text-muted-foreground">
                        {cell.score}/{cell.resolved}
                        {cell.attempt != null && cell.attempt > 1 ? ` ·#${cell.attempt}` : ""}
                      </span>
                    )}
                  </span>
                  )}
                </li>
              );
            })}
          </ul>
        </ResponsiveModalContent>
      </ResponsiveModal>

      {/* Per-quiz sheet (closes-and-replaces the student sheet — one open state) */}
      <ResponsiveModal open={openQuiz !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <ResponsiveModalContent>
          <ResponsiveModalHeader>
            <ResponsiveModalTitle className="break-words font-heading text-lg">
              {openQuiz?.title}
            </ResponsiveModalTitle>
            <ResponsiveModalDescription>
              {t("footerAverage")}:{" "}
              <span className="font-bold tabular-nums">
                {openQuiz?.averagePercent == null ? "—" : `${openQuiz.averagePercent}%`}
              </span>
              {!openQuiz?.revealed && ` · ${t("unrevealedShort")}`}
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>
          {/* 5-bucket clay distribution bar (plan W5): score bands over the
              attempted cells, segmented 3px-bordered bar — the same model
              data the desktop table consumes. */}
          <div className="mt-3" aria-hidden="true">
            <div className="flex h-3 w-full overflow-hidden rounded-full border-[3px] border-border bg-muted">
              {(() => {
                const idx = model.quizzes.findIndex((q) => q.id === openQuiz?.id);
                const buckets = [0, 0, 0, 0, 0]; // 0-49, 50-64, 65-79, 80-89, 90-100
                let attempted = 0;
                for (const row of visibleRows) {
                  const cell = row.cells[idx] ?? null;
                  // audit-4 M10: a pending cell's percent is null in the model
                  // now, but keep the explicit guard so a partially-marked
                  // attempt can never enter the distribution as a real score.
                  if (cell === null || cell.pendingCount > 0) continue;
                  const percent = cell.percent;
                  if (percent === null) continue;
                  attempted++;
                  if (percent < 50) buckets[0]++;
                  else if (percent < 65) buckets[1]++;
                  else if (percent < 80) buckets[2]++;
                  else if (percent < 90) buckets[3]++;
                  else buckets[4]++;
                }
                const tones = [
                  "bg-destructive/70",
                  "bg-amber-400/80",
                  "bg-primary/60",
                  "bg-emerald-400/70",
                  "bg-emerald-600/80",
                ];
                return buckets.map((count, i) =>
                  count > 0 ? (
                    <span
                      key={i}
                      className={tones[i]}
                      style={{ width: `${(count / attempted) * 100}%` }}
                    />
                  ) : null,
                );
              })()}
            </div>
            <p className="mt-1 text-2xs font-bold text-muted-foreground">
              &lt;50 · 50-64 · 65-79 · 80-89 · 90-100%
            </p>
          </div>
          <ul className="mt-3 max-h-[50dvh] space-y-1.5 overflow-y-auto">
            {visibleRows.map((row) => {
              const idx = model.quizzes.findIndex((q) => q.id === openQuiz?.id);
              const cell = row.cells[idx] ?? null;
              // audit-4 M10: the per-quiz sheet must mirror the desktop cell —
              // a pending cell is a neutral chip, never a provisional percent.
              const pending = (cell?.pendingCount ?? 0) > 0;
              return (
                <li key={row.studentId} className="flex items-center justify-between gap-3 rounded-xl px-2 py-1.5">
                  <span className="min-w-0 truncate text-sm font-bold text-foreground">
                    {row.fullName ?? row.matricNo ?? row.studentId}
                  </span>
                  {pending ? (
                    <span className="shrink-0 rounded-full border-[2px] border-border bg-muted px-2.5 py-0.5 text-xs font-bold text-muted-foreground">
                      {tPlay("shortText.pending")}
                    </span>
                  ) : (
                    <span
                      className={cn(
                        "shrink-0 rounded-full border-[3px] px-2.5 py-0.5 text-xs font-extrabold tabular-nums",
                        scoreTone(cell?.percent ?? null),
                      )}
                    >
                      {cell?.percent === null || cell == null ? "—" : `${cell.percent}%`}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}
