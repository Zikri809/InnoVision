"use client";

import { BotAvatar } from "@/components/bot/bot-avatar";

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
        <span className="inline-flex items-center gap-1.5">
          <BotAvatar state="thinking" size={18} />
          {label ?? "Extracting text…"}
        </span>
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
