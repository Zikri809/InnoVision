import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase, makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { _resetRateLimiter, _seedRateLimit } from "@/lib/classes/rate-limit";
import * as resetRoute from "@/app/api/sessions/[id]/reset/route";
import * as answerRoute from "@/app/api/sessions/[id]/answer/route";
import * as startRoute from "@/app/api/sessions/route";

const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

const reset = resetRoute;
const answer = answerRoute;
const start = startRoute;

const QUIZ_C = "00000000-0000-4000-8000-00000000000c";
const SESSION_ID = "00000000-0000-4000-8000-0000000000aa";
const STUDENT_ID = "00000000-0000-4000-8000-0000000000ff";
const LECTURER_ID = "00000000-0000-4000-8000-00000000000a";
const OTHER_LECTURER = "00000000-0000-4000-8000-0000000000cc";

function req(method = "DELETE"): Request {
  return new Request("http://localhost", { method, headers: { "content-type": "application/json" } });
}

function crossOriginReq(): Request {
  return new Request("http://localhost", {
    method: "DELETE",
    headers: { "content-type": "application/json", origin: "http://evil.example" },
  });
}

/** Live assessment quiz owned by the lecturer + a seeded session for STUDENT. */
function lecturerContext(opts?: { status?: string; mode?: string }) {
  const ctx = makeOwnerContext({ quizStatus: "live" });
  const quizRow = ctx.client.tables["quizzes"]![0];
  quizRow.mode = opts?.mode ?? "assessment";
  ctx.client.setUser(LECTURER_ID, "lecturer");
  ctx.client.seedSession({
    id: SESSION_ID,
    quiz_id: QUIZ_C,
    student_id: STUDENT_ID,
    mode: opts?.mode ?? "assessment",
    status: opts?.status ?? "active",
    score: null,
    started_at: "2026-01-01T00:00:00Z",
    last_activity_at: "2026-01-01T00:00:00Z",
    verify_nonce: "11111111-1111-4111-8111-111111111111",
    face_fail_streak: 0,
  });
  fakeHolder.current = ctx.client;
  return ctx;
}

beforeEach(() => {
  fakeHolder.current = undefined;
  _resetRateLimiter();
});

// ── I21: reset route contract ────────────────────────────────────────

