import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase, makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { _resetRateLimiter, _seedRateLimit } from "@/lib/classes/rate-limit";
import * as startRoute from "@/app/api/sessions/route";
import * as answerRoute from "@/app/api/sessions/[id]/answer/route";
import * as submitRoute from "@/app/api/sessions/[id]/submit/route";
import * as quizRoute from "@/app/api/quizzes/[id]/route";

const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

/**
 * NOTE: like ai-routes.test.ts we do NOT call vi.resetModules() — the rate
 * limiter is a module-level singleton; resetModules would hand the routes a
 * fresh (empty) bucket map while _seedRateLimit still targets the original
 * instance. Static imports + the mutable fakeHolder give each test a fresh
 * fake client without module re-loading.
 */
const start = startRoute;
const answer = answerRoute;
const submit = submitRoute;
const quiz = quizRoute;

const QUIZ_C = "00000000-0000-4000-8000-00000000000c";
const QUESTION_D = "00000000-0000-4000-8000-00000000000d";
const QUESTION_E = "00000000-0000-4000-8000-00000000000e";
const STUDENT_ID = "00000000-0000-4000-8000-0000000000ff";

function req(body?: unknown, init?: RequestInit): Request {
  return new Request("http://localhost", {
    method: init?.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function studentContext() {
  const client = new FakeSupabase();
  client.setUser(STUDENT_ID, "student");
  fakeHolder.current = client;
  return client;
}

/** A live practice quiz context seeded for the student (enrolled implicitly). */
function playContext(opts?: { mode?: "practice" | "assessment"; timeLimitSec?: number | null; questions?: number }) {
  const ctx = makeOwnerContext({ quizStatus: "live" });
  const quizRow = ctx.client.tables["quizzes"]![0];
  quizRow.mode = opts?.mode ?? "practice";
  quizRow.time_limit_sec = opts?.timeLimitSec ?? null;
  ctx.client.setUser(STUDENT_ID, "student");
  // Seed 3 questions for the quiz.
  ctx.client.seedQuestion({
    id: QUESTION_D,
    quiz_id: QUIZ_C,
    order_index: 0,
    type: "mcq",
    prompt: "Q1",
    options: ["a", "b"],
    correct_index: 0,
    explanation: "Because a.",
  });
  ctx.client.seedQuestion({
    id: QUESTION_E,
    quiz_id: QUIZ_C,
    order_index: 1,
    type: "mcq",
    prompt: "Q2",
    options: ["x", "y", "z"],
    correct_index: 2,
    explanation: null,
  });
  ctx.client.seedQuestion({
    id: "00000000-0000-4000-8000-00000000000f",
    quiz_id: QUIZ_C,
    order_index: 2,
    type: "true_false",
    prompt: "Q3",
    options: ["True", "False"],
    correct_index: 1,
    explanation: "Because false.",
  });
  fakeHolder.current = ctx.client;
  return ctx;
}

beforeEach(() => {
  fakeHolder.current = undefined;
  _resetRateLimiter();
});

describe("I-S1 — start happy path → 201 with session (mode copied)", () => {
  it("returns 201 { session } for a live practice quiz", async () => {
    playContext();
    const res = await start.POST(req({ quizId: QUIZ_C }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session.quiz_id).toBe(QUIZ_C);
    expect(body.session.mode).toBe("practice");
    expect(body.session.student_id).toBe(STUDENT_ID);
    expect(body.session.status).toBe("active");
  });

  it("returns 201 for an assessment first attempt", async () => {
    playContext({ mode: "assessment" });
    const res = await start.POST(req({ quizId: QUIZ_C }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session.mode).toBe("assessment");
  });

  it("practice rejoin: an existing active session returns the SAME id (201)", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    const res = await start.POST(req({ quizId: QUIZ_C }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session.id).toBe("00000000-0000-4000-8000-0000000000aa");
    expect(body.session.status).toBe("active");
  });
});

describe("I-S2 — start assessment already attempted → 409 already_attempted + session_id", () => {
  it("returns 409 with the existing session id", async () => {
    const ctx = playContext({ mode: "assessment" });
    // Seed an existing assessment session for this student.
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "assessment",
      status: "active",
    });
    const res = await start.POST(req({ quizId: QUIZ_C }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("already_attempted");
    expect(body.session_id).toBe("00000000-0000-4000-8000-0000000000aa");
  });
});

describe("I-S3 — start not-live / not-enrolled → 404 (no oracle)", () => {
  it("returns 404 when the quiz is not live", async () => {
    const ctx = makeOwnerContext({ quizStatus: "draft" });
    ctx.client.setUser(STUDENT_ID, "student");
    fakeHolder.current = ctx.client;
    const res = await start.POST(req({ quizId: QUIZ_C }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("returns 404 for a non-existent quiz (no oracle)", async () => {
    studentContext();
    const res = await start.POST(req({ quizId: "00000000-0000-4000-8000-000000000099" }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the RPC reports not_enrolled (no oracle)", async () => {
    const ctx = playContext();
    ctx.client.rpcResult = { data: { error: "not_enrolled" }, error: null };
    const res = await start.POST(req({ quizId: QUIZ_C }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });
});

describe("I-S4 — start as lecturer → 403", () => {
  it("returns 403 before any RPC call", async () => {
    const ctx = makeOwnerContext({ quizStatus: "live" });
    fakeHolder.current = ctx.client;
    const res = await start.POST(req({ quizId: QUIZ_C }));
    expect(res.status).toBe(403);
  });
});

describe("I-S5 — answer as lecturer → 403", () => {
  it("returns 403 before any RPC call", async () => {
    const ctx = makeOwnerContext({ quizStatus: "live" });
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    fakeHolder.current = ctx.client;
    const res = await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 0 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("I-S6 — answer RPC not_owner → 404", () => {
  it("returns 404 when the session is not owned by the student", async () => {
    const ctx = playContext();
    // A session owned by a DIFFERENT student.
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: "00000000-0000-4000-8000-0000000000ee",
      mode: "practice",
      status: "active",
    });
    const res = await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 0 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("I-S7 — answer invalid body → 400", () => {
  it("rejects non-integer selectedIndex", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    const res = await answer.POST(req({ questionId: QUESTION_D, selectedIndex: "0" }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
  });

  it("rejects invalid JSON body", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    const res = await answer.POST(new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });
});

describe("I-S8 — cross-origin start/answer/submit → 403 invalid_origin", () => {
  it("rejects a cross-origin POST on all three routes", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    const cross = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example.com" },
      body: JSON.stringify({ quizId: QUIZ_C }),
    });
    expect((await start.POST(cross)).status).toBe(403);
    expect(
      (await answer.POST(cross, { params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }) })).status,
    ).toBe(403);
    expect(
      (await submit.POST(cross, { params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }) })).status,
    ).toBe(403);
  });
});

describe("I-S9 — answer rate limit → 429", () => {
  it("returns 429 after seeding the answer bucket", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    _seedRateLimit(`answer:${STUDENT_ID}`, 120);
    const res = await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 0 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
  });
});

describe("start/submit rate limits + start invalid JSON", () => {
  it("start: returns 429 after seeding the start bucket", async () => {
    playContext();
    _seedRateLimit(`start:${STUDENT_ID}`, 10);
    const res = await start.POST(req({ quizId: QUIZ_C }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
  });

  it("start: invalid JSON body → 400", async () => {
    const ctx = playContext();
    fakeHolder.current = ctx.client;
    const res = await start.POST(new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });

  it("submit: returns 429 after seeding the submit bucket", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    _seedRateLimit(`submit:${STUDENT_ID}`, 10);
    const res = await submit.POST(req(), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
  });
});

describe("I-S10 — submit as lecturer → 403", () => {
  it("returns 403 before any RPC call", async () => {
    const ctx = makeOwnerContext({ quizStatus: "live" });
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    fakeHolder.current = ctx.client;
    const res = await submit.POST(req(), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("I-S11 — submit RPC not_owner → 404", () => {
  it("returns 404 for a session owned by another student", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: "00000000-0000-4000-8000-0000000000ee",
      mode: "practice",
      status: "active",
    });
    const res = await submit.POST(req(), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("I7 — assessment answer happy path → { isCorrect } only, no key", () => {
  it("returns isCorrect and NO correctIndex/explanation", async () => {
    const ctx = playContext({ mode: "assessment" });
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "assessment",
      status: "active",
    });
    const res = await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 0 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ isCorrect: true });
    expect("correctIndex" in body).toBe(false);
    expect("explanation" in body).toBe(false);
  });
});

describe("I8 — practice answer happy path → isCorrect + correctIndex (+ explanation)", () => {
  it("returns the full practice payload", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    const res = await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 1 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ isCorrect: false, correctIndex: 0, explanation: "Because a." });
  });

  it("omits explanation when the RPC returns null", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    const res = await answer.POST(req({ questionId: QUESTION_E, selectedIndex: 2 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ isCorrect: true, correctIndex: 2 });
    expect("explanation" in body).toBe(false);
  });
});

describe("I9 — RPC time_expired (seeded) → 403", () => {
  it("maps seeded { error: 'time_expired' } to 403", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "assessment",
      status: "active",
    });
    ctx.client.rpcResult = { data: { error: "time_expired" }, error: null };
    const res = await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 0 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("time_expired");
  });
});

describe("I9b — RPC session_not_active → 409", () => {
  it("maps a completed session to 409 session_not_active", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "completed",
    });
    const res = await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 0 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("session_not_active");
  });
});

describe("I10 — assessment re-answer → 409 already_answered with payload passthrough", () => {
  it("returns 409 { error: 'already_answered', isCorrect } and no key", async () => {
    const ctx = playContext({ mode: "assessment" });
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "assessment",
      status: "active",
    });
    ctx.client.seedAnswer({
      id: "00000000-0000-4000-8000-0000000000bb",
      session_id: "00000000-0000-4000-8000-0000000000aa",
      question_id: QUESTION_D,
      selected_index: 0,
      is_correct: true,
    });
    const res = await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 1 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: "already_answered", isCorrect: true });
    expect("correctIndex" in body).toBe(false);
    expect("explanation" in body).toBe(false);
  });

  it("practice re-answer → 200 upsert with full practice payload", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    ctx.client.seedAnswer({
      id: "00000000-0000-4000-8000-0000000000bb",
      session_id: "00000000-0000-4000-8000-0000000000aa",
      question_id: QUESTION_D,
      selected_index: 0,
      is_correct: true,
    });
    const res = await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 1 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ isCorrect: false, correctIndex: 0, explanation: "Because a." });
  });
});

describe("I11 — invalid_question → 400", () => {
  it("maps RPC invalid_question to 400", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    ctx.client.rpcResult = { data: { error: "invalid_question" }, error: null };
    const res = await answer.POST(req({ questionId: "00000000-0000-4000-8000-000000000099", selectedIndex: 0 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_question");
  });
});

describe("I-S14 — invalid_selected_index → 400", () => {
  it("maps RPC invalid_selected_index to 400", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    // selectedIndex 9 is out of range for a 2-option question → RPC stub
    // returns invalid_selected_index without needing the seam.
    const res = await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 9 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_selected_index");
  });
});

describe("I12 — submit happy path → 200 with completed session + score", () => {
  it("computes score and marks the session completed", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    ctx.client.seedAnswer({
      id: "00000000-0000-4000-8000-0000000000bb",
      session_id: "00000000-0000-4000-8000-0000000000aa",
      question_id: QUESTION_D,
      selected_index: 0,
      is_correct: true,
    });
    ctx.client.seedAnswer({
      id: "00000000-0000-4000-8000-0000000000cc",
      session_id: "00000000-0000-4000-8000-0000000000aa",
      question_id: QUESTION_E,
      selected_index: 0,
      is_correct: false,
    });
    const res = await submit.POST(req(), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.score).toBe(1);
    expect(body.total).toBe(3);
    expect(body.session.status).toBe("completed");
    expect(body.session.submitted_at).toBeTruthy();
  });
});

describe("I-S15 — submit with no answers → 200 score 0", () => {
  it("returns score 0 / total N", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "assessment",
      status: "active",
    });
    const res = await submit.POST(req(), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.score).toBe(0);
    expect(body.total).toBe(3);
  });
});

