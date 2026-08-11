"use client";

/**
 * Live per-page progress bar for the extraction cascade ("page 3/12" — a good
 * demo moment, PLAN §3.3).
 */
export function OcrProgress({
  page,
  total,
  label,
}: {
  page: number;
  total: number;
  label?: string;
}) {
  if (total <= 0) return null;
  const pct = Math.min(100, Math.round((page / total) * 100));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label ?? "Extracting text…"}</span>
        <span>
          page {Math.min(page, total)}/{total}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
