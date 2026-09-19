import type { QuizMode } from "@/lib/types/aliases";

export interface QuizMetadataPatch {
  title?: string;
  mode?: QuizMode;
  timeLimitSec?: number | null;
  opensAt?: string | null;
  closesAt?: string | null;
  allowRetake?: boolean | null;
  maxAttempts?: number | null;
  shuffleQuestions?: boolean | null;
  /** v4.9: the gesture switch (draft-frozen like shuffleQuestions). */
  gesturesEnabled?: boolean | null;
}

export interface QuizUpdateColumns {
  title?: string;
  mode?: QuizMode;
  time_limit_sec?: number | null;
  opens_at?: string | null;
  closes_at?: string | null;
  allow_retake?: boolean;
  max_attempts?: number;
  shuffle_questions?: boolean;
  gestures_enabled?: boolean;
}

/**
 * Defaults for the `not null default` retake/shuffle columns (0032:46-47,
 * 0034:28). audit-3 C-F5: these fields are declared nullable in
 * UpdateQuizSchema, but the columns are NOT NULL with a DEFAULT, so an
 * explicit `null` cannot be stored. The old code silently DROPPED it (a
 * `{maxAttempts: null}`-only PATCH produced an empty update → PostgREST
 * `SELECT … WHERE false` → 404 not_found, which is a lie: nothing was
 * missing). A null now means "reset this field to its column default", which
 * is the semantically correct reading for a NOT NULL DEFAULT column and is
 * consistent with the window/timeLimit nulls meaning "clear the bound".
 */
export const QUIZ_FIELD_DEFAULTS = {
  allow_retake: false,
  max_attempts: 1,
  shuffle_questions: false,
  // v4.9: the gesture switch defaults ON, preserving the behaviour every
  // existing quiz had before the column existed (D9). A null in a PATCH
  // therefore resets to ENABLED, not disabled.
  gestures_enabled: true,
} as const;

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
    input.timeLimitSec !== undefined ||
    input.shuffleQuestions !== undefined ||
    // v4.9 (D9): gestures_enabled is draft-frozen exactly like
    // shuffle_questions. Flipping the modality under in-flight students
    // would leave some answering by gesture and some by keyboard against a
    // single quiz row, with no per-student migration path.
    input.gesturesEnabled !== undefined
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
 *
 * shuffleQuestions (QT-3) is FROZEN metadata: it counts as a non-window
 * field (hasNonWindowFields) so a non-draft PATCH carrying it hits the
 * blanket 409 — the DB trigger quiz_not_draft_edit (0034) is the backstop.
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
  if (input.allowRetake !== undefined) {
    updates.allow_retake = input.allowRetake ?? QUIZ_FIELD_DEFAULTS.allow_retake;
  }
  if (input.maxAttempts !== undefined) {
    updates.max_attempts = input.maxAttempts ?? QUIZ_FIELD_DEFAULTS.max_attempts;
  }
  if (input.shuffleQuestions !== undefined) {
    updates.shuffle_questions = input.shuffleQuestions ?? QUIZ_FIELD_DEFAULTS.shuffle_questions;
  }
  if (input.gesturesEnabled !== undefined) {
    updates.gestures_enabled = input.gesturesEnabled ?? QUIZ_FIELD_DEFAULTS.gestures_enabled;
  }

  const effectiveMode = input.mode ?? currentMode;
  if (effectiveMode === "practice") {
    updates.time_limit_sec = null;
  }
  return updates;
}