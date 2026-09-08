import { useTranslations } from "next-intl";
import type { QuestionInsightsModel } from "@/lib/results/insights";

/**
 * RA-2 — the per-question item-analysis cards (prompt, degenerate hints,
 * per-option pick distribution bars). Shared by the results dashboard's
 * insights card target page (/lecturer/quizzes/[id]/insights).
 *
 * Server component: pure rendering over the serializable QuestionInsightsModel
 * (same numbers as the Excel export by construction — see lib/results/insights.ts).
 */
export function QuestionInsightsList({
  model,
  truncated = false,
}: {
  model: QuestionInsightsModel;
  /** The answers read hit its 20k cap — percentages may under-report. */
  truncated?: boolean;
}) {
  const t = useTranslations("lecturer.results");

  return (
    <>
      {truncated && (
        <p role="status" className="mb-3 rounded-xl border-[3px] border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm font-bold text-amber-800 dark:text-amber-300">
          {t("insightsTruncated")}
        </p>
      )}
      <ul className="space-y-3">
        {model.questions.map((qi) => {
          const degenerate = qi.lowCorrect || qi.hasNeverPickedDistractor;
          return (
            <li
              key={qi.index}
              className={`rounded-[22px] border-2 bg-card p-4 shadow-[var(--shadow-clay-sm)] ${
                degenerate ? "border-amber-400/60 dark:border-amber-500/40" : "border-border"
              }`}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-2.5">
                <p className="min-w-0 font-heading text-sm font-bold text-foreground">
                  <span className="text-muted-foreground">Q{qi.index}.</span> {qi.prompt}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {qi.lowCorrect && (
                    <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-2xs font-extrabold uppercase tracking-wide text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                      {t("insightsLowCorrect", { percent: qi.percentCorrect })}
                    </span>
                  )}
                  {qi.hasNeverPickedDistractor && (
                    <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-2xs font-extrabold uppercase tracking-wide text-sky-800 dark:bg-sky-500/15 dark:text-sky-300">
                      {t("insightsNeverPicked")}
                    </span>
                  )}
                  <span className="rounded-full bg-muted px-2.5 py-0.5 text-2xs font-extrabold tabular-nums text-muted-foreground">
                    {t("insightsCorrectStat", { percent: qi.percentCorrect, answered: qi.timesAnswered })}
                  </span>
                </div>
              </div>
              {/* Per-option pick distribution — inline bars, no chart lib. */}
              <ul className="mt-3 space-y-1.5">
                {qi.distribution.map((d) => {
                  const onKey =
                    qi.correctIndices?.includes(d.optionIndex) ??
                    qi.correctIndex === d.optionIndex;
                  return (
                    <li key={d.optionIndex} className="flex items-center gap-2.5 text-xs font-semibold">
                      <span
                        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-2xs font-extrabold ${
                          onKey
                            ? "bg-emerald-600 text-white"
                            : "border border-border bg-muted text-muted-foreground"
                        }`}
                      >
                        {String.fromCharCode(65 + d.optionIndex)}
                      </span>
                      <span className="min-w-[70px] max-w-[200px] truncate text-muted-foreground" title={qi.options[d.optionIndex]}>
                        {qi.options[d.optionIndex]}
                      </span>
                      <span className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className={`block h-full rounded-full ${onKey ? "bg-emerald-500" : "bg-sky-400"}`}
                          style={{ width: `${Math.min(100, d.chosenPercent)}%` }}
                        />
                      </span>
                      <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                        {t("insightsPickStat", { percent: d.chosenPercent, count: d.chosenCount })}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
    </>
  );
}
