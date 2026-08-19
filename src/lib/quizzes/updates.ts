import type { QuizMode } from "@/lib/types/aliases";

export interface QuizMetadataPatch {
  title?: string;
  mode?: QuizMode;
  timeLimitSec?: number | null;
}

export interface QuizUpdateColumns {
  title?: string;
  mode?: QuizMode;
  time_limit_sec?: number | null;
}

/**
 * Maps a validated PATCH payload to database update columns.
 * Enforces the business invariant that practice quizzes are untimed (time_limit_sec = null).
 */
export function buildQuizUpdates(
  input: QuizMetadataPatch,
  currentMode: QuizMode,
): QuizUpdateColumns {
  const updates: QuizUpdateColumns = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.mode !== undefined) updates.mode = input.mode;
  if (input.timeLimitSec !== undefined) updates.time_limit_sec = input.timeLimitSec;

  const effectiveMode = input.mode ?? currentMode;
  if (effectiveMode === "practice") {
    updates.time_limit_sec = null;
  }
  return updates;
}
