import type { SessionStatus } from "@/lib/types/aliases";

/**
 * Pure types for the lecturer results dashboard (Phase 8).
 *
 * IMPORTANT: `ResultsSessionRow` deliberately carries NO `verify_nonce` and NO
 * `correct_index`/`explanation` fields — the results surface shows score +
 * per-session `is_correct` only (D10). The type-level absence is the backstop;
 * the RSC's explicit `.select(...)` projections are the enforcement (D8). A
 * future edit that adds one of these fields to this type should be treated as
 * a security regression.
 *
 * This module is 100% pure (no `process.env`, no imports of server-only
 * modules), so it can be unit-tested in Node and safely imported by the RSC.
 */

/** Four-member display status (D5) — DB `active`/`paused` map to in_progress when fresh. */
export type DisplayStatus = "abandoned" | "in_progress" | "flagged" | "completed";

/**
 * One event on a session's integrity timeline (D6). Only `event_session_id`-
 * matched audit rows (`session_reset`) merge into a session timeline; legacy
 * rows (origin unknowable) live in the student-level `legacyHistory`
 * aggregate — never merged here.
 */
export type IntegrityEvent =
  | {
      kind: "face_check";
      id: string;
      at: number;
      matched: boolean;
      distance: number | null;
      trigger: string;
      suspectedReplay: boolean;
      tooFrequent: boolean;
    }
  | {
      kind: "unavailable";
      id: string;
      at: number;
    }
  | {
      kind: "audit";
      id: string;
      at: number;
      action: string;
      actorId: string | null;
    };

/** Face-check aggregate chip for a session row. */
export type FaceCheckSummary = {
  fails: number;
  replays: number;
  tooFrequent: number;
  firstAt: number | null;
  lastAt: number | null;
};

/** Shape of a session_advisories row fed into the summary builder. */
export type ResultsAdvisoryInput = {
  session_id: string;
  adv_type: string;
  first_seen_at: string | null;
  last_seen_at: string | null;
  occurrences: number;
};

/** Advisory aggregate chips for a session row (lecturer review hints ONLY). */
export type AdvisorySummary = {
  secondFace: number;
  lookedAway: number;
  voiceActivity: number;
  headsetActive: number;
  lastAt: number | null;
};

/**
 * A fully-derived dashboard row. `total` = the quiz's question count;
 * `score` stays `null` for active/abandoned (never 0). `studentName` is null
 * when the roster misses the session's student (client renders "Removed
 * student" — the row is never dropped).
 */
export type ResultsSessionRow = {
  id: string;
  quiz_id: string;
  student_id: string;
  mode: string;
  status: SessionStatus;
  score: number | null;
  total: number;
  started_at: string | null;
  submitted_at: string | null;
  last_activity_at: string | null;
  face_unavailable_at: string | null;
  face_exempt: boolean;
  face_fail_streak: number;
  focus_pause_count?: number | null;
  studentName: string | null;
  displayStatus: DisplayStatus;
  faceSummary: FaceCheckSummary;
  advisorySummary: AdvisorySummary;
  integrityTimeline: IntegrityEvent[];
  legacyHistory: IntegrityEvent[];
};

/** Shape of a session row fed into `assembleResultsRows` (D8 projection). */
export type ResultsSessionInput = {
  id: string;
  quiz_id: string;
  student_id: string;
  mode: string;
  status: SessionStatus;
  score: number | null;
  started_at: string | null;
  submitted_at: string | null;
  last_activity_at: string | null;
  face_unavailable_at: string | null;
  face_exempt: boolean;
  face_fail_streak: number;
  focus_pause_count?: number | null;
};

/** Shape of a face-check row fed into the timeline builder. */
export type ResultsFaceCheckInput = {
  id: string;
  session_id: string;
  checked_at: string | null;
  matched: boolean;
  distance: number | null;
  trigger: string;
  suspected_replay: boolean;
  too_frequent: boolean;
};
