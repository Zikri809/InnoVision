import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase, makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { _resetRateLimiter } from "@/lib/classes/rate-limit";
import * as importRoute from "@/app/api/quizzes/[id]/import-questions/route";

const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

const QUIZ = "00000000-0000-4000-8000-00000000000c";
const LECTURER_ID = "00000000-0000-4000-8000-00000000000a";
const CLASS_B = "00000000-0000-4000-8000-0000000000b0";

const VALID_ROW = {
  type: "mcq",
  prompt: "What is 2+2?",
  options: ["3", "4"],
  correctIndex: 1,
};

function req(body: unknown, opts?: { origin?: string }): Request {
  return new Request("http://localhost/api/import-questions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts?.origin ? { origin: opts.origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

function ownerContext(opts?: { status?: "draft" | "live" | "closed" }) {
  const ctx = makeOwnerContext({ quizStatus: opts?.status ?? "draft" });
  fakeHolder.current = ctx.client;
  return ctx;
}

beforeEach(() => {
  fakeHolder.current = undefined;
  _resetRateLimiter();
});

describe("POST /api/quizzes/[id]/import-questions", () => {
  it("U-AP1-R1 appends valid rows → 200 {added} with snake_case jsonb", async () => {
    const ctx = ownerContext();
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).added).toBe(1);
    const rows = ctx.client.tables["questions"] ?? [];
    expect(rows).toHaveLength(1);
    // camelCase wire → snake_case jsonb (the load-bearing mapping).
    expect(rows[0]).toMatchObject({
      quiz_id: QUIZ,
      order_index: 0,
      type: "mcq",
      prompt: "What is 2+2?",
      correct_index: 1,
    });
  });

  it("U-AP1-R2 NULL provenance args leave title/source fields byte-identical (0025 append semantics)", async () => {
    const ctx = ownerContext();
    const quiz = ctx.client.tables["quizzes"]![0];
    quiz.title = "Prepared Quiz";
    quiz.source_text = "existing source";
    quiz.source_file_url = "https://example.org/file.pdf";
    quiz.sources = [{ id: "seed" }];

    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(200);
    expect(quiz.title).toBe("Prepared Quiz");
    expect(quiz.source_text).toBe("existing source");
    expect(quiz.source_file_url).toBe("https://example.org/file.pdf");
    expect(quiz.sources).toEqual([{ id: "seed" }]);
  });

  it("U-AP1-R3 appends after existing questions with continuous order_index", async () => {
    const ctx = ownerContext();
    ctx.client.seedQuestion({
      id: "00000000-0000-4000-8000-00000000000d",
      quiz_id: QUIZ,
      order_index: 0,
      type: "true_false",
      prompt: "Seed?",
      options: ["True", "False"],
      correct_index: 0,
      image_path: null,
    });
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(200);
    expect((ctx.client.tables["questions"] ?? [])[1].order_index).toBe(1);
  });

  it("U-AP1-R4 404 for a non-uuid id", async () => {
    ownerContext();
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("U-AP1-R5 404 for a non-owner lecturer (no oracle)", async () => {
    const ctx = ownerContext();
    ctx.client.seedClass(CLASS_B, "00000000-0000-4000-8000-0000000000ee");
    ctx.client.setUser("00000000-0000-4000-8000-0000000000ee", "lecturer");
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(404);
  });

  it("U-AP1-R6 401 for unauthenticated callers", async () => {
    const ctx = ownerContext();
    ctx.client.user = null;
    ctx.client.profileRole = null;
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(401);
  });

  it("U-AP1-R7 409 for a non-draft quiz", async () => {
    ownerContext({ status: "live" });
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(409);
  });

  it("U-AP1-R8 403 for cross-origin requests (CSRF)", async () => {
    ownerContext();
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }, { origin: "https://evil.example" }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("invalid_origin");
  });

  it("U-AP1-R9 429 when the import budget is exhausted", async () => {
    const { _seedRateLimit } = await import("@/lib/classes/rate-limit");
    ownerContext();
    _seedRateLimit(`quiz-import:${LECTURER_ID}`, 120);
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(429);
  });

  it("U-AP1-R10 400 when rows exceed remaining capacity (head-count pre-check)", async () => {
    const ctx = ownerContext();
    for (let i = 0; i < 29; i++) {
      ctx.client.seedQuestion({
        id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
        quiz_id: QUIZ,
        order_index: i,
        type: "true_false",
        prompt: `Q${i}?`,
        options: ["True", "False"],
        correct_index: 0,
        image_path: null,
      });
    }
    const res = await importRoute.POST(req({ questions: [VALID_ROW, VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("Only 1 more");
  });

  it("U-AP1-R11 422 when the quiz is already at the 30 cap", async () => {
    const ctx = ownerContext();
    for (let i = 0; i < 30; i++) {
      ctx.client.seedQuestion({
        id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
        quiz_id: QUIZ,
        order_index: i,
        type: "true_false",
        prompt: `Q${i}?`,
        options: ["True", "False"],
        correct_index: 0,
        image_path: null,
      });
    }
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("quiz_question_limit_exceeded");
  });

  it("U-AP1-R12 maps the RPC cap backstop → 422", async () => {
    const ctx = ownerContext();
    ctx.client.rpcError = { message: "quiz_question_limit_exceeded" };
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("quiz_question_limit_exceeded");
  });

  it("U-AP1-R13 400 for an invalid payload (empty batch)", async () => {
    ownerContext();
    const res = await importRoute.POST(req({ questions: [] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(400);
  });

  it("U-AP1-R14 400 for an invalid question row (duplicate options)", async () => {
    ownerContext();
    const res = await importRoute.POST(
      req({ questions: [{ ...VALID_ROW, options: ["same", "same"] }] }),
      { params: Promise.resolve({ id: QUIZ }) },
    );
    expect(res.status).toBe(400);
  });

  it("U-AP1-R15 503 for an unknown RPC error (drift insurance)", async () => {
    const ctx = ownerContext();
    ctx.client.rpcError = { message: "totally_unknown" };
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(503);
  });

  it("U-AP1-R16 503 when the head-count errors", async () => {
    const ctx = ownerContext();
    ctx.client.countError = "count_failed";
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("internal");
  });

  it("U-AP1-R17 413 when content-length exceeds the 512 KB override", async () => {
    ownerContext();
    const bigBody = "x".repeat(600 * 1024);
    const res = await importRoute.POST(
      new Request("http://localhost/api/import-questions", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(bigBody.length) },
        body: bigBody,
      }),
      { params: Promise.resolve({ id: QUIZ }) },
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("payload_too_large");
  });

  it("U-AP1-R18 400 invalid_json for an unparseable body", async () => {
    ownerContext();
    const res = await importRoute.POST(
      new Request("http://localhost/api/import-questions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ unclosed",
      }),
      { params: Promise.resolve({ id: QUIZ }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });

  it("U-AP1-R19 maps RPC not_quiz_owner / quiz_not_found → 404", async () => {
    const ctx = ownerContext();
    ctx.client.rpcError = { message: "quiz_not_found" };
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("U-AP1-R20 maps a racing quiz_not_draft from the RPC → 409", async () => {
    const ctx = ownerContext();
    ctx.client.rpcError = { message: "quiz_not_draft" };
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("quiz_not_draft");
  });

  it("U-AP1-R21 maps check-constraint drift → 400 (questions-route parity)", async () => {
    const ctx = ownerContext();
    ctx.client.rpcError = { message: "duplicate_options" };
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
  });

  it("U-AP1-R22 accepts exactly 30 rows into an empty quiz (Zod + fake cap boundary)", async () => {
    const ctx = ownerContext();
    const rows = Array.from({ length: 30 }, (_, i) => ({
      type: "mcq" as const,
      prompt: `Q${i}?`,
      options: ["a", "b"],
      correctIndex: 0,
    }));
    const res = await importRoute.POST(req({ questions: rows }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).added).toBe(30);
    expect(ctx.client.tables["questions"]).toHaveLength(30);
  });

  it("U-AP1-R23 accepts 1 row into a 29-question quiz (remaining-capacity boundary)", async () => {
    const ctx = ownerContext();
    for (let i = 0; i < 29; i++) {
      ctx.client.seedQuestion({
        id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
        quiz_id: QUIZ,
        order_index: i,
        type: "true_false",
        prompt: `Q${i}?`,
        options: ["True", "False"],
        correct_index: 0,
        image_path: null,
      });
    }
    const res = await importRoute.POST(req({ questions: [VALID_ROW] }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).added).toBe(1);
  });

  it("U-AP1-R24 fake lockstep: the save RPC itself rejects append at the 30 cap", async () => {
    // Direct fake-level probe (bypasses the route's head-count pre-check) so
    // the fake's computed cap branch stays honest with 0025:103-105.
    const ctx = ownerContext();
    for (let i = 0; i < 30; i++) {
      ctx.client.seedQuestion({
        id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
        quiz_id: QUIZ,
        order_index: i,
        type: "true_false",
        prompt: `Q${i}?`,
        options: ["True", "False"],
        correct_index: 0,
        image_path: null,
      });
    }
    const { error } = await ctx.client.rpc("save_quiz_questions", {
      p_quiz_id: QUIZ,
      p_title: null,
      p_source_file_url: null,
      p_source_text: null,
      p_questions: [
        { type: "mcq", prompt: "One too many?", options: ["a", "b"], correct_index: 0 },
      ],
      p_mode: "append",
    } as never);
    expect(error?.message).toBe("quiz_question_limit_exceeded");
  });
});


describe("QT-1 — multi-select import rows", () => {
  it("QT1-7 multi row maps correct_indices and nulls the scalar", async () => {
    const ctx = ownerContext();
    const res = await importRoute.POST(
      req({
        questions: [
          {
            type: "multi_select",
            prompt: "Which are prime?",
            options: ["2", "3", "4", "5"],
            correctIndices: [0, 1, 3],
          },
        ],
      }),
      { params: Promise.resolve({ id: QUIZ }) },
    );
    expect(res.status).toBe(200);
    const rows = ctx.client.tables["questions"] ?? [];
    expect(rows[0]).toMatchObject({
      type: "multi_select",
      correct_index: null,
      correct_indices: [0, 1, 3],
    });
  });

  it("QT1-8 a multi row carrying the scalar too → 400 (strict one-of)", async () => {
    ownerContext();
    const res = await importRoute.POST(
      req({
        questions: [
          {
            type: "multi_select",
            prompt: "Which are prime?",
            options: ["2", "3", "4", "5"],
            correctIndex: 0,
            correctIndices: [0, 1],
          },
        ],
      }),
      { params: Promise.resolve({ id: QUIZ }) },
    );
    expect(res.status).toBe(400);
  });
});
