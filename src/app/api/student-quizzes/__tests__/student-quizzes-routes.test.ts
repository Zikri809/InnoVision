import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  StudentFakeSupabase,
  makeStudentQuizContext,
} from "./fake-student-supabase";
import { _resetRateLimiter } from "@/lib/classes/rate-limit";

// Same seam as the lecturer route tests: mock createClient so the REAL
// guards + handlers run against in-memory tables.
const fakeHolder: { current: StudentFakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

async function importAll() {
  const list = await import("@/app/api/student-quizzes/route");
  const quizRoute = await import("@/app/api/student-quizzes/[id]/route");
  const questions = await import("@/app/api/student-quizzes/[id]/questions/route");
  const questionRoute = await import(
    "@/app/api/student-quizzes/[id]/questions/[questionId]/route"
  );
  const reorder = await import("@/app/api/student-quizzes/[id]/reorder/route");
  const shared = await import("@/app/api/student-quizzes/shared/[code]/route");
  const answer = await import("@/app/api/student-quizzes/shared/answer/route");
  return { list, quizRoute, questions, questionRoute, reorder, shared, answer };
}

const OTHER_STUDENT = "00000000-0000-4000-8000-0000000000ff";
const LECTURER = "00000000-0000-4000-8000-0000000000ee";

function req(body?: unknown, init?: RequestInit): Request {
  return new Request("http://localhost/api/student-quizzes", {
    method: init?.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Install ctx + switch the session user (same client, attacker vantage). */
function asUser(client: StudentFakeSupabase, id: string, role: "student" | "lecturer") {
  client.setUser(id, role);
}

beforeEach(() => {
  vi.resetModules();
  _resetRateLimiter();
  fakeHolder.current = undefined;
});

describe("authoring routes — creator authz", () => {
  it("GET list returns only own quizzes with counts", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    // A second quiz owned by someone else exists in the same store:
    ctx.client.seedStudentQuiz({
      id: "00000000-0000-4000-8000-0000000000e5",
      created_by: OTHER_STUDENT,
      title: "Not mine",
    });

    const { list } = await importAll();
    const res = await list.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quizzes).toHaveLength(1);
    expect(body.quizzes[0].question_count).toBe(2);
    expect(body.quizzes[0].title).toBe("My Practice Quiz");
  });

  it("POST create → 201; cap error maps to 429", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    const { list } = await importAll();

    const ok = await list.POST(req({ title: "Fresh" }));
    expect(ok.status).toBe(201);

    // Simulate the DB-side cap trigger via the write-error seam.
    ctx.client.updateError = "quiz_cap_reached";
    const capped = await list.POST(req({ title: "One too many" }));
    expect(capped.status).toBe(429);
  });

  it("POST create enforces the per-user rate limit (5/hour) with 429", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    const { list } = await importAll();

    for (let i = 0; i < 5; i++) {
      const res = await list.POST(req({ title: `Q${i}` }));
      expect(res.status).toBe(201);
    }
    const sixth = await list.POST(req({ title: "Q6" }));
    expect(sixth.status).toBe(429);
  });

  it("PATCH share mints a code once and is idempotent; unshare nulls it; regenerate requires sharing", async () => {
    const ctx = makeStudentQuizContext({ sharedCode: null });
    fakeHolder.current = ctx.client;
    const { quizRoute } = await importAll();
    const params = { params: Promise.resolve({ id: ctx.quizId }) };

    const shared = await quizRoute.PATCH(req({ action: "share" }), params);
    expect(shared.status).toBe(200);
    const code = (await shared.json()).quiz.share_code;
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);

    const again = await quizRoute.PATCH(req({ action: "share" }), params);
    expect((await again.json()).quiz.share_code).toBe(code); // stable

    const unshared = await quizRoute.PATCH(req({ action: "unshare" }), params);
    expect((await unshared.json()).quiz.share_code).toBeNull();

    const regenUnshared = await quizRoute.PATCH(req({ action: "regenerate" }), params);
    expect(regenUnshared.status).toBe(400);
  });

  it("regenerate rotates a LIVE code to a fresh alphabet code", async () => {
    const ctx = makeStudentQuizContext({ sharedCode: "MABCDEFGH" }); // alphabet-only live code
    fakeHolder.current = ctx.client;
    const { quizRoute } = await importAll();
    const params = { params: Promise.resolve({ id: ctx.quizId }) };

    const res = await quizRoute.PATCH(req({ action: "regenerate" }), params);
    expect(res.status).toBe(200);
    const next = (await res.json()).quiz.share_code;
    expect(next).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
  });

  it("persistent code_collision exhausts retries into a typed 503 (not 404/500)", async () => {
    const ctx = makeStudentQuizContext({ sharedCode: null });
    fakeHolder.current = ctx.client;
    const { quizRoute } = await importAll();

    ctx.client.rpcResult = { data: null, error: { message: "code_collision" } };
    const res = await quizRoute.PATCH(req({ action: "share" }), {
      params: Promise.resolve({ id: ctx.quizId }),
    });
    expect(res.status).toBe(503);
  });

  it("PATCH title/description works; empty update rejected", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    const { quizRoute } = await importAll();
    const params = { params: Promise.resolve({ id: ctx.quizId }) };

    const ok = await quizRoute.PATCH(req({ title: "Renamed" }), params);
    expect(ok.status).toBe(200);
    expect((await ok.json()).quiz.title).toBe("Renamed");

    const empty = await quizRoute.PATCH(req({}), params);
    expect(empty.status).toBe(400);
  });

  it("foreign student gets clean no-oracle denials on every authoring route", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    asUser(ctx.client, OTHER_STUDENT, "student");
    const { quizRoute, questions, questionRoute, reorder } = await importAll();
    const p = { params: Promise.resolve({ id: ctx.quizId }) };

    // Role check passes (they ARE a student); the creator filter folds
    // "not yours" into the same 404 as "does not exist".
    expect((await quizRoute.PATCH(req({ title: "X" }), p)).status).toBe(404);
    expect((await quizRoute.DELETE(req(), p)).status).toBe(404);
    expect(
      (await questions.POST(req({ type: "mcq", prompt: "?", options: ["a", "b"], correctIndex: 0 }), p))
        .status,
    ).toBe(404);
    expect(
      (await reorder.POST(req({ questionIds: [ctx.q1, ctx.q2] }), p)).status,
    ).toBe(404);
    expect(
      (await questionRoute.DELETE(req(), {
        params: Promise.resolve({ id: ctx.quizId, questionId: ctx.q1 }),
      })).status,
    ).toBe(404);
  });
});

