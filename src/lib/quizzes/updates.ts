import type { QuizMode } from "@/lib/types/aliases";

export interface QuizMetadataPatch {
  title?: string;
  mode?: QuizMode;
  timeLimitSec?: number | null;
  opensAt?: string | null;
  closesAt?: string | null;
  allowRetake?: boolean | null;
  maxAttempts?: number | null;
}

export interface QuizUpdateColumns {
  title?: string;
  mode?: QuizMode;
  time_limit_sec?: number | null;
  opens_at?: string | null;
  closes_at?: string | null;
  allow_retake?: boolean;
  max_attempts?: number;
}

/** The window fields a PATCH may carry while bypassing the draft-only lock. */
export const WINDOW_PATCH_KEYS = ["opensAt", "closesAt"] as const;

/** The retake-config fields that also bypass the draft-only lock (QC-4). */
export const RETAKE_PATCH_KEYS = ["allowRetake", "maxAttempts"] as const;

export function hasWindowFields(input: QuizMetadataPatch): boolean {
  return input.opensAt !== undefined || input.closesAt !== undefined;
}

export function hasRetakeFields(input: QuizMetadataPatch): boolean {
  return input.allowRetake !== undefined || input.maxAttempts !== undefined;
}

export function hasNonWindowFields(input: QuizMetadataPatch): boolean {
  return (
    input.title !== undefined ||
    input.mode !== undefined ||
    input.timeLimitSec !== undefined
  );
}

/**
 * Maps a validated PATCH payload to database update columns.
 * Enforces the business invariant that practice quizzes are untimed (time_limit_sec = null).
 *
 * Window fields (opens_at/closes_at) and retake fields (allow_retake/
 * max_attempts) pass through as-is: they are LIVE-quiz management
 * (PLAN_R_QUIZ_LIFECYCLE QC-3/QC-4) — the DB edit-lock deliberately
 * excludes them, and the route gates them separately. Retake fields are
 * INERT on practice quizzes (the RPC only reads them on the assessment
 * path), so no mode-based forcing is applied — mirroring the
 * `NULL is distinct from NULL` inertness proven for practice time_limit.
 */
export function buildQuizUpdates(
  input: QuizMetadataPatch,
  currentMode: QuizMode,
): QuizUpdateColumns {
  const updates: QuizUpdateColumns = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.mode !== undefined) updates.mode = input.mode;
  if (input.timeLimitSec !== undefined) updates.time_limit_sec = input.timeLimitSec;
  if (input.opensAt !== undefined) updates.opens_at = input.opensAt;
  if (input.closesAt !== undefined) updates.closes_at = input.closesAt;
  if (input.allowRetake !== undefined && input.allowRetake !== null) {
    updates.allow_retake = input.allowRetake;
  }
  if (input.maxAttempts !== undefined && input.maxAttempts !== null) {
    updates.max_attempts = input.maxAttempts;
  }

  const effectiveMode = input.mode ?? currentMode;
  if (effectiveMode === "practice") {
    updates.time_limit_sec = null;
  }
  return updates;
}