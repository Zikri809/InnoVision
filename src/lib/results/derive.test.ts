import { describe, it, expect } from "vitest";
import type { ResultsSessionInput, ResultsSessionRow } from "./types";
import {
  assembleResultsRows,
  buildIntegrityTimeline,
  deriveSessionDisplayStatus,
  summarizeFaceChecks,
} from "./derive";
import { ABANDON_STALE_MS } from "./constants";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const SECOND = 1000;
const NOW = 1_000_000 * HOUR; // arbitrary fixed "now"

const ISO = (ms: number) => new Date(ms).toISOString();

// ── U-T4: exhaustive abandoned derivation (D5 truth table) ────────────

describe("U-T4 — deriveSessionDisplayStatus (D5 exhaustive)", () => {
  const live = { quizStatus: "live" as const };
  const closed = { quizStatus: "closed" as const };
  const draft = { quizStatus: "draft" as const };

  it("active stale (>2h) on a live quiz → abandoned", () => {
    expect(
      deriveSessionDisplayStatus(
        { status: "active", last_activity_at: ISO(NOW - 2 * HOUR - 1) },
        { ...live, nowMs: NOW },
      ),
    ).toBe("abandoned");
  });

  it("paused stale (>2h) on a live quiz → abandoned", () => {
    expect(
      deriveSessionDisplayStatus(
        { status: "paused", last_activity_at: ISO(NOW - 2 * HOUR - 1) },
        { ...live, nowMs: NOW },
      ),
    ).toBe("abandoned");
  });

  it("active fresh (≤2h) on a live quiz → in_progress", () => {
    expect(
      deriveSessionDisplayStatus(
        { status: "active", last_activity_at: ISO(NOW - HOUR) },
        { ...live, nowMs: NOW },
      ),
    ).toBe("in_progress");
  });

  it("paused fresh (≤2h) on a live quiz → in_progress", () => {
    expect(
      deriveSessionDisplayStatus(
        { status: "paused", last_activity_at: ISO(NOW - HOUR) },
        { ...live, nowMs: NOW },
      ),
    ).toBe("in_progress");
  });

  it("exactly 2h is in_progress (`>` is strict, never abandoned)", () => {
    expect(
      deriveSessionDisplayStatus(
        { status: "active", last_activity_at: ISO(NOW - ABANDON_STALE_MS) },
        { ...live, nowMs: NOW },
      ),
    ).toBe("in_progress");
  });

  it("active/paused on a closed quiz → abandoned regardless of freshness", () => {
    for (const status of ["active", "paused"] as const) {
      expect(
        deriveSessionDisplayStatus(
          { status, last_activity_at: ISO(NOW - 1000) },
          { ...closed, nowMs: NOW },
        ),
      ).toBe("abandoned");
    }
  });

  it("any non-live quiz status (incl. draft) treats active/paused as the closed branch", () => {
    expect(
      deriveSessionDisplayStatus(
        { status: "active", last_activity_at: ISO(NOW - 1000) },
        { ...draft, nowMs: NOW },
      ),
    ).toBe("abandoned");
  });

  it("flagged is never abandoned, even closed + stale", () => {
    expect(
      deriveSessionDisplayStatus(
        { status: "flagged", last_activity_at: ISO(NOW - 100 * HOUR) },
        { ...closed, nowMs: NOW },
      ),
    ).toBe("flagged");
  });

  it("completed is never abandoned, even closed + stale", () => {
    expect(
      deriveSessionDisplayStatus(
        { status: "completed", last_activity_at: ISO(NOW - 100 * HOUR) },
        { ...closed, nowMs: NOW },
      ),
    ).toBe("completed");
  });

  it("last_activity_at NULL → never stale (in_progress)", () => {
    expect(
      deriveSessionDisplayStatus(
        { status: "active", last_activity_at: null },
        { ...live, nowMs: NOW },
      ),
    ).toBe("in_progress");
  });

  it("last_activity_at future → never stale (in_progress)", () => {
    expect(
      deriveSessionDisplayStatus(
        { status: "active", last_activity_at: ISO(NOW + HOUR) },
        { ...live, nowMs: NOW },
      ),
    ).toBe("in_progress");
  });

  it("last_activity_at exactly now → in_progress (never stale boundary)", () => {
    expect(
      deriveSessionDisplayStatus(
        { status: "active", last_activity_at: NOW },
        { ...live, nowMs: NOW },
      ),
    ).toBe("in_progress");
  });

  it("accepts ms-number input (Date.parse-compatible)", () => {
    expect(
      deriveSessionDisplayStatus(
        { status: "active", last_activity_at: NOW - 3 * HOUR },
        { ...live, nowMs: NOW },
      ),
    ).toBe("abandoned");
  });

  it("accepts ISO string input", () => {
    expect(
      deriveSessionDisplayStatus(
        { status: "paused", last_activity_at: ISO(NOW - 3 * HOUR) },
        { ...live, nowMs: NOW },
      ),
    ).toBe("abandoned");
  });
});