describe("questions routes", () => {
  const validQuestion = {
    type: "mcq",
    prompt: "New question?",
    options: ["a", "b", "c"],
    correctIndex: 2,
  };

  it("append → 201 with server-assigned order_index", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    const { questions } = await importAll();
    const res = await questions.POST(req(validQuestion), {
      params: Promise.resolve({ id: ctx.quizId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.question.order_index).toBe(2);
    // Answer key round-trips to the CREATOR only.
    expect(body.question.correct_index).toBe(2);
  });

  it("append maps cap → 429 and duplicate options → 400", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    const { questions } = await importAll();
    const p = { params: Promise.resolve({ id: ctx.quizId }) };

    // Route-mapping probe: seed the RPC error seam with the DB trigger's key.
    ctx.client.rpcResult = { data: null, error: { message: "question_cap_reached" } };
    expect((await questions.POST(req(validQuestion), p)).status).toBe(429);
    ctx.client.rpcResult = { data: null, error: null };

    // Duplicate options: Zod rejects case-insensitive duplicates BEFORE any
    // DB round trip (mirrors the lecturer builder contract).
    const dup = await questions.POST(
      req({ type: "mcq", prompt: "?", options: ["same", "Same"], correctIndex: 0 }),
      p,
    );
    expect(dup.status).toBe(400);
  });

  it("PATCH question edits; DELETE missing question → 404", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    const { questionRoute } = await importAll();
    const p = { params: Promise.resolve({ id: ctx.quizId, questionId: ctx.q1 }) };

    const edited = await questionRoute.PATCH(req(validQuestion), p);
    expect(edited.status).toBe(200);
    expect((await edited.json()).question.prompt).toBe("New question?");

    const gone = await questionRoute.PATCH(req(validQuestion), {
      params: Promise.resolve({ id: ctx.quizId, questionId: crypto.randomUUID() }),
    });
    expect(gone.status).toBe(404);
  });

  it("PATCH: malformed UUIDs → 404; invalid JSON → 400", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    const { questionRoute } = await importAll();
    const p = { params: Promise.resolve({ id: ctx.quizId, questionId: ctx.q1 }) };

    expect(
      (await questionRoute.PATCH(req(validQuestion), {
        params: Promise.resolve({ id: "not-a-uuid", questionId: ctx.q1 }),
      })).status,
    ).toBe(404);

    const badJson = new Request("http://localhost/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect((await questionRoute.PATCH(badJson, p)).status).toBe(400);
  });

  it("PATCH maps DB constraint errors → 400 and unknown DB failures → 503", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    const { questionRoute } = await importAll();
    const p = { params: Promise.resolve({ id: ctx.quizId, questionId: ctx.q1 }) };

    ctx.client.updateError = "duplicate_options";
    expect((await questionRoute.PATCH(req(validQuestion), p)).status).toBe(400);

    ctx.client.updateError = "explanation_too_long";
    expect((await questionRoute.PATCH(req(validQuestion), p)).status).toBe(400);

    ctx.client.updateError = "connection reset by peer";
    expect((await questionRoute.PATCH(req(validQuestion), p)).status).toBe(503);
  });

  it("DELETE removes one of my questions; absent id → 404; DB failure → 503", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    const { questionRoute } = await importAll();

    // Absent uuid under MY quiz → the update/delete matched nothing → 404.
    const absent = await questionRoute.DELETE(req(), {
      params: Promise.resolve({ id: ctx.quizId, questionId: crypto.randomUUID() }),
    });
    expect(absent.status).toBe(404);

    const ok = await questionRoute.DELETE(req(), {
      params: Promise.resolve({ id: ctx.quizId, questionId: ctx.q1 }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);
    expect(
      (ctx.client.tables["student_quiz_questions"] ?? []).find((q) => q.id === ctx.q1),
    ).toBeUndefined();

    ctx.client.updateError = "connection reset by peer";
    const failed = await questionRoute.DELETE(req(), {
      params: Promise.resolve({ id: ctx.quizId, questionId: ctx.q2 }),
    });
    expect(failed.status).toBe(503);
  });

  it("reorder validates exact id set; mismatched set → 400 (lecturer-surface parity)", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    const { reorder } = await importAll();
    const p = { params: Promise.resolve({ id: ctx.quizId }) };

    const ok = await reorder.POST(req({ questionIds: [ctx.q2, ctx.q1] }), p);
    expect(ok.status).toBe(200);

    // A stale/partial id set is a client payload bug, not a missing resource —
    // same mapping as quizzes/[id]/reorder: id_count_mismatch → 400.
    const bad = await reorder.POST(req({ questionIds: [ctx.q1] }), p);
    expect(bad.status).toBe(400);
  });
});

