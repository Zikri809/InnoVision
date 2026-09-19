import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase, makeOwnerContext } from "./fake-supabase";

// Route modules import createClient from "@/lib/supabase/server". Mock it to
// return our fake so the REAL guards + handlers run against in-memory tables.
const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

// Service-role storage seam for the DELETE sweep (audit-3 C-F1/G-F3). The
// admin client is mocked so the owner-pinned cleanup path is exercised without
// a live SUPABASE_SERVICE_ROLE_KEY; `tryCreateAdminClient` mirrors the real
// degradation by returning null when the key is absent.
const adminState = vi.hoisted(() => ({
  removed: [] as Array<{ bucket: string; paths: string[] }>,
  hasKey: true,
}));

vi.mock("@/lib/supabase/admin", () => {
  const storage = {
    from: (bucket: string) => ({
      remove: async (paths: string[]) => {
        adminState.removed.push({ bucket, paths });
        return { data: paths.map((p) => ({ path: p })), error: null };
      },
      list: async () => ({ data: [], error: null }),
    }),
  };
  // Table access delegates to the SAME in-memory fake DB the user client uses:
  // 0054 revoked `questions` from `authenticated`, so the question PATCH/DELETE
  // routes now run their writes on the admin client, and a stub would make
  // every "row updated/deleted" assertion vacuous. Only `storage` stays a
  // boundary mock (a real external service, not a table).
  const client = {
    storage,
    from: (table: string) => {
      const db = fakeHolder.current;
      if (!db) throw new Error(`admin client .from(${table}) with no fake DB installed`);
      return db.from(table);
    },
  };
  return {
    createAdminClient: () => client,
    tryCreateAdminClient: () => (adminState.hasKey ? client : null),
  };
});

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
  adminState.removed = [];
  adminState.hasKey = true;
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

