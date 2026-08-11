"use client";

import { useState } from "react";

/**
 * Collapsible source-text preview in the builder. Shows the lecturer what the
 * AI actually saw (PLAN §8 risk #5 — "see why before blaming the AI").
 */
export function SourceTextPreview({ text }: { text: string | null }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="rounded-lg border p-3 text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <span className="font-medium">Source text used for generation</span>
        <span>{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs text-muted-foreground">
          {text}
        </pre>
      )}
    </div>
  );
}