describe("play routes — any authenticated user (D-SQ6)", () => {
  const CODE = "ABCDEFGHJM"; // alphabet-only (no I/1/L/0/O)

  function sharedContext() {
    return makeStudentQuizContext({ sharedCode: CODE });
  }

  it("resolve requires authentication", async () => {
    const ctx = sharedContext();
    ctx.client.user = null;
    fakeHolder.current = ctx.client;
    const { shared } = await importAll();
    const res = await shared.GET(new Request(`http://localhost/s/${CODE}`), {
      params: Promise.resolve({ code: CODE }),
    });
    expect(res.status).toBe(401);
  });

  it("malformed code → 400 BEFORE any DB touch; unknown code → uniform 404", async () => {
    const ctx = sharedContext();
    fakeHolder.current = ctx.client;
    const { shared } = await importAll();

    expect(
      (await shared.GET(new Request("http://localhost/x"), {
        params: Promise.resolve({ code: "nope!!!" }),
      })).status,
    ).toBe(400);
    expect(
      (
        await shared.GET(new Request("http://localhost/x"), {
          params: Promise.resolve({ code: "ZYXWVUTSRQ" }),
        })
      ).status,
    ).toBe(404);
  });

  it("LECTURER can resolve a shared link and NEVER sees created_by or answers", async () => {
    const ctx = sharedContext();
    fakeHolder.current = ctx.client;
    asUser(ctx.client, LECTURER, "lecturer");

    const { shared } = await importAll();
    const res = await shared.GET(new Request(`http://localhost/s/${CODE.toLowerCase()}`), {
      params: Promise.resolve({ code: CODE.toLowerCase() }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.creator_first_name).toBeDefined();
    expect(JSON.stringify(body)).not.toContain(ctx.ownerId); // UUID stripped
    expect(JSON.stringify(body)).not.toContain("correct_index");
    expect(body.questions).toHaveLength(2);
  });

  it("revoked (unshared) code resolves to the same 404 as unknown", async () => {
    const ctx = sharedContext();
    ctx.client.tables["student_quizzes"][0].share_code = null; // unshared
    fakeHolder.current = ctx.client;
    const { shared } = await importAll();
    const res = await shared.GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ code: CODE }),
    });
    expect(res.status).toBe(404);
  });

  it("answer: unauthenticated → 401; NULL selection schema-rejected → 400", async () => {
    const ctx = sharedContext();
    fakeHolder.current = ctx.client;
    const { answer } = await importAll();

    ctx.client.user = null;
    expect(
      (await answer.POST(req({ questionId: ctx.q1, selectedIndex: 1 })))
        .status,
    ).toBe(401);

    ctx.client.setUser(LECTURER, "lecturer");
    const nullSel = await answer.POST(req({ questionId: ctx.q1 }));
    expect(nullSel.status).toBe(400);
  });

  it("answer: player grading reveals per-question feedback; foreign/unshared folds into one 404", async () => {
    const ctx = sharedContext();
    fakeHolder.current = ctx.client;
    asUser(ctx.client, OTHER_STUDENT, "student");
    const { answer } = await importAll();

    const right = await answer.POST(req({ questionId: ctx.q1, selectedIndex: 1 }));
    expect(right.status).toBe(200);
    const graded = await right.json();
    expect(graded.is_correct).toBe(true);
    expect(graded.explanation).toBe("Basic addition.");

    const wrong = await answer.POST(req({ questionId: ctx.q1, selectedIndex: 0 }));
    expect((await wrong.json()).is_correct).toBe(false);

    // Out-of-bounds index folds into unavailable.
    expect(
      (await answer.POST(req({ questionId: ctx.q1, selectedIndex: 99 })))
        .status,
    ).toBe(404);
  });

  it("answer: creator can grade their OWN unshared quiz (self-play)", async () => {
    const ctx = makeStudentQuizContext({ sharedCode: null }); // not shared
    fakeHolder.current = ctx.client;
    const { answer } = await importAll();

    const res = await answer.POST(req({ questionId: ctx.q1, selectedIndex: 1 }));
    expect(res.status).toBe(200);
    expect((await res.json()).is_correct).toBe(true);
  });

  it("answer rate limit (60/min) trips on the 61st call", async () => {
    const ctx = sharedContext();
    fakeHolder.current = ctx.client;
    asUser(ctx.client, OTHER_STUDENT, "student");
    const { answer } = await importAll();

    let last = 200;
    for (let i = 0; i < 61; i++) {
      last = (await answer.POST(req({ questionId: ctx.q1, selectedIndex: 1 }))).status;
    }
    expect(last).toBe(429);
  });
});


describe("QT-1 — student domain rejects multi_select (v1 scope)", () => {
  it("QT1-9 POST question with a multi body → 400 (not an RPC 500)", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    const { questions } = await importAll();
    const p = { params: Promise.resolve({ id: ctx.quizId }) };
    const res = await questions.POST(
      req({
        type: "multi_select",
        prompt: "Which are prime?",
        options: ["2", "3", "4", "5"],
        correctIndices: [0, 1, 3],
      }),
      p,
    );
    expect(res.status).toBe(400);
  });

  it("QT1-10 PATCH question with a multi body → 400", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    const { questionRoute } = await importAll();
    const res = await questionRoute.PATCH(
      req({
        type: "multi_select",
        prompt: "Which are prime?",
        options: ["2", "3", "4", "5"],
        correctIndices: [0, 1],
      }),
      { params: Promise.resolve({ id: ctx.quizId, questionId: ctx.q1 }) },
    );
    expect(res.status).toBe(400);
  });
});