// ── U-T4b: summarizeFaceChecks ────────────────────────────────────────

describe("U-T4b — summarizeFaceChecks", () => {
  it("counts fails/replays/too_frequent and tracks first/last timestamps", () => {
    const summary = summarizeFaceChecks([
      { id: "c1", session_id: "s", checked_at: ISO(NOW - 10_000), matched: false, distance: 0.9, trigger: "periodic", suspected_replay: false, too_frequent: false },
      { id: "c2", session_id: "s", checked_at: ISO(NOW - 5_000), matched: true, distance: 0.1, trigger: "question", suspected_replay: true, too_frequent: true },
      { id: "c3", session_id: "s", checked_at: ISO(NOW - 1_000), matched: false, distance: 0.8, trigger: "periodic", suspected_replay: true, too_frequent: true },
    ]);
    expect(summary.fails).toBe(2);
    expect(summary.replays).toBe(2);
    expect(summary.tooFrequent).toBe(2);
    expect(summary.firstAt).toBe(NOW - 10_000);
    expect(summary.lastAt).toBe(NOW - 1_000);
  });

  it("empty → all zeros and null timestamps", () => {
    expect(summarizeFaceChecks([])).toEqual({
      fails: 0,
      replays: 0,
      tooFrequent: 0,
      firstAt: null,
      lastAt: null,
    });
  });

  it("all-null checked_at: counts still increment, timestamps stay null (never NaN)", () => {
    expect(
      summarizeFaceChecks([
        { id: "c1", session_id: "s", checked_at: null, matched: false, distance: 1, trigger: "periodic", suspected_replay: true, too_frequent: true },
        { id: "c2", session_id: "s", checked_at: null, matched: false, distance: 1, trigger: "periodic", suspected_replay: false, too_frequent: false },
      ]),
    ).toEqual({ fails: 2, replays: 1, tooFrequent: 1, firstAt: null, lastAt: null });
  });
});

// ── U-T4c: buildIntegrityTimeline ────────────────────────────────────

