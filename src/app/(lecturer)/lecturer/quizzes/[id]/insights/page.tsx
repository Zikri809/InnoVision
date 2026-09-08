import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { loadQuizInsights } from "@/lib/results/load-insights";
import { QuestionInsightsList } from "@/components/results/question-insights-list";

export const dynamic = "force-dynamic";

/**
 * RA-2 — Question insights as a first-class page (mobile-first).
 *
 * Previously an accordion inside the results dashboard, then a full-height
 * sheet; a real route wins on mobile because the OS back gesture returns to
 * the dashboard, and the URL is shareable/bookmarkable during class review.
 *
 * All reads (auth, class-ownership re-check, capped questions/answers reads,
 * representative-session feed) live in the shared `loadQuizInsights` helper —
 * the exact same pipeline the export route's numbers come from, so this page
 * can never disagree with the workbook.
 */
export default async function LecturerQuizInsightsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("lecturer.results");
  const tCommon = await getTranslations("common");

  const result = await loadQuizInsights(id);
  if (!result.ok) {
    return result.panel;
  }
  const { insights, insightsTruncated } = result;

  if (insights.questions.length === 0) notFound();

  return (
    <div className="space-y-4">
      <header className="relative">
        <Link
          href={`/lecturer/quizzes/${id}/results`}
          className="inline-flex min-w-0 items-center gap-1 text-sm font-extrabold text-muted-foreground transition-colors hover:text-primary"
        >
          <ArrowLeft className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{tCommon("back")}</span>
        </Link>
        <h1 className="mt-3 flex items-center gap-2 font-heading text-[26px] leading-tight font-semibold sm:text-3xl">
          <BarChart3 className="size-6 shrink-0 text-muted-foreground" aria-hidden />
          {t("insightsTitle")}
        </h1>
        <p className="mt-1.5 text-sm font-semibold text-muted-foreground">
          {insights.hasDegenerate ? t("insightsDegenerateSubtitle") : t("insightsSubtitle")}
        </p>
      </header>

      <QuestionInsightsList model={insights} truncated={insightsTruncated} />
    </div>
  );
}
