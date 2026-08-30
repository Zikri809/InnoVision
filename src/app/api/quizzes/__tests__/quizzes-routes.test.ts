import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase, makeOwnerContext } from "./fake-supabase";

// Route modules import createClient from "@/lib/supabase/server". Mock it to
// return our fake so the REAL guards + handlers run against in-memory tables.
const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

async function importHandlers() {
  const createQuiz = await import("@/app/api/classes/[id]/quizzes/route");
  const quizRoute = await import("@/app/api/quizzes/[id]/route");
  const publish = await import("@/app/api/quizzes/[id]/publish/route");
  const questions = await import("@/app/api/quizzes/[id]/questions/route");
  const questionRoute = await import(
    "@/app/api/quizzes/[id]/questions/[questionId]/route"
  );
  const reorder = await import("@/app/api/quizzes/[id]/reorder/route");
  return { createQuiz, quizRoute, publish, questions, questionRoute, reorder };
}

const CLASS_B = "00000000-0000-4000-8000-00000000000b";
const QUIZ_C = "00000000-0000-4000-8000-00000000000c";
const QUESTION_D = "00000000-0000-4000-8000-00000000000d";

const validQuestion = {
  type: "mcq",
  prompt: "What is 2+2?",
  options: ["1", "2", "3", "4"],
  correctIndex: 3,
};

