import type { SessionStatus, QuizStatus, LecturerAuditEvent } from "@/lib/types/aliases";
import type {
  DisplayStatus,
  FaceCheckSummary,
  IntegrityEvent,
  ResultsFaceCheckInput,
  ResultsSessionInput,
  ResultsSessionRow,
} from "./types";
import { ABANDON_STALE_MS, RESULTS_SESSION_LIMIT } from "./constants";

/**
 * Pure derivation + assembly for the lecturer results dashboard (Phase 8).
 *
 * IMPORTANT: this module is 100% pure — no `process.env`, no server-only
 * imports — so it is Node-unit-testable (U-T4 + suffixes) and safe to import
 * from the results RSC. The DB is untouched here: abandonment, timelines, and
 * row ordering are pure JS over explicit projections (D8). The generated
 * types are the backstop; the RSC's `.select(...)` literals are the guard.
 */

/** Parse an ISO string or ms number to epoch ms, or null when null/unparseable. */
export function toEpochMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  // PostgREST returns ISO strings; a bare numeric STRING (e.g. "1700000000000")
  // is accepted too so the helper's "ms number" contract is input-type-agnostic.
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const t = typeof numeric === "number" ? numeric : Date.parse(numeric);
  return Number.isFinite(t) ? t : null;
}

/** Epoch-ms or 0 (deterministic default — never NaN) for sorting. */
function toSortValue(value: string | number | null | undefined): number {
  return toEpochMs(value) ?? 0;
}

/**
 * D5 — derive the four-member display status for a session.
 *
 * Truth table (unit-pinned in derive.test.ts, U-T4; no dead members):
 *  - completed → completed, flagged → flagged (precedence over stale/closed).
 *  - if quizStatus !== 'live' (incl. draft) → abandoned (closed branch).
 *  - active/paused live: `nowMs − last_activity_at > 2h` → abandoned (`>`
 *    strict — exactly 2h is in_progress); NULL/future/unparseable
 *    last_activity_at → never stale (in_progress).
 */
export function deriveSessionDisplayStatus(
  session: { status: SessionStatus; last_activity_at: string | number | null },
  opts: { quizStatus: QuizStatus; nowMs: number },
): DisplayStatus {
  if (session.status === "completed") return "completed";
  if (session.status === "flagged") return "flagged";

  if (opts.quizStatus !== "live") return "abandoned";

  const t = toEpochMs(session.last_activity_at);
  if (t === null || t > opts.nowMs) return "in_progress";

  return opts.nowMs - t > ABANDON_STALE_MS ? "abandoned" : "in_progress";
}

/** U-T4b — face-check aggregate chip for a session row. */
export function summarizeFaceChecks(checks: ResultsFaceCheckInput[]): FaceCheckSummary {
  let fails = 0;
  let replays = 0;
  let tooFrequent = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;

  for (const c of checks) {
    if (!c.matched) fails++;
    if (c.suspected_replay) replays++;
    if (c.too_frequent) tooFrequent++;
    const t = toEpochMs(c.checked_at);
    if (t === null) continue;
    firstAt = firstAt === null || t < firstAt ? t : firstAt;
    lastAt = lastAt === null || t > lastAt ? t : lastAt;
  }

  return { fails, replays, tooFrequent, firstAt, lastAt };
}

const TYPE_RANK: Record<IntegrityEvent["kind"], number> = {
  audit: 0,
  unavailable: 1,
  face_check: 2,
};

/** Stable id tie-break (never NaN): ascending, falls back to string compare. */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * D6 — build a session's integrity timeline: face checks + the `unavailable`
 * marker + session-attributable audit rows, in time order.
 *
 * Attribution rule (pinned): `sessionAuditRows` are ALREADY pre-filtered to
 * `event_session_id = session.id` by the caller — legacy rows (origin
 * unknowable) never enter this function; they go to `assembleResultsRows` for
 * the student-level `legacyHistory` aggregate only.
 *
 * Sort: timestamp ASC → type-priority tie-break (audit before unavailable
 * before face check on equal timestamps) → `id` ASC (stable — mirrors the
 * 0008 `checked_at DESC, id DESC` discipline).
 */
