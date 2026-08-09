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
});

describe("Quiz PATCH route", () => {
  it("renames a draft quiz", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ title: "Renamed" }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.title).toBe("Renamed");
  });

  it("rejects editing a live quiz → 409", async () => {
    ownerContext({ quizStatus: "live" });
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({ title: "X" }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(409);
  });

  it("H2 — title-only PATCH does NOT downgrade an assessment quiz to practice", async () => {
    // Seed an assessment quiz, then rename it. The mode must stay assessment.
    const ctx = makeOwnerContext();
    ctx.client.tables["quizzes"][0] = {
      ...ctx.client.tables["quizzes"][0],
      mode: "assessment",
      time_limit_sec: 600,
    };
    fakeHolder.current = ctx.client;
    const { quizRoute } = await importHandlers();

    const res = await quizRoute.PATCH(req({ title: "Renamed" }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.title).toBe("Renamed");
    expect(body.quiz.mode).toBe("assessment");
    expect(body.quiz.time_limit_sec).toBe(600);

    // The stored row was not touched for mode/time_limit.
    const stored = ctx.client.tables["quizzes"][0];
    expect(stored.mode).toBe("assessment");
    expect(stored.time_limit_sec).toBe(600);
  });

  it("H2 — empty PATCH body returns 400 (no implicit mode change)", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({}), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_body");
  });
});