describe("I13 — submit already submitted → 409 already_submitted, score unchanged", () => {
  it("returns 409 with the existing payload", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "assessment",
      status: "completed",
      score: 2,
      submitted_at: "2026-01-01T00:02:00Z",
    });
    const res = await submit.POST(req(), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("already_submitted");
    expect(body.score).toBe(2);
  });
});

describe("I-S12 — quiz DELETE guard: blocked when sessions exist", () => {
  it("returns 409 quiz_has_sessions when a session exists", async () => {
    const ctx = makeOwnerContext({ quizStatus: "live" });
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    fakeHolder.current = ctx.client;
    const res = await quiz.DELETE(req(), { params: Promise.resolve({ id: QUIZ_C }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("quiz_has_sessions");
  });

  it("deletes successfully when no sessions exist", async () => {
    const ctx = makeOwnerContext({ quizStatus: "live" });
    fakeHolder.current = ctx.client;
    const res = await quiz.DELETE(req(), { params: Promise.resolve({ id: QUIZ_C }) });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("returns 503 when the session-count pre-check fails (no raw message)", async () => {
    const ctx = makeOwnerContext({ quizStatus: "live" });
    ctx.client.countError = "boom";
    fakeHolder.current = ctx.client;
    const res = await quiz.DELETE(req(), { params: Promise.resolve({ id: QUIZ_C }) });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("boom");
  });
});

describe("Session route error-mapping branches", () => {
  it("start: transport error → 503 internal (never a raw message)", async () => {
    const ctx = playContext();
    ctx.client.rpcResult = { data: null, error: { message: "boom" } };
    const res = await start.POST(req({ quizId: QUIZ_C }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("boom");
  });

  it("answer: transport error → 503 internal", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    ctx.client.rpcResult = { data: null, error: { message: "boom" } };
    const res = await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 0 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(503);
  });

  it("submit: transport error → 503 internal", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    ctx.client.rpcResult = { data: null, error: { message: "boom" } };
    const res = await submit.POST(req(), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(503);
  });

  it("start: RPC returns an unknown payload → 503", async () => {
    const ctx = playContext();
    ctx.client.rpcResult = { data: { something: "unexpected" }, error: null };
    const res = await start.POST(req({ quizId: QUIZ_C }));
    expect(res.status).toBe(503);
  });

  it("answer: non-UUID session id → 404 before auth", async () => {
    playContext();
    const res = await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 0 }), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(404);
  });

  it("submit: non-UUID session id → 404 before auth", async () => {
    playContext();
    const res = await submit.POST(req(), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(404);
  });

  it("start: invalid body → 400", async () => {
    playContext();
    const res = await start.POST(req({ quizId: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });
});

describe("Session route defensive branches (not_student / not_authenticated / unknown payload)", () => {
  it("start: RPC not_student → 403; not_authenticated → 401", async () => {
    const ctx = playContext();
    ctx.client.rpcResult = { data: { error: "not_student" }, error: null };
    expect((await start.POST(req({ quizId: QUIZ_C }))).status).toBe(403);

    ctx.client.rpcResult = { data: { error: "not_authenticated" }, error: null };
    expect((await start.POST(req({ quizId: QUIZ_C }))).status).toBe(401);
  });

  it("answer: RPC quiz_not_live → 409", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    ctx.client.rpcResult = { data: { error: "quiz_not_live" }, error: null };
    const res = await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 0 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("quiz_not_live");
  });

  it("answer: RPC not_student → 403; not_authenticated → 401; unknown payload → 503", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    ctx.client.rpcResult = { data: { error: "not_student" }, error: null };
    expect(
      (await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 0 }), {
        params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
      })).status,
    ).toBe(403);

    ctx.client.rpcResult = { data: { error: "not_authenticated" }, error: null };
    expect(
      (await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 0 }), {
        params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
      })).status,
    ).toBe(401);

    ctx.client.rpcResult = { data: { unexpected: true }, error: null };
    const res = await answer.POST(req({ questionId: QUESTION_D, selectedIndex: 0 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("unexpected");
  });

  it("submit: RPC session_not_active → 409; not_student → 403; not_authenticated → 401; unknown payload → 503", async () => {
    const ctx = playContext();
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000aa",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
    });
    ctx.client.rpcResult = { data: { error: "session_not_active" }, error: null };
    const res1 = await submit.POST(req(), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res1.status).toBe(409);
    expect((await res1.json()).error).toBe("session_not_active");

    ctx.client.rpcResult = { data: { error: "not_student" }, error: null };
    expect(
      (await submit.POST(req(), {
        params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
      })).status,
    ).toBe(403);

    ctx.client.rpcResult = { data: { error: "not_authenticated" }, error: null };
    expect(
      (await submit.POST(req(), {
        params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
      })).status,
    ).toBe(401);

    ctx.client.rpcResult = { data: { unexpected: true }, error: null };
    const res = await submit.POST(req(), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000aa" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("unexpected");
  });
});