export function buildIntegrityTimeline(
  session: { id: string; face_unavailable_at: string | null },
  faceChecks: ResultsFaceCheckInput[],
  sessionAuditRows: LecturerAuditEvent[],
): IntegrityEvent[] {
  const events: IntegrityEvent[] = [];

  for (const c of faceChecks) {
    const t = toEpochMs(c.checked_at);
    if (t === null) continue;
    events.push({
      kind: "face_check",
      id: c.id,
      at: t,
      matched: c.matched,
      distance: c.distance,
      trigger: c.trigger,
      suspectedReplay: c.suspected_replay,
      tooFrequent: c.too_frequent,
    });
  }

  const unavailableAt = toEpochMs(session.face_unavailable_at);
  if (unavailableAt !== null) {
    events.push({ kind: "unavailable", id: session.id, at: unavailableAt });
  }

  for (const a of sessionAuditRows) {
    const t = toEpochMs(a.created_at);
    // A `session_reset` row references the session it DELETED — it can never
    // truthfully live inside a surviving session's timeline (assemble results
    // routes it to the student-level aggregate). Defensive at the library
    // boundary too: if one slips through (torn RSC read), drop it.
    if (t === null || a.event_session_id !== session.id || a.action === "session_reset") continue;
    events.push({
      kind: "audit",
      id: a.id ?? "",
      at: t,
      action: a.action ?? "audit",
      actorId: a.actor_id,
    });
  }

  return events.sort((x, y) => {
    if (x.at !== y.at) return x.at - y.at;
    if (TYPE_RANK[x.kind] !== TYPE_RANK[y.kind]) return TYPE_RANK[x.kind] - TYPE_RANK[y.kind];
    return byId(x.id, y.id);
  });
}

const GROUP_RANK: Record<DisplayStatus, number> = {
  in_progress: 0,
  abandoned: 1,
  flagged: 2,
  completed: 3,
};

/**
 * Pinned comparator (D8): group rank
 * `{in_progress:0, abandoned:1, flagged:2, completed:3}`; within `in_progress`
 * → `last_activity_at` DESC; within `abandoned` → `last_activity_at` ASC
 * (oldest first); within `flagged`/`completed` → `started_at` DESC; tie → `id`
 * ASC. Unparseable/NULL timestamps sort as epoch 0 (deterministic — never NaN).
 */
function compareRows(a: ResultsSessionRow, b: ResultsSessionRow): number {
  const rank = GROUP_RANK[a.displayStatus] - GROUP_RANK[b.displayStatus];
  if (rank !== 0) return rank;

  let by: number;
  if (a.displayStatus === "in_progress") {
    by = toSortValue(b.last_activity_at) - toSortValue(a.last_activity_at); // DESC
  } else if (a.displayStatus === "abandoned") {
    by = toSortValue(a.last_activity_at) - toSortValue(b.last_activity_at); // ASC
  } else {
    by = toSortValue(b.started_at) - toSortValue(a.started_at); // DESC
  }
  if (by !== 0) return by;

  return byId(a.id, b.id);
}

type AssembleArgs = {
  quiz: { status: QuizStatus };
  sessions: ResultsSessionInput[];
  roster: { student_id: string; full_name: string | null }[];
  faceChecks: ResultsFaceCheckInput[];
  auditRows: LecturerAuditEvent[];
  totalQuestions: number;
  nowMs: number;
};

/**
 * D8 — assemble the sorted dashboard rows from the RSC's batched reads.
 *
 * Responsibilities (unit-pinned U-T4d):
 *  - Legacy audit rows (NULL `event_session_id`) land in the student's
 *    `legacyHistory` aggregate — never merged into a session timeline.
 *  - Attributable rows whose `event_session_id` matches a fetched session
 *    merge into that session's integrity timeline (D6). Attributable rows
 *    that match NO fetched session are split by WHY they don't match:
 *      · the subject has a fetched session → the row's session was deleted
 *        (e.g. a `session_reset` marker — the deleted session is the residual
 *        trail by design) OR the row was truncated away → surface it in the
 *        student-level `legacyHistory` aggregate (honest: it IS the student's,
 *        just not tied to a surviving session). This is what makes the plan
 *        §5 "surfaced" claim true for resets.
 *      · the subject has NO fetched session (student not in the current page
 *        of results) → dropped; `router.refresh()` reconciles a later page.
 *  - Session-without-roster keeps its row with `studentName: null`.
 *  - `score: null` stays `null`; `total` = the quiz's question count.
 */