describe("U-T4c — buildIntegrityTimeline", () => {
  const session = { id: "s1", face_unavailable_at: null };

  it("empty inputs → empty timeline", () => {
    expect(buildIntegrityTimeline(session, [], [])).toEqual([]);
  });

  it("merges face checks + unavailable marker + audit rows in time order", () => {
    const timeline = buildIntegrityTimeline(
      { id: "s1", face_unavailable_at: ISO(NOW - 3_000) },
      [
        { id: "c1", session_id: "s1", checked_at: ISO(NOW - 1_000), matched: true, distance: 0.1, trigger: "start", suspected_replay: false, too_frequent: false },
        { id: "c2", session_id: "s1", checked_at: ISO(NOW - 5_000), matched: false, distance: 0.9, trigger: "periodic", suspected_replay: false, too_frequent: false },
      ],
      [
        { id: "a1", actor_id: "lect", subject_id: "stu", action: "review_flagged", created_at: ISO(NOW - 2_000), event_quiz_id: "q1", event_session_id: "s1" },
      ],
    );
    expect(timeline.map((e) => [e.kind, e.at])).toEqual([
      ["face_check", NOW - 5_000],
      ["unavailable", NOW - 3_000],
      ["audit", NOW - 2_000],
      ["face_check", NOW - 1_000],
    ]);
  });

  it("equal timestamps: audit marker sorts before face check (type-priority + id)", () => {
    const timeline = buildIntegrityTimeline(
      session,
      [
        { id: "ccc", session_id: "s1", checked_at: ISO(NOW), matched: true, distance: 0.1, trigger: "periodic", suspected_replay: false, too_frequent: false },
        { id: "aaa", session_id: "s1", checked_at: ISO(NOW), matched: false, distance: 0.9, trigger: "periodic", suspected_replay: false, too_frequent: false },
      ],
      [
        { id: "m2", actor_id: "lect", subject_id: "stu", action: "review_flagged", created_at: ISO(NOW), event_quiz_id: "q1", event_session_id: "s1" },
        { id: "m1", actor_id: "lect", subject_id: "stu", action: "review_flagged", created_at: ISO(NOW), event_quiz_id: "q1", event_session_id: "s1" },
      ],
    );
    // Both audit markers (id ASC) come before both face checks (id ASC).
    expect(timeline.map((e) => e.id)).toEqual(["m1", "m2", "aaa", "ccc"]);
  });

  it("session_reset rows never merge into a session timeline (defensive)", () => {
    const timeline = buildIntegrityTimeline(
      session,
      [],
      [
        { id: "rs1", actor_id: "lect", subject_id: "stu", action: "session_reset", created_at: ISO(NOW), event_quiz_id: "q1", event_session_id: "s1" },
      ],
    );
    expect(timeline).toEqual([]);
  });

  it("an audit row with a mismatched event_session_id is never attached", () => {
    const timeline = buildIntegrityTimeline(
      session,
      [],
      [
        { id: "a-x", actor_id: "lect", subject_id: "stu", action: "review_flagged", created_at: ISO(NOW), event_quiz_id: "q1", event_session_id: "OTHER" },
      ],
    );
    expect(timeline).toEqual([]);
  });

  it("audit row with an unparseable created_at is skipped", () => {
    const timeline = buildIntegrityTimeline(
      session,
      [],
      [
        { id: "a-x", actor_id: "lect", subject_id: "stu", action: "review_flagged", created_at: "not-a-date", event_quiz_id: "q1", event_session_id: "s1" },
      ],
    );
    expect(timeline).toEqual([]);
  });

  it("face checks with null checked_at are skipped (never NaN sort)", () => {
    const timeline = buildIntegrityTimeline(
      session,
      [{ id: "c1", session_id: "s1", checked_at: null, matched: true, distance: 0.1, trigger: "start", suspected_replay: false, too_frequent: false }],
      [],
    );
    expect(timeline).toEqual([]);
  });
});

// ── U-T4d: assembleResultsRows ────────────────────────────────────────

const QUIZ = { status: "live" as const };

function session(overrides: Partial<ResultsSessionInput> = {}): ResultsSessionInput {
  return {
    id: "s",
    quiz_id: "q1",
    student_id: "stu",
    mode: "assessment",
    status: "active",
    score: null,
    started_at: ISO(NOW - HOUR),
    submitted_at: null,
    last_activity_at: ISO(NOW - 1000),
    face_unavailable_at: null,
    face_exempt: false,
    face_fail_streak: 0,
    ...overrides,
  };
}

