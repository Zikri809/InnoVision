"use client";

import { ExternalLink, FileText, Globe } from "lucide-react";
import { useTranslations } from "next-intl";
import type { QuizSourceRow } from "@/lib/quizzes/sources";

/**
 * Source-provenance chips in the lecturer builder (grounded-search.md §7).
 *
 * Renders BELOW the SourceTextPreview collapsible: one row per source —
 * web entries as external links (every chip is a URL we actually fetched),
 * legacy file entries as plain filename text. Hidden entirely when the quiz
 * has no sources (legacy quizzes and manual builds stay unchanged).
 *
 * Accessible-name CONTRACT (pinned by e2e/e2f-web-generate.spec.ts, per the
 * AGENTS.md rule): chips are real <a> elements → role="link", the accessible
 * name is the VISIBLE truncated text (no sr-only divergence), and
 * `data-testid="web-source-chip"` carries count assertions. Changing copy or
 * markup here requires grepping e2e/ first.
 */
export function SourceChips({ sources }: { sources: QuizSourceRow[] }) {
  const t = useTranslations("builder");
  if (sources.length === 0) return null;

  return (
    <div
      className="rounded-2xl border-[3px] border-border bg-card p-4 shadow-[var(--shadow-clay-sm)]"
      data-testid="web-source-chip-section"
    >
      <p className="font-heading text-sm font-semibold text-foreground">
        {t("sourcesTitle")}
      </p>
      <ul className="mt-2.5 flex flex-wrap gap-2">
        {sources.map((s, i) =>
          s.kind === "web" ? (
            <li key={s.id ?? `web-${i}`}>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                data-testid="web-source-chip"
                className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-xl border-[2px] border-border bg-muted/40 px-2.5 py-1.5 text-2xs font-bold text-foreground transition-colors hover:bg-muted focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring"
                title={s.url}
              >
                <Globe className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                <span className="truncate min-w-0">{s.title}</span>
                <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
              </a>
            </li>
          ) : (
            <li
              key={s.id ?? `file-${i}`}
              data-testid="file-source-chip"
              className="inline-flex max-w-full items-center gap-1.5 rounded-xl border-[2px] border-border/60 bg-muted/20 px-2.5 py-1.5 text-2xs font-bold text-muted-foreground"
            >
              <FileText className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{s.filename}</span>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
