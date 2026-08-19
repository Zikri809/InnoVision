import type { QuizMode } from "@/lib/types/aliases";

export type QuizStatus = "draft" | "live" | "closed";

export const STATUS_LABEL: Record<QuizStatus, string> = {
  draft: "Draft",
  live: "Live",
  closed: "Closed",
};

export const STATUS_CLASS: Record<QuizStatus, string> = {
  draft: "border-border bg-muted text-stone-700 dark:text-stone-300",
  live: "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/40 dark:text-emerald-300",
  closed:
    "border-destructive/40 bg-destructive/10 text-red-800 dark:border-destructive/50 dark:bg-destructive/20 dark:text-red-300",
};

export const MODE_LABEL: Record<QuizMode, string> = {
  practice: "Practice",
  assessment: "Assessment",
};

export const MODE_CLASS: Record<QuizMode, string> = {
  practice:
    "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/40 dark:text-emerald-300",
  assessment:
    "border-blue-300 bg-blue-100 text-blue-900 dark:border-blue-700/50 dark:bg-blue-950/40 dark:text-blue-300",
};