describe("DELETE /api/sessions/[id]/reset — I21", () => {
  it("lecturer resets → 200 {ok:true} with attributable payload", async () => {
    const ctx = lecturerContext();
    ctx.client.seedAnswer({ id: "ans1", session_id: SESSION_ID, question_id: "q1", selected_index: 0, is_correct: true });
    ctx.client.seedFaceCheck({ id: "fc1", session_id: SESSION_ID, checked_at: "2026-01-01T00:00:00Z", matched: true, trigger: "start" });

    const res = await reset.DELETE(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted_session_id).toBe(SESSION_ID);
    expect(body.student_id).toBe(STUDENT_ID);
    expect(body.quiz_id).toBe(QUIZ_C);

    // Cascade: the session row + its answers + its face_checks are gone.
    expect(ctx.client.tables["quiz_sessions"] ?? []).toHaveLength(0);
    expect(ctx.client.tables["session_answers"] ?? []).toHaveLength(0);
    expect(ctx.client.tables["face_checks"] ?? []).toHaveLength(0);

    // Audit row pushed inline with attributable metadata.
    const audit = (ctx.client.tables["audit_events"] ?? []).find((a) => a.action === "session_reset");
    expect(audit).toBeTruthy();
    expect(audit?.actor_id).toBe(LECTURER_ID);
    expect(audit?.subject_id).toBe(STUDENT_ID);
    expect(audit?.metadata).toEqual({ session_id: SESSION_ID, quiz_id: QUIZ_C });
  });

  it("the assessment one-attempt slot is freed (re-start succeeds)", async () => {
    const ctx = lecturerContext();
    await reset.DELETE(req(), { params: Promise.resolve({ id: SESSION_ID }) });

    // Switch to the student and re-start the SAME quiz → a fresh session, not
    // already_attempted (the partial unique index row was cascade-deleted).
    ctx.client.setUser(STUDENT_ID, "student");
    const res = await start.POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quizId: QUIZ_C }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session?.id).toBeTruthy();
    expect(body.session?.id).not.toBe(SESSION_ID);
  });

  it("reset of any status (active/paused/flagged/completed → 200)", async () => {
    for (const status of ["active", "paused", "flagged", "completed"]) {
      const ctx = lecturerContext({ status });
      const res = await reset.DELETE(req(), { params: Promise.resolve({ id: SESSION_ID }) });
      expect(res.status, `status=${status}`).toBe(200);
      const audit = (ctx.client.tables["audit_events"] ?? []).find((a) => a.action === "session_reset");
      expect(audit, `audit for ${status}`).toBeTruthy();
    }
  });

  it("student → 403 not_lecturer", async () => {
    const ctx = makeOwnerContext({ quizStatus: "live" });
    ctx.client.tables["quizzes"]![0].mode = "assessment";
    ctx.client.setUser(STUDENT_ID, "student");
    ctx.client.seedSession({
      id: SESSION_ID, quiz_id: QUIZ_C, student_id: STUDENT_ID,
      mode: "assessment", status: "active", verify_nonce: "11111111-1111-4111-8111-111111111111",
    });
    fakeHolder.current = ctx.client;
    const res = await reset.DELETE(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(403);
    // No audit row, session untouched.
    expect(ctx.client.tables["quiz_sessions"] ?? []).toHaveLength(1);
    expect((ctx.client.tables["audit_events"] ?? []).length).toBe(0);
  });

  it("lecturer of ANOTHER quiz → 404 not_owner (no oracle)", async () => {
    const ctx = lecturerContext();
    // A different lecturer owns another class/quiz entirely (none seeded).
    ctx.client.setUser(OTHER_LECTURER, "lecturer");
    const res = await reset.DELETE(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(404);
    expect(ctx.client.tables["quiz_sessions"] ?? []).toHaveLength(1);
  });

  it("lecturer who OWNS a different quiz cannot reset this one (ownership negation)", async () => {
    const ctx = lecturerContext();
    // OTHER_LECTURER owns their own class + assessment quiz + session on it —
    // the ownership gate must still reject THIS (different) quiz's session.
    ctx.client.seedClass("00000000-0000-4000-8000-0000000000dd", OTHER_LECTURER);
    ctx.client.seedQuiz({
      id: "00000000-0000-4000-8000-0000000000ee",
      class_id: "00000000-0000-4000-8000-0000000000dd",
      created_by: OTHER_LECTURER,
      title: "Other Quiz",
      mode: "assessment",
      status: "live",
      time_limit_sec: null,
      source_file_url: null,
      source_text: null,
      created_at: "2026-01-01T00:00:00Z",
    });
    ctx.client.setUser(OTHER_LECTURER, "lecturer");
    const res = await reset.DELETE(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(404);
    expect(ctx.client.tables["quiz_sessions"] ?? []).toHaveLength(1);
  });

  it("non-owned (guessed) id → 404", async () => {
    lecturerContext();
    const res = await reset.DELETE(req(), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-00000000dead" }),
    });
    expect(res.status).toBe(404);
  });

  it("malformed id → 404", async () => {
    lecturerContext();
    const res = await reset.DELETE(req(), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(404);
  });

  it("CSRF cross-origin → 403", async () => {
    lecturerContext();
    const res = await reset.DELETE(crossOriginReq(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("invalid_origin");
  });

  it("rate limit → 429", async () => {
    lecturerContext();
    _seedRateLimit(`session-reset:${LECTURER_ID}`, 10);
    const res = await reset.DELETE(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(429);
  });

  it("practice-mode session → 400 not_assessment (no-op, no audit)", async () => {
    const ctx = lecturerContext({ mode: "practice" });
    const res = await reset.DELETE(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_assessment");
    expect(ctx.client.tables["quiz_sessions"] ?? []).toHaveLength(1);
    expect((ctx.client.tables["audit_events"] ?? []).length).toBe(0);
  });

  it("second DELETE on the same id → 404 (row gone — client treats as success)", async () => {
    lecturerContext();
    const first = await reset.DELETE(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(first.status).toBe(200);
    const second = await reset.DELETE(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(second.status).toBe(404);
  });

  it("transport/RPC-raise → 503, never a false 200", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: null, error: { message: "db connection dropped" } };
    const res = await reset.DELETE(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(503);
    // The session was NOT deleted by a failed RPC.
    expect(ctx.client.tables["quiz_sessions"] ?? []).toHaveLength(1);
  });

  it("non-{ok:true} payload → 503 (shape-assert)", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: { some: "garbage" }, error: null };
    const res = await reset.DELETE(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(503);
  });

  it("unknown RPC error key → 503 (mapFaceError default, never a raw message)", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: { error: "some_future_key" }, error: null };
    const res = await reset.DELETE(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
    const body = await res!.json();
    expect(body.error).not.toBe("some_future_key");
  });

  it("null payload with no error → 503 (shape-assert path)", async () => {
    const ctx = lecturerContext();
    // `undefined` (not null) so the stub seam overrides despite the default
    // `{data: null, error: null}`; simulates an RPC that returned no payload.
    ctx.client.rpcResult = { data: undefined, error: null };
    const res = await reset.DELETE(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
  });

  it("answer-after-reset → 404 not_owner (D13 mid-flight pin)", async () => {
    const ctx = lecturerContext();
    ctx.client.seedQuestion({ id: "11111111-1111-4111-8111-111111111111", quiz_id: QUIZ_C, order_index: 0, type: "mcq", prompt: "Q", options: ["a", "b"], correct_index: 0 });
    // Lecturer resets the session mid-flight.
    const resetRes = await reset.DELETE(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(resetRes).not.toBeNull();
    expect(resetRes!.status).toBe(200);
    // Student is mid-quiz (session was deleted by the lecturer mid-flight) → the
    // next answer POST surfaces a 404 not_owner (terminal dead screen client branch).
    ctx.client.setUser(STUDENT_ID, "student");
    const res = await answer.POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: SESSION_ID, questionId: "11111111-1111-4111-8111-111111111111", selectedIndex: 0 }),
      }),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });
});