"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ExternalLink, FileText, Globe, Paperclip } from "lucide-react";
import type { QuizSourceRow } from "@/lib/quizzes/sources";

/**
 * Merged source-provenance card in the lecturer builder (grounded-search.md
 * §7): "Sources used" chips and the extracted-course-text preview — formerly
 * two separate stacked cards — in one clay card.
 *
 * Chips render UNCONDITIONALLY (never behind the disclosure): the e2e
 * assertions run against the settled builder page without opening anything.
 * Only the raw extracted text sits behind the chevron.
 *
 * Accessible-name CONTRACT (pinned by e2e/e2f-web-generate.spec.ts, per the
 * AGENTS.md rule): chips are real <a> elements → role="link", the accessible
 * name is the VISIBLE truncated text (no sr-only divergence), and
 * `data-testid="web-source-chip"` carries count assertions. The section
 * testid lives on the chip list — it must NOT exist when the quiz has no
 * sources (e2e asserts its absence for material-only builds). Changing copy
 * or markup here requires grepping e2e/ first.
 */

/** R2 storage prepends a blob UUID to uploads; display the human part only. */
const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

function displayName(filename: string): string {
  return filename.replace(UUID_PREFIX, "");
}

export function QuizSourcesCard({
  sources,
  text,
}: {
  sources: QuizSourceRow[];
  text: string | null;
}) {
  const t = useTranslations("builder");
  const tExtract = useTranslations("extract");
  const [open, setOpen] = useState(false);

  const hasChips = sources.length > 0;
  const hasText = !!text;
  if (!hasChips && !hasText) return null;

  const header = (
    <>
      <span className="flex min-w-0 items-center gap-2 font-heading text-sm font-semibold text-foreground">
        <Paperclip className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="truncate">{hasChips ? t("sourcesTitle") : tExtract("previewTitle")}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {hasChips && (
          <span className="rounded-full border-2 border-border bg-muted px-2.5 py-0.5 text-xs font-bold tabular-nums text-muted-foreground">
            {t("sourcesCount", { count: sources.length })}
          </span>
        )}
        {hasText && (
          <ChevronDown
            className={`size-4 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        )}
      </span>
    </>
  );

  return (
    <div className="rounded-2xl border-2 sm:border-[3px] border-border bg-card p-3 sm:p-4 shadow-[var(--shadow-clay-sm)]">
      {hasText ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full cursor-pointer items-center justify-between gap-3 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {header}
        </button>
      ) : (
        <div className="flex items-center justify-between gap-3">{header}</div>
      )}

      {hasChips && (
        <ul data-testid="web-source-chip-section" className="mt-2.5 flex flex-wrap gap-2">
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
                title={displayName(s.filename)}
                className="inline-flex max-w-full items-center gap-1.5 rounded-xl border-[2px] border-border/60 bg-muted/20 px-2.5 py-1.5 text-2xs font-bold text-muted-foreground"
              >
                <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{displayName(s.filename)}</span>
              </li>
            ),
          )}
        </ul>
      )}

      {hasText && open && (
        <div className="mt-3">
          {hasChips && (
            <p className="mb-1.5 text-2xs font-extrabold uppercase tracking-wide text-muted-foreground">
              {tExtract("previewTitle")}
            </p>
          )}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border-2 border-border/50 bg-muted/60 p-3 font-mono text-xs font-medium text-foreground">
            {text}
          </pre>
        </div>
      )}
    </div>
  );
}