describe("C-F5 — nullable retake/shuffle fields (audit-3)", () => {
  it("a null-only PATCH is a typed 200, never a misleading 404", async () => {
    const ctx = ownerContext();
    ctx.client.tables["quizzes"][0] = {
      ...ctx.client.tables["quizzes"][0],
      mode: "assessment",
      allow_retake: true,
      max_attempts: 3,
    };
    const { quizRoute } = await importHandlers();

    const res = await quizRoute.PATCH(req({ maxAttempts: null }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    // null on a `not null default` column resets to the default (1).
    expect(ctx.client.tables["quizzes"][0].max_attempts).toBe(1);
  });

  it("an explicit null for allowRetake resets to false", async () => {
    const ctx = ownerContext();
    ctx.client.tables["quizzes"][0] = {
      ...ctx.client.tables["quizzes"][0],
      mode: "assessment",
      allow_retake: true,
    };
    const { quizRoute } = await importHandlers();

    const res = await quizRoute.PATCH(req({ allowRetake: null }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    expect(ctx.client.tables["quizzes"][0].allow_retake).toBe(false);
  });

  it("an empty body is still a typed 400 (no editable fields)", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.PATCH(req({}), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
  });

  it("maps the window-order DB constraint → 400", async () => {
    ownerContext();
    const { quizRoute } = await importHandlers();
    currentClient().updateError = "quizzes_window_order_check";
    const res = await quizRoute.PATCH(req({ opensAt: "2026-01-01T00:00:00.000Z" }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
  });
});

// ─── C-F2: the append_question cap now maps to a typed 422 ───────────────
describe("C-F2 — questions route cap + error mapping", () => {
  const VALID_Q = {
    type: "mcq",
    prompt: "What is 2+2?",
    options: ["1", "2", "3", "4"],
    correctIndex: 3,
  };

  /** Force the append_question RPC to return a seeded error. */
  function withAppendError(message: string) {
    const client = currentClient();
    client.rpc = (async () => ({ data: null, error: { message } })) as typeof client.rpc;
  }

  it("maps quiz_question_limit_exceeded → 422 (typed cap, not a 503)", async () => {
    ownerContext();
    const { questions } = await importHandlers();
    withAppendError("quiz_question_limit_exceeded");
    const res = await questions.POST(req(VALID_Q), { params: Promise.resolve({ id: QUIZ_C }) });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("quiz_question_limit_exceeded");
  });

  it("maps not_owner / quiz_not_found → 404", async () => {
    ownerContext();
    const { questions } = await importHandlers();
    withAppendError("not_owner");
    expect((await questions.POST(req(VALID_Q), { params: Promise.resolve({ id: QUIZ_C }) })).status).toBe(404);
    withAppendError("quiz_not_found");
    expect((await questions.POST(req(VALID_Q), { params: Promise.resolve({ id: QUIZ_C }) })).status).toBe(404);
  });

  it("maps questions_locked_quiz_not_draft → 409", async () => {
    ownerContext();
    const { questions } = await importHandlers();
    withAppendError("questions_locked_quiz_not_draft");
    const res = await questions.POST(req(VALID_Q), { params: Promise.resolve({ id: QUIZ_C }) });
    expect(res.status).toBe(409);
  });

  it("maps check-constraint drift → 400 and unknown → 503", async () => {
    ownerContext();
    const { questions } = await importHandlers();
    withAppendError("violates check constraint");
    expect((await questions.POST(req(VALID_Q), { params: Promise.resolve({ id: QUIZ_C }) })).status).toBe(400);
    withAppendError("totally_unknown");
    expect((await questions.POST(req(VALID_Q), { params: Promise.resolve({ id: QUIZ_C }) })).status).toBe(503);
  });

  it("non-uuid id → 404; non-draft → 409; cross-origin → 403; rate limit → 429; invalid body → 400", async () => {
    const ctx = ownerContext();
    const { questions } = await importHandlers();
    expect((await questions.POST(req(VALID_Q), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);

    ownerContext({ quizStatus: "live" });
    expect((await questions.POST(req(VALID_Q), { params: Promise.resolve({ id: QUIZ_C }) })).status).toBe(409);

    ownerContext();
    const cross = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify(VALID_Q),
    });
    expect((await questions.POST(cross, { params: Promise.resolve({ id: QUIZ_C }) })).status).toBe(403);

    ownerContext();
    // Both helpers come from the same dynamic import — the earlier edit only
    // destructured _seedRateLimit, leaving _resetRateLimiter undefined below.
    const { _seedRateLimit, _resetRateLimiter } = await import("@/lib/classes/rate-limit");
    // audit-4 M7: the AUTHOR budget is 30/min — seed exactly at the limit so
    // this assertion fails if the constant drifts (a seed above the limit
    // would stay green at any value ≤ it).
    _seedRateLimit(`quiz-author:${ctx.ownerId}`, 30);
    expect((await questions.POST(req(VALID_Q), { params: Promise.resolve({ id: QUIZ_C }) })).status).toBe(429);

    _resetRateLimiter();
    ownerContext();
    expect(
      (await questions.POST(req({ ...VALID_Q, correctIndex: 9 }), { params: Promise.resolve({ id: QUIZ_C }) })).status,
    ).toBe(400);
  });
});

// ─── audit-3 C-F1 / P1-15: quiz DELETE storage sweep ─────────────────────
describe("quiz DELETE — session guard + owner-pinned storage sweep", () => {
  it("deletes a session-free quiz and sweeps owned image + quiz-source objects", async () => {
    const ctx = ownerContext();
    const owner = ctx.client.tables["quizzes"]![0].created_by as string;
    const img = `${owner}/22222222-2222-4222-8222-222222222222.png`;
    const src = `${owner}/${QUIZ_C}/33333333-3333-4333-8333-333333333333-notes.pdf`;
    ctx.client.seedQuestion({
      id: QUESTION_D,
      quiz_id: QUIZ_C,
      order_index: 0,
      image_path: img,
    });
    ctx.client.tables["quizzes"]![0].source_file_url = src;
    ctx.client.tables["quizzes"]![0].sources = [{ storage_path: src }];

    const { quizRoute } = await importHandlers();
    const res = await quizRoute.DELETE(req(), { params: Promise.resolve({ id: QUIZ_C }) });
    expect(res.status).toBe(200);
    const buckets = adminState.removed.map((r) => r.bucket);
    expect(buckets).toContain("question-images");
    expect(buckets).toContain("quiz-sources");
    expect(adminState.removed.flatMap((r) => r.paths)).toContain(img);
    expect(adminState.removed.flatMap((r) => r.paths)).toContain(src);
    expect(ctx.client.tables["quizzes"]).toHaveLength(0);
  });

  it("refuses malformed image + quiz-source paths (skip + log, never cross-tenant)", async () => {
    const ctx = ownerContext();
    ctx.client.seedQuestion({
      id: QUESTION_D,
      quiz_id: QUIZ_C,
      order_index: 0,
      image_path: "../other-tenant/evil.png",
    });
    ctx.client.tables["quizzes"]![0].source_file_url = "not-a-valid-path";
    ctx.client.tables["quizzes"]![0].sources = [{ storage_path: "/etc/passwd" }];

    const { quizRoute } = await importHandlers();
    const res = await quizRoute.DELETE(req(), { params: Promise.resolve({ id: QUIZ_C }) });
    expect(res.status).toBe(200);
    // Nothing reached the service-role remove().
    expect(adminState.removed).toEqual([]);
  });

  it("degrades gracefully when the service-role key is unset (no 500)", async () => {
    const ctx = ownerContext();
    const owner = ctx.client.tables["quizzes"]![0].created_by as string;
    ctx.client.seedQuestion({
      id: QUESTION_D,
      quiz_id: QUIZ_C,
      order_index: 0,
      image_path: `${owner}/44444444-4444-4444-8444-444444444444.png`,
    });
    adminState.hasKey = false;
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.DELETE(req(), { params: Promise.resolve({ id: QUIZ_C }) });
    expect(res.status).toBe(200);
    expect(adminState.removed).toEqual([]);
  });

  it("blocks deletion when the quiz has student attempts → 409", async () => {
    const ctx = ownerContext();
    ctx.client.seedSession({ id: "s1", quiz_id: QUIZ_C, student_id: "stu" });
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.DELETE(req(), { params: Promise.resolve({ id: QUIZ_C }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("quiz_has_sessions");
  });

  it("maps a session-count read error → 503", async () => {
    const ctx = ownerContext();
    ctx.client.countError = "count boom";
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.DELETE(req(), { params: Promise.resolve({ id: QUIZ_C }) });
    expect(res.status).toBe(503);
  });

  it("maps a delete write failure → 503", async () => {
    const ctx = ownerContext();
    ctx.client.updateError = "delete boom";
    const { quizRoute } = await importHandlers();
    const res = await quizRoute.DELETE(req(), { params: Promise.resolve({ id: QUIZ_C }) });
    expect(res.status).toBe(503);
  });

  it("non-uuid → 404; cross-origin → 403; rate limit → 429", async () => {
    const ctx = ownerContext();
    const { quizRoute } = await importHandlers();
    expect((await quizRoute.DELETE(req(), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);

    const cross = new Request("http://localhost", {
      method: "DELETE",
      headers: { origin: "https://evil.example" },
    });
    expect((await quizRoute.DELETE(cross, { params: Promise.resolve({ id: QUIZ_C }) })).status).toBe(403);

    const { _seedRateLimit } = await import("@/lib/classes/rate-limit");
    _seedRateLimit(`quiz-mutate:${ctx.ownerId}`, 60);
    expect((await quizRoute.DELETE(req(), { params: Promise.resolve({ id: QUIZ_C }) })).status).toBe(429);
  });
});

// ─── question PATCH/DELETE error arms + image sweep ──────────────────────
describe("question route — PATCH/DELETE error mapping + image sweep", () => {
  const VALID_Q = {
    type: "mcq",
    prompt: "What is 2+2?",
    options: ["1", "2", "3", "4"],
    correctIndex: 3,
  };
  const params = { params: Promise.resolve({ id: QUIZ_C, questionId: QUESTION_D }) };

  function seedQuestion(extra: Record<string, unknown> = {}) {
    const ctx = ownerContext({
      questions: [
        { id: QUESTION_D, quiz_id: QUIZ_C, order_index: 0, type: "mcq", prompt: "Old", options: ["a", "b"], correct_index: 0, ...extra },
      ],
    });
    return ctx;
  }

  it("PATCH non-uuid → 404; cross-origin → 403; rate limit → 429", async () => {
    const ctx = seedQuestion();
    const { questionRoute } = await importHandlers();
    expect(
      (await questionRoute.PATCH(req(VALID_Q), { params: Promise.resolve({ id: "nope", questionId: QUESTION_D }) })).status,
    ).toBe(404);

    const cross = new Request("http://localhost", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify(VALID_Q),
    });
    expect((await questionRoute.PATCH(cross, params)).status).toBe(403);

    const { _seedRateLimit } = await import("@/lib/classes/rate-limit");
    _seedRateLimit(`quiz-author:${ctx.ownerId}`, 30);
    expect((await questionRoute.PATCH(req(VALID_Q), params)).status).toBe(429);
  });

  it("PATCH lookup read error → 503; missing question → 404", async () => {
    const ctx = seedQuestion();
    const { questionRoute } = await importHandlers();
    ctx.client.selectError = "lookup boom";
    ctx.client.selectErrorTable = "questions";
    expect((await questionRoute.PATCH(req(VALID_Q), params)).status).toBe(503);

    ctx.client.selectError = null;
    ctx.client.selectErrorTable = null;
    expect(
      (await questionRoute.PATCH(req(VALID_Q), { params: Promise.resolve({ id: QUIZ_C, questionId: crypto.randomUUID() }) })).status,
    ).toBe(404);
  });

  it("PATCH maps update trigger/constraint/unknown errors", async () => {
    const ctx = seedQuestion();
    const { questionRoute } = await importHandlers();
    ctx.client.updateError = "questions_locked_quiz_not_draft";
    expect((await questionRoute.PATCH(req(VALID_Q), params)).status).toBe(409);
    ctx.client.updateError = "violates check constraint";
    expect((await questionRoute.PATCH(req(VALID_Q), params)).status).toBe(400);
    ctx.client.updateError = "connection reset";
    expect((await questionRoute.PATCH(req(VALID_Q), params)).status).toBe(503);
  });

  it("DELETE sweeps an owned image and removes the row", async () => {
    const ctx = seedQuestion({ image_path: `${CLASS_B.replace(/b$/, "a")}/55555555-5555-4555-8555-555555555555.png` });
    const owner = ctx.client.tables["quizzes"]![0].created_by as string;
    const img = `${owner}/55555555-5555-4555-8555-555555555555.png`;
    ctx.client.tables["questions"]![0].image_path = img;
    const { questionRoute } = await importHandlers();
    const res = await questionRoute.DELETE(req(), params);
    expect(res.status).toBe(200);
    expect(adminState.removed.flatMap((r) => r.paths)).toContain(img);
  });

  it("DELETE skips a malformed image path (skip + log)", async () => {
    const ctx = seedQuestion();
    ctx.client.tables["questions"]![0].image_path = "../evil.png";
    const { questionRoute } = await importHandlers();
    const res = await questionRoute.DELETE(req(), params);
    expect(res.status).toBe(200);
    expect(adminState.removed).toEqual([]);
  });

  it("DELETE maps trigger → 409, write failure → 503, missing row → 404, non-uuid → 404, cross-origin → 403, rate limit → 429", async () => {
    const ctx = seedQuestion();
    const { questionRoute } = await importHandlers();

    ctx.client.updateError = "questions_locked_quiz_not_draft";
    expect((await questionRoute.DELETE(req(), params)).status).toBe(409);

    ctx.client.updateError = "delete boom";
    expect((await questionRoute.DELETE(req(), params)).status).toBe(503);

    ctx.client.updateError = null;
    expect(
      (await questionRoute.DELETE(req(), { params: Promise.resolve({ id: QUIZ_C, questionId: crypto.randomUUID() }) })).status,
    ).toBe(404);

    expect(
      (await questionRoute.DELETE(req(), { params: Promise.resolve({ id: "nope", questionId: QUESTION_D }) })).status,
    ).toBe(404);

    const cross = new Request("http://localhost", { method: "DELETE", headers: { origin: "https://evil.example" } });
    expect((await questionRoute.DELETE(cross, params)).status).toBe(403);

    const { _seedRateLimit } = await import("@/lib/classes/rate-limit");
    _seedRateLimit(`quiz-author:${ctx.ownerId}`, 30);
    expect((await questionRoute.DELETE(req(), params)).status).toBe(429);
  });
});
