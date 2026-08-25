"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { useQuestionImage } from "@/lib/media/use-question-image";

/**
 * Renders a question's attached image above the option list (plan D9):
 *  - CONSTANT reserved height so options/CTA never shift when the image
 *    loads (and never push past the fold mid-assessment, incl. under the
 *    gesture overlay); `compact` halves it for list rows (results review);
 *  - terminal failure renders an aria-hidden sliver — NEVER blocks answering;
 *  - one silent retry on <img> error; a SECOND error is terminal.
 */
export function QuestionImage({
  questionId,
  prompt,
  compact = false,
}: {
  questionId: string;
  /** Prompt excerpt doubles as auto-derived alt text (truncated). */
  prompt: string;
  /** List-row variant (end-screen breakdown): smaller reservation + box. */
  compact?: boolean;
}) {
  const t = useTranslations("media");
  const { url, failed, retry } = useQuestionImage(questionId);
  const [retried, setRetried] = useState(false);
  const [dead, setDead] = useState(false);

  function handleImgError() {
    // First <img> error: one silent retry (expired signed URL). A SECOND
    // error after the retry is terminal — collapse instead of rendering the
    // browser's broken-image chrome.
    if (!retried) {
      setRetried(true);
      retry();
      return;
    }
    setDead(true);
  }

  const boxHeight = compact ? "h-20 sm:h-28" : "h-40 sm:h-56";
  const imgMax = compact ? "max-h-28" : "max-h-56";

  // Terminal failure (fetch-failed, or second <img> error): collapse to a
  // sliver — answering is never blocked.
  if (failed || dead) {
    return <div aria-hidden="true" className={compact ? "h-1" : "h-2"} />;
  }

  return (
    <div
      className={`${boxHeight} ${compact ? "" : "mb-4"} flex w-full items-center justify-center overflow-hidden rounded-2xl border-[3px] border-border bg-muted/40`}
    >
      {url ? (
        <img
          src={url}
          alt={t("imageAlt", { prompt: prompt.slice(0, 80) })}
          onError={handleImgError}
          className={`${imgMax} w-auto max-w-full object-contain`}
          decoding="async"
        />
      ) : (
        <div role="status" aria-label={t("imageLoading")} className="flex items-center justify-center">
          <span aria-hidden="true" className="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}
    </div>
  );
}
