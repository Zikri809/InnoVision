"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

export function SourceTextPreview({ text }: { text: string | null }) {
  const [open, setOpen] = useState(false);
  const t = useTranslations("extract");
  if (!text) return null;

  return (
    <div className="rounded-2xl border-[3px] border-border bg-card p-4 shadow-[var(--shadow-clay-sm)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center justify-between font-heading text-sm font-semibold text-foreground"
        aria-expanded={open}
      >
        <span>{t("previewTitle")}</span>
        <span className="rounded-full border-2 border-border bg-muted px-2.5 py-0.5 text-xs font-bold text-muted-foreground">
          {open ? t("hideText") : t("showText")}
        </span>
      </button>
      {open && (
        <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border-2 border-border/50 bg-muted/60 p-3 font-mono text-xs font-medium text-foreground">
          {text}
        </pre>
      )}
    </div>
  );
}