export function assembleResultsRows({
  quiz,
  sessions,
  roster,
  faceChecks,
  auditRows,
  totalQuestions,
  nowMs,
}: AssembleArgs): ResultsSessionRow[] {
  const nameByStudent = new Map(roster.map((r) => [r.student_id, r.full_name]));

  // Students present in the fetched (≤200) session set — used to distinguish
  // "this student's session was deleted/truncated" from "student not shown".
  const sessionStudentIds = new Set(sessions.map((s) => s.student_id));
  const sessionIds = new Set(sessions.map((s) => s.id));

  // Partition audit rows once: attributable (has event_session_id) vs legacy.
  const attributableBySession = new Map<string, LecturerAuditEvent[]>();
  const legacyByStudent = new Map<string, IntegrityEvent[]>();
  const pushLegacy = (subjectId: string, a: LecturerAuditEvent, t: number) => {
    const list = legacyByStudent.get(subjectId) ?? [];
    list.push({
      kind: "audit",
      id: a.id ?? "",
      at: t,
      action: a.action ?? "audit",
      actorId: a.actor_id,
    });
    legacyByStudent.set(subjectId, list);
  };
  for (const a of auditRows) {
    const t = toEpochMs(a.created_at);
    if (t === null) continue;
    const subjectId = a.subject_id;
    if (subjectId === null) continue;
    // session_reset markers ALWAYS go to the student-level aggregate — they
    // reference the session they deleted, so merging one into a still-present
    // session's timeline is only ever a torn-read artifact (an RSC that read
    // the session before the reset landed). Legacy rows (NULL event_session_id)
    // also land here.
    if (a.event_session_id && a.action !== "session_reset") {
      if (sessionIds.has(a.event_session_id)) {
        const list = attributableBySession.get(a.event_session_id) ?? [];
        list.push(a);
        attributableBySession.set(a.event_session_id, list);
      } else if (sessionStudentIds.has(subjectId)) {
        // Attributable non-reset row whose session was truncated away →
        // surface in the subject's history aggregate (honest, not lost).
        pushLegacy(subjectId, a, t);
      }
      // Attributable row for a subject NOT in the fetched set → dropped (the
      // student rendered on a >200 page; refresh() reconciles the next page).
      continue;
    }
    pushLegacy(subjectId, a, t);
  }

  const checksBySession = new Map<string, ResultsFaceCheckInput[]>();
  for (const c of faceChecks) {
    const list = checksBySession.get(c.session_id) ?? [];
    list.push(c);
    checksBySession.set(c.session_id, list);
  }

  const rows: ResultsSessionRow[] = [];
  for (const s of sessions) {
    const sessionChecks = checksBySession.get(s.id) ?? [];
    // buildIntegrityTimeline sorts the merged timeline itself — no pre-sort.
    const sessionAudit = attributableBySession.get(s.id) ?? [];

    rows.push({
      id: s.id,
      quiz_id: s.quiz_id,
      student_id: s.student_id,
      mode: s.mode,
      status: s.status,
      score: s.score,
      total: totalQuestions,
      started_at: s.started_at,
      submitted_at: s.submitted_at,
      last_activity_at: s.last_activity_at,
      face_unavailable_at: s.face_unavailable_at,
      face_exempt: s.face_exempt,
      face_fail_streak: s.face_fail_streak,
      studentName: nameByStudent.get(s.student_id) ?? null,
      displayStatus: deriveSessionDisplayStatus(s, { quizStatus: quiz.status, nowMs }),
      faceSummary: summarizeFaceChecks(sessionChecks),
      integrityTimeline: buildIntegrityTimeline(s, sessionChecks, sessionAudit),
      // Copy the shared aggregate per row (never alias — a future consumer
      // could mutate one row's list and corrupt another's).
      legacyHistory: [...(legacyByStudent.get(s.student_id) ?? [])],
    });
  }

  return rows
    .sort(compareRows)
    .slice(0, Math.min(RESULTS_SESSION_LIMIT, rows.length));
}