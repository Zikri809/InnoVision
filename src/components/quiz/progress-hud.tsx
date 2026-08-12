"use client";

/** Time (ms) below which the remaining-time display turns red. */
const WARNING_THRESHOLD_MS = 30_000;

/**
 * "Question n/N" + time remaining. Reuses the hand-rolled progress-bar
 * pattern from OcrProgress (no shadcn progress exists). Time is formatted
 * mm:ss from a monotonic countdown seeded server-side.
 */
export function ProgressHud({
  current,
  total,
  remainingMs,
}: {
  current: number;
  total: number;
  remainingMs: number | null;
}) {
  const pct = total <= 0 ? 0 : Math.min(100, Math.round((current / total) * 100));

  function formatMs(ms: number): string {
    if (ms <= 0) return "0:00";
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  return (
    <div className="w-40 space-y-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Question {Math.min(current, total)}/{total}
        </span>
        {remainingMs !== null && (
          <span className={remainingMs <= WARNING_THRESHOLD_MS ? "font-medium text-destructive" : ""}>
            {formatMs(remainingMs)}
          </span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