function req(body?: unknown, init?: RequestInit): Request {
  return new Request("http://localhost", {
    method: init?.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function studentContext() {
  const client = new FakeSupabase();
  client.setUser("00000000-0000-4000-8000-0000000000ff", "student");
  fakeHolder.current = client;
  return client;
}

function ownerContext(opts?: Parameters<typeof makeOwnerContext>[0]) {
  const ctx = makeOwnerContext(opts);
  fakeHolder.current = ctx.client;
  return ctx;
}

/** The fake client currently installed on the mocked createClient(). */
function currentClient(): FakeSupabase {
  const client = fakeHolder.current;
  if (!client) throw new Error("No fake client installed — call ownerContext/studentContext first.");
  return client;
}

beforeEach(() => {
  vi.resetModules();
  fakeHolder.current = undefined;
});

describe("I20 — AuthZ sweep: student blocked from every lecturer-only quiz route", () => {
  it("POST /api/classes/[id]/quizzes → 403", async () => {
    studentContext();
    const { createQuiz } = await importHandlers();
    const res = await createQuiz.POST(req({ title: "Hacked" }), {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(403);
  });

  it("PATCH /api/quizzes/[id] → 403", async () => {
    studentContext();
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ title: "X" }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(403);
  });

  it("DELETE /api/quizzes/[id] → 403", async () => {
    studentContext();
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.DELETE(req(), { params: Promise.resolve({ id: QUIZ_C }) });
    expect(res.status).toBe(403);
  });

  it("POST /api/quizzes/[id]/publish → 403", async () => {
    studentContext();
    const { publish } = await importHandlers();
    const res = await publish.POST(req(), { params: Promise.resolve({ id: QUIZ_C }) });
    expect(res.status).toBe(403);
  });

  it("POST /api/quizzes/[id]/questions → 403", async () => {
    studentContext();
    const { questions } = await importHandlers();
    const res = await questions.POST(req(validQuestion), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(403);
  });

  it("PATCH /api/quizzes/[id]/questions/[questionId] → 403", async () => {
    studentContext();
    const { questionRoute } = await importHandlers();
    const res = await questionRoute.PATCH(req(validQuestion), {
      params: Promise.resolve({ id: QUIZ_C, questionId: QUESTION_D }),
    });
    expect(res.status).toBe(403);
  });

  it("DELETE /api/quizzes/[id]/questions/[questionId] → 403", async () => {
    studentContext();
    const { questionRoute } = await importHandlers();
    const res = await questionRoute.DELETE(req(), {
      params: Promise.resolve({ id: QUIZ_C, questionId: QUESTION_D }),
    });
    expect(res.status).toBe(403);
  });

  it("POST /api/quizzes/[id]/reorder → 403", async () => {
    studentContext();
    const { reorder } = await importHandlers();
    const res = await reorder.POST(req({ questionIds: [QUESTION_D] }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(403);
  });
});

describe("Owner authorization (non-owner lecturer → 404, no oracle)", () => {
  it("I-Q8 non-owner lecturer gets 404 on quiz routes", async () => {
    const other = new FakeSupabase();
    other.setUser("00000000-0000-4000-8000-0000000000ee", "lecturer");
    // Seed a DIFFERENT lecturer's class+quiz so the owner check fails.
    other.seedClass(CLASS_B, "00000000-0000-4000-8000-0000000000aa");
    other.seedQuiz({
      id: QUIZ_C,
      class_id: CLASS_B,
      created_by: "00000000-0000-4000-8000-0000000000aa",
      status: "draft",
    });
    fakeHolder.current = other;

    const { quizRoute, publish, questions } = await importHandlers();
    expect((await quizRoute.PATCH(req({ title: "X" }), { params: Promise.resolve({ id: QUIZ_C }) })).status).toBe(404);
    expect((await quizRoute.DELETE(req(), { params: Promise.resolve({ id: QUIZ_C }) })).status).toBe(404);
    expect((await publish.POST(req(), { params: Promise.resolve({ id: QUIZ_C }) })).status).toBe(404);
    expect((await questions.POST(req(validQuestion), { params: Promise.resolve({ id: QUIZ_C }) })).status).toBe(404);
  });
});

describe("Validation & business rules", () => {
  it("I-Q9 invalid body → 400", async () => {
    ownerContext();
    const { createQuiz, questions } = await importHandlers();

    const badQuiz = await createQuiz.POST(req({ title: "" }), {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(badQuiz.status).toBe(400);

    const badQuestion = await questions.POST(
      req({ ...validQuestion, correctIndex: 9 }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(badQuestion.status).toBe(400);
  });

  it("I-Q10 publish with 0 questions → 409 no_questions", async () => {
    ownerContext(); // no questions seeded
    const { publish } = await importHandlers();
    const res = await publish.POST(req(), { params: Promise.resolve({ id: QUIZ_C }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("no_questions");
  });

  it("I-Q11 edit question on a live quiz → 409", async () => {
    ownerContext({ quizStatus: "live", questions: [{ id: QUESTION_D, quiz_id: QUIZ_C, order_index: 0 }] });
    const { questionRoute } = await importHandlers();
    const res = await questionRoute.PATCH(req(validQuestion), {
      params: Promise.resolve({ id: QUIZ_C, questionId: QUESTION_D }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("quiz_not_draft");
  });

  it("I-Q12 add question happy path → 201, appended order_index", async () => {
    ownerContext({
      questions: [
        { id: QUESTION_D, quiz_id: QUIZ_C, order_index: 0 },
        { id: "00000000-0000-4000-8000-00000000000e", quiz_id: QUIZ_C, order_index: 1 },
      ],
    });
    const { questions } = await importHandlers();
    const res = await questions.POST(req(validQuestion), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.question.order_index).toBe(2);
    expect(body.question.correct_index).toBe(3);
  });

  it("I-Q13 reorder happy path → 200 via RPC", async () => {
    ownerContext();
    const { reorder } = await importHandlers();
    currentClient().rpcResult = { data: null, error: null };
    const res = await reorder.POST(req({ questionIds: [QUESTION_D] }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("reorder maps RPC foreign_question_id → 400", async () => {
    ownerContext();
    const { reorder } = await importHandlers();
    currentClient().rpcResult = {
      data: null,
      error: { message: "foreign_question_id" },
    };
    const res = await reorder.POST(req({ questionIds: [QUESTION_D] }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(400);
  });

  it("non-UUID param → 404 before any DB access", async () => {
    ownerContext();
    const { quizRoute, publish } = await importHandlers();
    expect(
      (await quizRoute.PATCH(req({ title: "X" }), { params: Promise.resolve({ id: "not-a-uuid" }) })).status,
    ).toBe(404);
    expect(
      (await publish.POST(req(), { params: Promise.resolve({ id: "not-a-uuid" }) })).status,
    ).toBe(404);
  });
});

describe("Create quiz route", () => {
  it("creates a draft quiz with defaults", async () => {
    ownerContext();
    const { createQuiz } = await importHandlers();
    const res = await createQuiz.POST(req({ title: "My Quiz" }), {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.quiz.title).toBe("My Quiz");
    expect(body.quiz.mode).toBe("practice");
    expect(body.quiz.status).toBe("draft");
  });

  it("creates an assessment with a time limit", async () => {
    ownerContext();
    const { createQuiz } = await importHandlers();
    const res = await createQuiz.POST(
      req({ title: "Exam", mode: "assessment", timeLimitSec: 600 }),
      { params: Promise.resolve({ id: CLASS_B }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.quiz.mode).toBe("assessment");
    expect(body.quiz.time_limit_sec).toBe(600);
  });

  it("I-M11 create quiz sanitizes practice mode time limit to null", async () => {
    ownerContext();
    const { createQuiz } = await importHandlers();
    const res = await createQuiz.POST(
      req({ title: "Practice Quiz", mode: "practice", timeLimitSec: 1200 }),
      { params: Promise.resolve({ id: CLASS_B }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.quiz.mode).toBe("practice");
    expect(body.quiz.time_limit_sec).toBeNull();
  });

  it("I-M12 create quiz rejects out-of-bounds time limit > 7200", async () => {
    ownerContext();
    const { createQuiz } = await importHandlers();
    const res = await createQuiz.POST(
      req({ title: "Long Exam", mode: "assessment", timeLimitSec: 7201 }),
      { params: Promise.resolve({ id: CLASS_B }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("Quiz PATCH route (I-M1..I-M10)", () => {
  it("I-M1 PATCH title only on draft assessment preserves mode and time limit", async () => {
    const ctx = makeOwnerContext();
    ctx.client.tables["quizzes"][0] = {
      ...ctx.client.tables["quizzes"][0],
      mode: "assessment",
      time_limit_sec: 1800,
    };
    fakeHolder.current = ctx.client;
    const { quizRoute } = await importHandlers();

    const res = await quizRoute.PATCH(req({ title: "Updated Assessment" }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.title).toBe("Updated Assessment");
    expect(body.quiz.mode).toBe("assessment");
    expect(body.quiz.time_limit_sec).toBe(1800);
  });

  it("I-M2 PATCH mode: practice on timed assessment wipes time_limit_sec to null", async () => {
    const ctx = makeOwnerContext();
    ctx.client.tables["quizzes"][0] = {
      ...ctx.client.tables["quizzes"][0],
      mode: "assessment",
      time_limit_sec: 1800,
    };
    fakeHolder.current = ctx.client;
    const { quizRoute } = await importHandlers();

    const res = await quizRoute.PATCH(req({ mode: "practice" }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.mode).toBe("practice");
    expect(body.quiz.time_limit_sec).toBeNull();
  });

  it("I-M3 PATCH mode: practice with timeLimitSec returns 200 and forces null", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ mode: "practice", timeLimitSec: 600 }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.mode).toBe("practice");
    expect(body.quiz.time_limit_sec).toBeNull();
  });

  it("I-M4 PATCH mode: assessment with boundary 7200s returns 200", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ mode: "assessment", timeLimitSec: 7200 }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.mode).toBe("assessment");
    expect(body.quiz.time_limit_sec).toBe(7200);
  });

  it("I-M5 PATCH mode: assessment with timeLimitSec: null returns 200", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ mode: "assessment", timeLimitSec: null }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.mode).toBe("assessment");
    expect(body.quiz.time_limit_sec).toBeNull();
  });

  it("I-M6 PATCH timeLimitSec: 7201 -> 400 invalid_body", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ timeLimitSec: 7201 }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_body");
  });

  it("I-M7 PATCH timeLimitSec: 30.5 -> 400 invalid_body", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ timeLimitSec: 30.5 }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_body");
  });

  it("I-M8 maps DB trigger error quiz_not_draft_edit to 409", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    currentClient().updateError = "quiz_not_draft_edit: quiz is not draft";

    const res = await quizRoute.PATCH(req({ title: "Renamed" }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("quiz_not_draft");
  });

  it("I-M9 maps DB check constraint violation to 400", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    currentClient().updateError = 'check constraint "quizzes_practice_untimed"';

    const res = await quizRoute.PATCH(req({ mode: "practice" }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
  });

  it("I-M10 maps unknown DB error to 503 internal", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    currentClient().updateError = "connection timeout";

    const res = await quizRoute.PATCH(req({ title: "Renamed" }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("internal");
  });

  it("I-M13 rejects malformed JSON body with 400 invalid_json", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();

    const rawReq = new Request("http://localhost", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{ unclosed json",
    });

    const res = await quizRoute.PATCH(rawReq, {
      params: Promise.resolve({ id: QUIZ_C }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_json");
    expect(body.message).toBe("Request body must be valid JSON.");
  });

  it("I-M14 rejects cross-origin requests with 403 invalid_origin (CSRF protection)", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();

    const csrfReq = new Request("http://localhost/api/quizzes/" + QUIZ_C, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.evil.com",
      },
      body: JSON.stringify({ title: "CSRF Tampered" }),
    });

    const res = await quizRoute.PATCH(csrfReq, {
      params: Promise.resolve({ id: QUIZ_C }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("invalid_origin");
    expect(body.message).toBe("Cross-origin request rejected.");
  });

  it("I-M15 rejects empty PATCH payload {} with 400 invalid_body", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();

    const res = await quizRoute.PATCH(req({}), {
      params: Promise.resolve({ id: QUIZ_C }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_body");
    expect(body.message).toBe("No editable fields provided.");
  });

  it("I-M16 rejects timeLimitSec: 0 with 400 invalid_body and explicit message", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();

    const res = await quizRoute.PATCH(req({ timeLimitSec: 0 }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_body");
    expect(body.message).toMatch(/at least 1 second/i);
  });

  it("I-M17 accepts lower boundary timeLimitSec: 1 second and persists to DB", async () => {
    const ctx = makeOwnerContext();
    ctx.client.tables["quizzes"][0] = {
      ...ctx.client.tables["quizzes"][0],
      mode: "assessment",
      time_limit_sec: 1800,
    };
    fakeHolder.current = ctx.client;
    const { quizRoute } = await importHandlers();

    const res = await quizRoute.PATCH(req({ timeLimitSec: 1 }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.time_limit_sec).toBe(1);
    expect(ctx.client.tables["quizzes"][0].time_limit_sec).toBe(1);
  });

  it("I-M18 strips injected unauthorized fields (mass assignment / prototype pollution defense)", async () => {
    const ctx = makeOwnerContext();
    fakeHolder.current = ctx.client;
    const { quizRoute } = await importHandlers();

    const maliciousPayload = {
      title: "Legitimate Title",
      status: "live",
      created_by: "00000000-0000-4000-8000-000000000066",
      source_file_url: "https://evil.com/exploit.pdf",
    };

    const res = await quizRoute.PATCH(req(maliciousPayload), {
      params: Promise.resolve({ id: QUIZ_C }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.title).toBe("Legitimate Title");
    expect(body.quiz.status).toBe("draft");
    const storedQuiz = ctx.client.tables["quizzes"][0];
    expect(storedQuiz.title).toBe("Legitimate Title");
    expect(storedQuiz.status).toBe("draft");
    expect(storedQuiz.created_by).toBe("00000000-0000-4000-8000-00000000000a");
  });

  it("rejects editing a live quiz → 409", async () => {
    ownerContext({ quizStatus: "live" });
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ title: "X" }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(409);
  });

  it("rejects editing a closed quiz → 409", async () => {
    ownerContext({ quizStatus: "closed" });
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ title: "New Title" }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("quiz_not_draft");
  });

  it("QC-3: window-only PATCH on a LIVE quiz → 200 (bypass, persisted)", async () => {
    const ctx = ownerContext({ quizStatus: "live" });
    const { quizRoute } = await importHandlers();
    const opens = "2026-01-01T00:00:00.000Z";
    const closes = "2026-01-02T00:00:00.000Z";
    const res = await quizRoute.PATCH(req({ opensAt: opens, closesAt: closes }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.opens_at).toBe(opens);
    expect(body.quiz.closes_at).toBe(closes);
    expect(ctx.client.tables["quizzes"][0].opens_at).toBe(opens);
  });

  it("QC-3: window-only PATCH on a CLOSED quiz → 200 (harmless; unreachable by students)", async () => {
    ownerContext({ quizStatus: "closed" });
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ opensAt: null, closesAt: null }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.opens_at).toBeNull();
  });

  it("QC-3: title on a live quiz with windows mixed in → still 409 (field-scoped)", async () => {
    ownerContext({ quizStatus: "live" });
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(
      req({ title: "Sneak", opensAt: "2026-01-01T00:00:00.000Z", closesAt: "2026-01-02T00:00:00.000Z" }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("quiz_not_draft");
  });

  it("QC-3: inverted window → 400 (Zod cross-field)", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(
      req({ opensAt: "2026-01-02T00:00:00.000Z", closesAt: "2026-01-01T00:00:00.000Z" }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
  });

  // ── QC-4: retake config PATCH (live-quiz management, field-scoped bypass) ──
  it("QC-4: retake-only PATCH on a LIVE quiz → 200 (bypass, persisted)", async () => {
    const ctx = ownerContext({ quizStatus: "live" });
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ allowRetake: true, maxAttempts: 2 }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.allow_retake).toBe(true);
    expect(body.quiz.max_attempts).toBe(2);
    expect(ctx.client.tables["quizzes"][0].allow_retake).toBe(true);
    expect(ctx.client.tables["quizzes"][0].max_attempts).toBe(2);
  });

  it("QC-4: retake-only PATCH on a CLOSED quiz → 200 (harmless; unreachable by students)", async () => {
    ownerContext({ quizStatus: "closed" });
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ allowRetake: false }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).quiz.allow_retake).toBe(false);
  });

  it("QC-4: title on a live quiz with retake mixed in → still 409 (field-scoped)", async () => {
    ownerContext({ quizStatus: "live" });
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(
      req({ title: "Sneak", allowRetake: true }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("quiz_not_draft");
  });

  it("QC-4: maxAttempts out of DB range → 400 (Zod bound mirrors the CHECK)", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ maxAttempts: 4 }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
  });

  it("I-M19 accepts unicode, emojis, and 200-character titles on PATCH", async () => {
    const ctx = makeOwnerContext();
    fakeHolder.current = ctx.client;
    const { quizRoute } = await importHandlers();

    const unicodeTitle = "🧬 Midterm Exam: Cell Biology 🔬 (Spring 2026)";
    const res = await quizRoute.PATCH(req({ title: unicodeTitle }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.title).toBe(unicodeTitle);
    expect(ctx.client.tables["quizzes"][0].title).toBe(unicodeTitle);
  });

  it("I-M20 rejects cross-origin POST on class quiz creation (CSRF protection)", async () => {
    ownerContext();
    const { createQuiz } = await importHandlers();

    const csrfReq = new Request(`http://localhost/api/classes/${CLASS_B}/quizzes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.evil.com",
      },
      body: JSON.stringify({ title: "CSRF Quiz" }),
    });

    const res = await createQuiz.POST(csrfReq, {
      params: Promise.resolve({ id: CLASS_B }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("invalid_origin");
  });
});


// ─── QT-3: shuffleQuestions toggle plumbing ─────────────────────────────
describe("QT-3 shuffleQuestions plumbing", () => {
  it("QT3-1 create without the field defaults shuffle_questions to false", async () => {
    ownerContext();
    const { createQuiz } = await importHandlers();
    const res = await createQuiz.POST(req({ title: "Plain Quiz" }), {
      params: Promise.resolve({ id: CLASS_B }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).quiz.shuffle_questions).toBe(false);
  });

  it("QT3-2 create with shuffleQuestions: true persists it for BOTH modes", async () => {
    for (const mode of ["practice", "assessment"] as const) {
      ownerContext();
      const { createQuiz } = await importHandlers();
      const res = await createQuiz.POST(
        req({ title: `Shuffled ${mode}`, mode, shuffleQuestions: true }),
        { params: Promise.resolve({ id: CLASS_B }) },
      );
      expect(res.status).toBe(201);
      expect((await res.json()).quiz.shuffle_questions).toBe(true);
    }
  });

  it("QT3-3 PATCH on a draft quiz applies shuffleQuestions and echoes the column", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ shuffleQuestions: true }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).quiz.shuffle_questions).toBe(true);
    expect(currentClient().tables["quizzes"][0].shuffle_questions).toBe(true);
  });

  it("QT3-4 PATCH {shuffleQuestions} on a LIVE quiz → 409 (frozen metadata: hasNonWindowFields)", async () => {
    // Route-level gate — must fire BEFORE the DB (the fake cannot emulate the
    // 0034 trigger, so this test pins the route's classification).
    ownerContext({ quizStatus: "live" });
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ shuffleQuestions: true }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("quiz_not_draft");
  });

  it("QT3-5 shuffle-only PATCH on a draft is not rejected as an empty payload", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ shuffleQuestions: false }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).quiz.shuffle_questions).toBe(false);
  });
});


describe("QT-1 — multi-select question authoring", () => {
  it("QT1-11 POST multi question → 201 with correct_index null + set carried", async () => {
    ownerContext();
    const { questions } = await importHandlers();
    const res = await questions.POST(
      req({
        type: "multi_select",
        prompt: "Which are prime?",
        options: ["2", "3", "4", "5"],
        correctIndices: [0, 1, 3],
      }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.question.correct_index).toBeNull();
    expect(body.question.correct_indices).toEqual([0, 1, 3]);
  });

  it("QT1-12 PATCH question to multi → row carries the set and null scalar", async () => {
    ownerContext({
      questions: [
        { id: QUESTION_D, quiz_id: QUIZ_C, order_index: 0, type: "mcq", prompt: "Old", options: ["a", "b"], correct_index: 0, explanation: null },
      ],
    });
    const { questionRoute } = await importHandlers();
    const res = await questionRoute.PATCH(
      req({
        type: "multi_select",
        prompt: "Which are prime?",
        options: ["2", "3", "4", "5"],
        correctIndices: [0, 2],
      }),
      { params: Promise.resolve({ id: QUIZ_C, questionId: QUESTION_D }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.question.correct_index).toBeNull();
    expect(body.question.correct_indices).toEqual([0, 2]);
  });

  it("QT1-13 PATCH mixing scalar + set → 400 (strict one-of)", async () => {
    ownerContext({
      questions: [
        { id: QUESTION_D, quiz_id: QUIZ_C, order_index: 0, type: "mcq", prompt: "Old", options: ["a", "b"], correct_index: 0, explanation: null },
      ],
    });
    const { questionRoute } = await importHandlers();
    const res = await questionRoute.PATCH(
      req({
        type: "multi_select",
        prompt: "Which are prime?",
        options: ["2", "3"],
        correctIndex: 0,
        correctIndices: [0],
      }),
      { params: Promise.resolve({ id: QUIZ_C, questionId: QUESTION_D }) },
    );
    expect(res.status).toBe(400);
  });
});