describe("U-T4d — assembleResultsRows", () => {
  it("legacy audit rows land in legacyHistory, never integrityTimeline", () => {
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [
        { ...session({}), id: "s1", student_id: "stu" },
      ],
      roster: [{ student_id: "stu", full_name: "A Student" }],
      faceChecks: [],
      auditRows: [
        { id: "leg1", actor_id: "x", subject_id: "stu", action: "unlock", created_at: ISO(NOW - HOUR), event_quiz_id: null, event_session_id: null },
      ],
      totalQuestions: 3,
      nowMs: NOW,
    });
    expect(rows[0].legacyHistory.filter((e) => e.kind === "audit").map((e) => e.action)).toEqual(["unlock"]);
    expect(rows[0].integrityTimeline).toEqual([]);
  });

  it("attributable row with a DELETED session surfaces in legacyHistory (reset trail)", () => {
    // A session_reset marker references the DELETED session — it matches no
    // fetched session, but its SUBJECT has a fetched session, so it must
    // surface in the student-level aggregate (the plan §5 "residual trail"
    // claim) — never in a wrong session's timeline.
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [{ ...session({}), id: "s1", student_id: "stu" }],
      roster: [],
      faceChecks: [],
      auditRows: [
        { id: "a1", actor_id: "x", subject_id: "stu", action: "session_reset", created_at: ISO(NOW - HOUR), event_quiz_id: "q1", event_session_id: "VANISHED" },
      ],
      totalQuestions: 1,
      nowMs: NOW,
    });
    expect(rows[0].integrityTimeline).toEqual([]);
    expect(rows[0].legacyHistory.filter((e) => e.kind === "audit").map((e) => e.action)).toEqual([
      "session_reset",
    ]);
  });

  it("session_reset whose event_session_id matches a fetched session still goes to legacyHistory (torn-read guard)", () => {
    // NEW-2 pin: a concurrent reset between the RSC's read-2 (sessions) and
    // read-3 (audit) can produce a session_reset row whose event_session_id
    // MATCHES a still-fetched session id. It must NEVER merge into that
    // session's timeline (it references the DELETED session — a ghost row
    // would imply "reset and kept going").
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [{ ...session({}), id: "s1", student_id: "stu" }],
      roster: [],
      faceChecks: [],
      auditRows: [
        { id: "a1", actor_id: "x", subject_id: "stu", action: "session_reset", created_at: ISO(NOW - HOUR), event_quiz_id: "q1", event_session_id: "s1" },
      ],
      totalQuestions: 1,
      nowMs: NOW,
    });
    expect(rows[0].integrityTimeline).toEqual([]);
    expect(rows[0].legacyHistory.filter((e) => e.kind === "audit").map((e) => e.action)).toEqual([
      "session_reset",
    ]);
  });

  it("attributable row for a subject with NO fetched session is dropped", () => {
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [{ ...session({}), id: "s1", student_id: "stu" }],
      roster: [],
      faceChecks: [],
      auditRows: [
        { id: "a1", actor_id: "x", subject_id: "OTHER-STUDENT", action: "session_reset", created_at: ISO(NOW - HOUR), event_quiz_id: "q1", event_session_id: "VANISHED" },
      ],
      totalQuestions: 1,
      nowMs: NOW,
    });
    expect(rows[0].integrityTimeline).toEqual([]);
    expect(rows[0].legacyHistory).toEqual([]);
  });

  it("roster-miss keeps the row with studentName null (no crash)", () => {
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [{ ...session({}), id: "s1", student_id: "ghost" }],
      roster: [{ student_id: "stu", full_name: "A Student" }],
      faceChecks: [],
      auditRows: [],
      totalQuestions: 2,
      nowMs: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].studentName).toBeNull();
  });

  it("comparator: in_progress first (last_activity DESC), then abandoned (ASC)", () => {
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [
        { ...session({}), id: "ab2", student_id: "a", status: "active", last_activity_at: ISO(NOW - 100 * HOUR) },
        { ...session({}), id: "ip1", student_id: "b", status: "active", last_activity_at: ISO(NOW - 1000) },
        { ...session({}), id: "ab1", student_id: "c", status: "paused", last_activity_at: ISO(NOW - 50 * HOUR) },
        { ...session({}), id: "ip2", student_id: "d", status: "paused", last_activity_at: ISO(NOW - 2000) },
      ],
      roster: [],
      faceChecks: [],
      auditRows: [],
      totalQuestions: 0,
      nowMs: NOW,
    });
    expect(rows.map((r) => r.id)).toEqual(["ip1", "ip2", "ab2", "ab1"]);
  });

  it("flagged/completed sort by started_at DESC after the in_progress+abandoned groups", () => {
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [
        { ...session({}), id: "done1", student_id: "a", status: "completed", started_at: ISO(NOW - 5 * HOUR) },
        { ...session({}), id: "ip", student_id: "b", status: "active", last_activity_at: ISO(NOW - 1000) },
        { ...session({}), id: "flag", student_id: "c", status: "flagged", started_at: ISO(NOW - 3 * HOUR) },
        { ...session({}), id: "ab", student_id: "d", status: "active", last_activity_at: ISO(NOW - 100 * HOUR) },
        { ...session({}), id: "done2", student_id: "e", status: "completed", started_at: ISO(NOW - 6 * HOUR) },
      ],
      roster: [],
      faceChecks: [],
      auditRows: [],
      totalQuestions: 0,
      nowMs: NOW,
    });
    expect(rows.map((r) => r.id)).toEqual(["ip", "ab", "flag", "done1", "done2"]);
  });

  it("equal-timestamp tie resolves by id ASC", () => {
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [
        { ...session({}), id: "b", student_id: "a", status: "active", last_activity_at: ISO(NOW - 100 * HOUR) },
        { ...session({}), id: "a", student_id: "b", status: "active", last_activity_at: ISO(NOW - 100 * HOUR) },
      ],
      roster: [],
      faceChecks: [],
      auditRows: [],
      totalQuestions: 0,
      nowMs: NOW,
    });
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("null/unparseable timestamps sort as epoch 0 (never NaN)", () => {
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [
        { ...session({}), id: "s0", student_id: "a", status: "active", last_activity_at: null },
        { ...session({}), id: "s1", student_id: "b", status: "active", last_activity_at: "not-a-date" },
        { ...session({}), id: "s2", student_id: "c", status: "active", last_activity_at: ISO(NOW - 100 * HOUR) },
      ],
      roster: [],
      faceChecks: [],
      auditRows: [],
      totalQuestions: 0,
      nowMs: NOW,
    });
    // s0 (NULL) and s1 (unparseable) never-stale → in_progress group first,
    // ordered by last_activity_at DESC then id ASC; s2 (stale) → abandoned.
    expect(rows.map((r) => r.id)).toEqual(["s0", "s1", "s2"]);
  });

  it("score:null stays null; total passthrough", () => {
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [{ ...session({}), id: "s1", student_id: "stu", status: "active", score: null }],
      roster: [],
      faceChecks: [],
      auditRows: [],
      totalQuestions: 5,
      nowMs: NOW,
    });
    expect(rows[0].score).toBeNull();
    expect(rows[0].total).toBe(5);
  });

  it("empty roster/checks/audit → a row still assembles from the session", () => {
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [{ ...session({}), id: "s1", student_id: "stu", status: "completed", score: 2 }],
      roster: [],
      faceChecks: [],
      auditRows: [],
      totalQuestions: 3,
      nowMs: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].displayStatus).toBe("completed");
    expect(rows[0].faceSummary).toEqual({
      fails: 0,
      replays: 0,
      tooFrequent: 0,
      firstAt: null,
      lastAt: null,
    });
  });

  it("practice-mode sessions still derive display status (derivation applies)", () => {
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [
        { ...session({}), id: "p1", student_id: "stu", mode: "practice", status: "active", last_activity_at: ISO(NOW - 100 * HOUR) },
        { ...session({}), id: "p2", student_id: "stu2", mode: "practice", status: "completed", score: 1 },
      ],
      roster: [],
      faceChecks: [],
      auditRows: [],
      totalQuestions: 2,
      nowMs: NOW,
    });
    expect(rows.find((r) => r.id === "p1")?.displayStatus).toBe("abandoned");
    expect(rows.find((r) => r.id === "p2")?.displayStatus).toBe("completed");
  });

  it("face checks group per session and flow into faceSummary + timeline", () => {
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [{ ...session({}), id: "s1", student_id: "stu" }],
      roster: [],
      faceChecks: [
        { id: "fc2", session_id: "s1", checked_at: ISO(NOW - MINUTE), matched: true, distance: 0.3, trigger: "periodic", suspected_replay: false, too_frequent: false },
        { id: "fc1", session_id: "s1", checked_at: ISO(NOW - 5 * MINUTE), matched: false, distance: null, trigger: "manual", suspected_replay: true, too_frequent: true },
        // Wrong session — must not leak into s1's aggregates.
        { id: "fcX", session_id: "OTHER", checked_at: ISO(NOW - MINUTE), matched: false, distance: null, trigger: "manual", suspected_replay: false, too_frequent: false },
      ],
      auditRows: [],
      totalQuestions: 2,
      nowMs: NOW,
    });
    expect(rows[0].faceSummary).toEqual({
      fails: 1,
      replays: 1,
      tooFrequent: 1,
      firstAt: NOW - 5 * MINUTE,
      lastAt: NOW - MINUTE,
    });
    expect(rows[0].integrityTimeline.map((e) => e.kind)).toEqual(["face_check", "face_check"]);
    expect(rows[0].integrityTimeline.map((e) => (e.kind === "face_check" ? e.id : ""))).toEqual(["fc1", "fc2"]);
  });

  it("advisories group per session and flow into advisorySummary", () => {
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [{ ...session({}), id: "s1", student_id: "stu" }],
      roster: [],
      faceChecks: [],
      auditRows: [],
      advisories: [
        { session_id: "s1", adv_type: "second_face", first_seen_at: ISO(NOW - 9 * MINUTE), last_seen_at: ISO(NOW - 8 * MINUTE), occurrences: 2 },
        { session_id: "s1", adv_type: "looked_away", first_seen_at: null, last_seen_at: ISO(NOW - MINUTE), occurrences: 3 },
        { session_id: "s1", adv_type: "voice_activity", first_seen_at: null, last_seen_at: ISO(NOW - 2 * MINUTE), occurrences: -7.9 },
        { session_id: "s1", adv_type: "headset_active", first_seen_at: null, last_seen_at: null, occurrences: Number.NaN },
        { session_id: "s1", adv_type: "mystery_type", first_seen_at: null, last_seen_at: ISO(NOW - 30 * SECOND), occurrences: 1 },
        { session_id: "OTHER", adv_type: "second_face", first_seen_at: null, last_seen_at: ISO(NOW), occurrences: 99 },
      ],
      totalQuestions: 1,
      nowMs: NOW,
    });
    expect(rows[0].advisorySummary).toEqual({
      secondFace: 2,
      lookedAway: 3,
      voiceActivity: 0,
      headsetActive: 0,
      lastAt: NOW - 30 * SECOND,
    });
  });

  it("attributable row whose session matches NO fetched session but subject IS shown → legacyHistory (truncation)", () => {
    // A non-reset attributable row (e.g. unlock) referencing a session outside
    // the fetched page: its SUBJECT has a fetched session, so it must surface
    // in the student aggregate rather than silently vanish.
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [{ ...session({}), id: "s1", student_id: "stu" }],
      roster: [],
      faceChecks: [],
      auditRows: [
        { id: "a1", actor_id: "lec1", subject_id: "stu", action: "unlock", created_at: ISO(NOW - HOUR), event_quiz_id: "q1", event_session_id: "TRUNCATED-AWAY" },
      ],
      totalQuestions: 1,
      nowMs: NOW,
    });
    expect(rows[0].integrityTimeline).toEqual([]);
    expect(rows[0].legacyHistory.filter((e) => e.kind === "audit").map((e) => e.action)).toEqual([
      "unlock",
    ]);
  });

  it("attributable non-reset audit row merges into the matching session timeline", () => {
    const rows = assembleResultsRows({
      quiz: QUIZ,
      sessions: [{ ...session({}), id: "s1", student_id: "stu", face_unavailable_at: ISO(NOW - 4 * MINUTE) }],
      roster: [],
      faceChecks: [],
      auditRows: [
        { id: "a1", actor_id: "lec1", subject_id: "stu", action: "unlock", created_at: ISO(NOW - 2 * MINUTE), event_quiz_id: "q1", event_session_id: "s1" },
      ],
      totalQuestions: 1,
      nowMs: NOW,
    });
    // unavailable marker (earlier) then audit unlock — type-priority tie-break untested here, order is by time.
    expect(
      rows[0].integrityTimeline.map((e) => (e.kind === "audit" ? e.action : e.kind)),
    ).toEqual(["unavailable", "unlock"]);
    expect(rows[0].legacyHistory).toEqual([]);
  });
});

// ── Type-level pins ───────────────────────────────────────────────────

describe("ResultsSessionRow type surface", () => {
  it("never carries verify_nonce or correct_index (compile-time secrecy backstop)", () => {
    // Type-alias pins (NOT value assignments): each must be REMOVED (or the
    // directive becomes TS2578 "Unused '@ts-expect-error'") the moment the
    // field is added to the type. Note a value pin like
    // `const x: Row["verify_nonce"] = undefined` would NOT fire here — the
    // `= undefined` manufactures a strict TS2322 that keeps the directive
    // "used" even after the field is added.
    // @ts-expect-error verify_nonce must never exist on ResultsSessionRow
    type NeverNonce = ResultsSessionRow["verify_nonce"];
    // @ts-expect-error correct_index must never exist on ResultsSessionRow
    type NeverCorrectIndex = ResultsSessionRow["correct_index"];
    // @ts-expect-error explanation must never exist on ResultsSessionRow
    type NeverExplanation = ResultsSessionRow["explanation"];
    expect<NeverNonce | NeverCorrectIndex | NeverExplanation>(undefined).toBeUndefined();
  });
});