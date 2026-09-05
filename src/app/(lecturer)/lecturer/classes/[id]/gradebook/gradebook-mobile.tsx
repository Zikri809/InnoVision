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
  if (percent >= 50) return "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300";
  return "border-destructive/40 bg-destructive/10 text-destructive";
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
  const [open, setOpen] = useState<OpenState>(null);

  const openStudent = useMemo(
    () => (open?.kind === "student" ? visibleRows.find((r) => r.studentId === open.studentId) ?? null : null),
    [open, visibleRows],
  );
  const openQuiz = useMemo(
    () => (open?.kind === "quiz" ? model.quizzes.find((q) => q.id === open.quizId) ?? null : null),
    [open, model.quizzes],
  );

  if (visibleRows.length === 0 || model.quizzes.length === 0) {
    return null; // empty states render in the shared flow above
  }

  return (
    <div className="space-y-4">
      {/* Quiz strip: per-quiz average chips → per-quiz sheet */}
      <div className="flex gap-2 overflow-x-auto pb-1 [scroll-snap-type:x_mandatory]">
        {model.quizzes.map((quiz) => (
          <button
            key={quiz.id}
            type="button"
            onClick={() => setOpen({ kind: "quiz", quizId: quiz.id })}
            className="shrink-0 cursor-pointer [scroll-snap-align:start] rounded-2xl border-[3px] border-border bg-card px-3.5 py-2.5 text-left shadow-[0_4px_0_var(--border)] transition-transform duration-150 active:translate-y-[2px] focus-visible:outline-[3px] focus-visible:outline-ring focus-visible:outline-offset-2"
          >
            <span className="flex max-w-[150px] items-center gap-1.5 text-label font-bold text-muted-foreground">
              {quiz.title}
              {!quiz.revealed && (
                <span className="inline-block size-1.5 rounded-full bg-amber-500" />
              )}
            </span>
            <span className="mt-0.5 block font-heading text-lg font-bold tabular-nums text-foreground">
              {quiz.averagePercent === null ? "—" : `${quiz.averagePercent}%`}
            </span>
          </button>
        ))}
      </div>

      {/* Student list */}
      <ul className="overflow-hidden rounded-[22px] border-[3px] border-border bg-card shadow-[var(--shadow-clay)]">
        {visibleRows.map((row, i) => (
          <li key={row.studentId}>
            <button
              type="button"
              onClick={() => setOpen({ kind: "student", studentId: row.studentId })}
              className={cn(
                "flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/60 active:bg-muted focus-visible:outline-[3px] focus-visible:outline-ring focus-visible:outline-offset-2",
                i > 0 && "border-t-[3px] border-border/50",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-extrabold text-foreground">
                  {row.fullName ?? row.matricNo ?? row.studentId}
                </span>
                {row.fullName && row.matricNo && (
                  <span className="block text-2xs font-bold text-muted-foreground">{row.matricNo}</span>
                )}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-full border-[3px] px-2.5 py-0.5 font-heading text-sm font-bold tabular-nums",
                  scoreTone(row.cumulativePercent),
                )}
              >
                {row.cumulativePercent === null ? "—" : `${row.cumulativePercent}%`}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {/* Per-student sheet */}
      <ResponsiveModal open={openStudent !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <ResponsiveModalContent>
          <ResponsiveModalHeader>
            <ResponsiveModalTitle className="break-words font-heading text-lg">
              {openStudent?.fullName ?? openStudent?.matricNo}
            </ResponsiveModalTitle>
            <ResponsiveModalDescription>
              {t("colCumulative")}:{" "}
              <span className="font-bold tabular-nums">
                {openStudent?.cumulativePercent === null || openStudent == null ? "—" : `${openStudent.cumulativePercent}%`}
              </span>
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <ul className="mt-3 flex gap-2 overflow-x-auto pb-2 [scroll-snap-type:x_mandatory]">
            {openStudent?.cells.map((cell, i) => {
              const quiz = model.quizzes[i];
              return (
                <li
                  key={quiz.id}
                  className={cn(
                    "w-28 shrink-0 [scroll-snap-align:start] rounded-2xl border-[3px] p-3 text-center",
                    scoreTone(cell?.percent ?? null),
                  )}
                >
                  <span className="block truncate text-2xs font-bold" title={quiz.title}>
                    {quiz.title}
                  </span>
                  <span className="mt-1 block font-heading text-xl font-bold tabular-nums">
                    {cell?.percent === null || cell == null ? "—" : `${cell.percent}%`}
                  </span>
                  <span className="mt-0.5 block text-2xs font-bold tabular-nums">
                    {cell?.score === null || cell == null ? "" : `${cell.score}/${cell.total}`}
                    {cell?.attempt != null && cell.attempt > 1 ? ` ·#${cell.attempt}` : ""}
                  </span>
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
                  const percent = row.cells[idx]?.percent ?? null;
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
              return (
                <li key={row.studentId} className="flex items-center justify-between gap-3 rounded-xl px-2 py-1.5">
                  <span className="min-w-0 truncate text-sm font-bold text-foreground">
                    {row.fullName ?? row.matricNo ?? row.studentId}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full border-[3px] px-2.5 py-0.5 text-xs font-extrabold tabular-nums",
                      scoreTone(cell?.percent ?? null),
                    )}
                  >
                    {cell?.percent === null || cell == null ? "—" : `${cell.percent}%`}
                  </span>
                </li>
              );
            })}
          </ul>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}
