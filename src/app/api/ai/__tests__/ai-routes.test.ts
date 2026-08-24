import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { FakeSupabase, makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { defaultAiServer, invalidJson } from "@/test/msw/server";
import { _resetRateLimiter } from "@/lib/classes/rate-limit";
import { http, HttpResponse } from "msw";
import * as generateRoute from "@/app/api/ai/generate-quiz/route";
import * as regenerateRoute from "@/app/api/ai/regenerate-question/route";

const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

const generate = generateRoute;
const regenerate = regenerateRoute;

async function importHandlers() {
  return { generate, regenerate };
}

function stubAiContent(content: string) {
  defaultAiServer.use(
    http.post("*/chat/completions", () =>
      HttpResponse.json({ choices: [{ message: { content } }] }),
    ),
  );
}

const QUIZ_C = "00000000-0000-4000-8000-00000000000c";
const QUESTION_D = "00000000-0000-4000-8000-00000000000d";
const OWNER_ID = "00000000-0000-4000-8000-00000000000a";

function req(body?: unknown, init?: RequestInit): Request {
  return new Request("http://localhost", {
    method: init?.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function ownerContext(opts?: Parameters<typeof makeOwnerContext>[0]) {
  const ctx = makeOwnerContext(opts);
  fakeHolder.current = ctx.client;
  return ctx;
}

function currentClient(): FakeSupabase {
  const client = fakeHolder.current;
  if (!client) throw new Error("No fake client installed");
  return client;
}

beforeEach(() => {
  fakeHolder.current = undefined;
  _resetRateLimiter();
  defaultAiServer.resetHandlers();
  // Clear any test-seeded RPC error so a stale value can't leak across tests.
  // (FakeSupabase may not exist yet — guarded.)
  const fc = fakeHolder.current;
  if (fc) (fc as { rpcError: unknown }).rpcError = null;
});

beforeAll(() => {
  defaultAiServer.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  defaultAiServer.close();
});

describe("I14 — generate happy path (MSW valid JSON)", () => {
  it("inserts questions as draft with correct_index present", async () => {
    ownerContext();
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({ quizId: QUIZ_C, extractedText: "Chapter text here", questionCount: 3 }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.title).toBe("Test Quiz");
    expect(body.quiz.title).not.toBe("AI Motion Quiz");
    expect(body.questions).toHaveLength(3);
    expect(body.questions[0].correct_index).toBe(0);
    // The quiz row was updated with source fields.
    const quizRow = currentClient().tables["quizzes"]?.find((q) => q.id === QUIZ_C);
    expect(quizRow?.source_text).toContain("Chapter text here");
  });
});

describe("I15 — invalid twice → 422, zero rows", () => {
  it("does not call the RPC on invalid AI output", async () => {
    ownerContext();
    stubAiContent(invalidJson);
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({ quizId: QUIZ_C, extractedText: "Chapter text", questionCount: 3 }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("invalid_ai_output");
    // No questions were inserted by the RPC.
    expect(currentClient().tables["questions"] ?? []).toHaveLength(0);
  });
});

describe("I16 — extractedText provided → extraction skipped", () => {
  it("uses provided text directly (no storage download)", async () => {
    ownerContext();
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({ quizId: QUIZ_C, extractedText: "Velocity is displacement over time." }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.source_text).toContain("Velocity is displacement over time.");
  });
});

describe("I16b — no extractedText → server native parse", () => {
  it("downloads the stored file and parses it", async () => {
    const ctx = ownerContext();
    // A minimal text PDF (not actually valid — nativeExtract will throw and map
    // to 422 parse_error; but for the happy path we want real text). Use a
    // plain text file stored as .txt to exercise download + native path.
    ctx.client.seedStorageFile(
      `${OWNER_ID}/${QUIZ_C}/chapter.txt`,
      new TextEncoder().encode("Velocity is the rate of change of displacement. Force equals mass times acceleration."),
    );
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({
        quizId: QUIZ_C,
        sourcePath: `${OWNER_ID}/${QUIZ_C}/chapter.txt`,
        questionCount: 3,
      }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.source_text).toContain("Velocity is the rate of change");
  });

  it("rejects a sourcePath whose first segment is not the caller's uid", async () => {
    ownerContext();
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({
        quizId: QUIZ_C,
        sourcePath: "00000000-0000-4000-8000-000000000099/victim/x.pdf",
      }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("I17 — regenerate happy path", () => {
  it("replaces a single question, siblings untouched", async () => {
    // The regenerate endpoint expects a SINGLE-question response (a 3-question
    // wrapper is now rejected by parseQuestionJson). Stub a bare question.
    stubAiContent(
      JSON.stringify({
        type: "mcq",
        prompt: "What is velocity?",
        options: ["Speed in a direction", "Total distance", "Time taken"],
        correct_index: 0,
        explanation: "Velocity includes direction.",
      }),
    );
    const ctx = ownerContext({
      questions: [
        { id: QUESTION_D, quiz_id: QUIZ_C, order_index: 0, type: "mcq", prompt: "Old Q", options: ["a", "b"], correct_index: 0 },
        { id: "00000000-0000-4000-8000-00000000000e", quiz_id: QUIZ_C, order_index: 1, type: "mcq", prompt: "Sibling", options: ["x", "y"], correct_index: 1 },
      ],
    });
    const { regenerate } = await importHandlers();
    const res = await regenerate.POST(req({ questionId: QUESTION_D }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.question.prompt).toBe("What is velocity?");
    // The sibling is untouched.
    const sibling = ctx.client.tables["questions"]?.find((q) => q.prompt === "Sibling");
    expect(sibling).toBeDefined();
  });
});

describe("I-A2 — generate replaces existing draft questions atomically", () => {
  it("old questions gone, new set present", async () => {
    const ctx = ownerContext({
      questions: [
        { id: QUESTION_D, quiz_id: QUIZ_C, order_index: 0, type: "mcq", prompt: "Old", options: ["a", "b"], correct_index: 0 },
      ],
    });
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({ quizId: QUIZ_C, extractedText: "text" }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(200);
    const remaining = (ctx.client.tables["questions"] ?? []).filter((q) => q.quiz_id === QUIZ_C);
    expect(remaining).toHaveLength(3);
    expect(remaining.some((q) => q.prompt === "Old")).toBe(false);
  });
});

describe("I-A3/I-A4 — draft-only enforcement", () => {
  it("generate on live quiz → 409", async () => {
    ownerContext({ quizStatus: "live" });
    const { generate } = await importHandlers();
    const res = await generate.POST(req({ quizId: QUIZ_C, extractedText: "x" }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(409);
  });

  it("regenerate on non-draft → 409", async () => {
    ownerContext({
      quizStatus: "live",
      questions: [{ id: QUESTION_D, quiz_id: QUIZ_C, order_index: 0, type: "mcq", prompt: "Old", options: ["a", "b"], correct_index: 0 }],
    });
    const { regenerate } = await importHandlers();
    const res = await regenerate.POST(req({ questionId: QUESTION_D }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(409);
  });
});

describe("I-A4b — regenerate trigger-error backstop", () => {
  it("UPDATE questions_locked_quiz_not_draft → 409 (race backstop)", async () => {
    // Stub a valid single-question AI response so the flow reaches the UPDATE.
    stubAiContent(
      JSON.stringify({
        type: "mcq",
        prompt: "Replacement question",
        options: ["x", "y"],
        correct_index: 0,
      }),
    );
    const ctx = ownerContext({
      // Pass the route-level draft check, but the UPDATE itself errors.
      questions: [{ id: QUESTION_D, quiz_id: QUIZ_C, order_index: 0, type: "mcq", prompt: "Old", options: ["a", "b"], correct_index: 0 }],
    });
    ctx.client.updateError = "questions_locked_quiz_not_draft";
    const { regenerate } = await importHandlers();
    const res = await regenerate.POST(req({ questionId: QUESTION_D }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("quiz_not_draft");
  });

  it("UPDATE duplicate_options / check constraint → 422", async () => {
    stubAiContent(
      JSON.stringify({
        type: "mcq",
        prompt: "Replacement question",
        options: ["x", "y"],
        correct_index: 0,
      }),
    );
    const ctx = ownerContext({
      questions: [{ id: QUESTION_D, quiz_id: QUIZ_C, order_index: 0, type: "mcq", prompt: "Old", options: ["a", "b"], correct_index: 0 }],
    });
    ctx.client.updateError = "duplicate_options";
    const { regenerate } = await importHandlers();
    const res = await regenerate.POST(req({ questionId: QUESTION_D }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_ai_output");
  });
});

describe("I-A5 — non-owner → 404", () => {
  it("generate by a different lecturer's context → 404", async () => {
    const other = new FakeSupabase();
    other.setUser("00000000-0000-4000-8000-0000000000ee", "lecturer");
    other.seedClass(QUIZ_C, "00000000-0000-4000-8000-0000000000aa");
    other.seedQuiz({
      id: QUIZ_C,
      class_id: QUIZ_C,
      created_by: "00000000-0000-4000-8000-0000000000aa",
      status: "draft",
    });
    fakeHolder.current = other;
    const { generate } = await importHandlers();
    const res = await generate.POST(req({ quizId: QUIZ_C, extractedText: "x" }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(404);
  });
});

describe("Phase 4 audit gap — regenerate normalizeOptions null", () => {
  it("regenerated question loses its correct answer → 422 invalid_ai_output", async () => {
    // AI returns options that, after dedup, drop the marked-correct option.
    stubAiContent(
      JSON.stringify({
        type: "mcq",
        prompt: "Pick one",
        options: ["A", "A", "B"],
        correct_index: 1, // "A" (index 1) dedupes away → normalizeOptions null
      }),
    );
    ownerContext({
      questions: [{ id: QUESTION_D, quiz_id: QUIZ_C, order_index: 0, type: "mcq", prompt: "Old", options: ["a", "b"], correct_index: 0 }],
    });
    const { regenerate: regen } = await importHandlers();
    const res = await regen.POST(req({ questionId: QUESTION_D }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_ai_output");
  });
});

describe("Phase 9 — Append mode, steering, difficulty, and multi-source paths", () => {
  it("appends questions to existing quiz without overwriting prior questions", async () => {
    stubAiContent(
      JSON.stringify({
        title: "AI Motion Quiz",
        questions: [
          { type: "mcq", prompt: "What is virtual memory allocation?", options: ["a", "b", "c", "d"], correct_index: 0 },
          { type: "mcq", prompt: "How does page replacement operate?", options: ["a", "b", "c", "d"], correct_index: 1 },
          { type: "mcq", prompt: "Which algorithm prevents thrashing?", options: ["a", "b", "c", "d"], correct_index: 2 },
        ],
      }),
    );
    const ctx = ownerContext({
      questions: [
        { id: QUESTION_D, quiz_id: QUIZ_C, order_index: 0, type: "mcq", prompt: "Existing Q1", options: ["a", "b"], correct_index: 0 },
        { id: "00000000-0000-4000-8000-00000000000e", quiz_id: QUIZ_C, order_index: 1, type: "mcq", prompt: "Existing Q2", options: ["c", "d"], correct_index: 1 },
      ],
    });
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({
        quizId: QUIZ_C,
        extractedText: "New Chapter notes",
        questionCount: 3,
        mode: "append",
        difficulty: "hard",
        formatDistribution: "mcq_only",
        steeringPrompt: "Focus on memory management",
      }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.questions).toHaveLength(3);
    // Newly generated rows should have sequential order_indices starting from 2
    expect(body.questions[0].order_index).toBe(2);
    expect(body.questions[1].order_index).toBe(3);
    expect(body.questions[2].order_index).toBe(4);

    // Total questions on the quiz in database should now be 5
    const totalQuestions = ctx.client.tables["questions"]?.filter((q) => q.quiz_id === QUIZ_C);
    expect(totalQuestions).toHaveLength(5);

    // Sources provenance should be tracked
    const quizRow = ctx.client.tables["quizzes"]?.find((q) => q.id === QUIZ_C);
    expect(quizRow?.sources).toBeDefined();
    expect(quizRow?.sources as unknown[]).toHaveLength(1);
  });

  it("rejects append when total questions would exceed 30 limit", async () => {
    // Seed 28 questions
    const existing = Array.from({ length: 28 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      quiz_id: QUIZ_C,
      order_index: i,
      type: "mcq" as const,
      prompt: `Q ${i}`,
      options: ["a", "b"],
      correct_index: 0,
    }));
    ownerContext({ questions: existing });
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({
        quizId: QUIZ_C,
        extractedText: "New text",
        questionCount: 5,
        mode: "append",
      }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(400); // Pre-flight check rejects with 400 invalidBody
  });

  it("multi-source: parses and combines multiple source paths", async () => {
    const ctx = ownerContext();
    ctx.client.seedStorageFile(
      `${OWNER_ID}/${QUIZ_C}/deck1.txt`,
      new TextEncoder().encode("Source file 1 content"),
    );
    ctx.client.seedStorageFile(
      `${OWNER_ID}/${QUIZ_C}/deck2.txt`,
      new TextEncoder().encode("Source file 2 content"),
    );
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({
        quizId: QUIZ_C,
        questionCount: 3,
        sourcePaths: [
          `${OWNER_ID}/${QUIZ_C}/deck1.txt`,
          `${OWNER_ID}/${QUIZ_C}/deck2.txt`,
        ],
      }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.source_text).toContain("SOURCE [1/2]: deck1.txt");
    expect(body.quiz.source_text).toContain("SOURCE [2/2]: deck2.txt");
  });

  it("multi-source: rejects source path outside tenant folder", async () => {
    ownerContext();
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({
        quizId: QUIZ_C,
        questionCount: 3,
        sourcePaths: [
          `${OWNER_ID}/${QUIZ_C}/deck1.txt`,
          "00000000-0000-4000-8000-000000000099/victim/other.txt",
        ],
      }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("Server-side parse failure paths (downloadAndParseNative hardening)", () => {
  it("storage download error → 404", async () => {
    ownerContext();
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({ quizId: QUIZ_C, sourcePath: `${OWNER_ID}/${QUIZ_C}/missing.txt` }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(404);
  });

  it("file over the 25 MB server cap → 413 payload_too_large", async () => {
    const ctx = ownerContext();
    ctx.client.seedStorageFile(
      `${OWNER_ID}/${QUIZ_C}/huge.txt`,
      new Uint8Array(25_000_001),
    );
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({ quizId: QUIZ_C, sourcePath: `${OWNER_ID}/${QUIZ_C}/huge.txt` }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("payload_too_large");
  });

  it("unsupported extension → 422 unsupported_file_type", async () => {
    const ctx = ownerContext();
    ctx.client.seedStorageFile(
      `${OWNER_ID}/${QUIZ_C}/virus.exe`,
      new TextEncoder().encode("MZ binary"),
    );
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({ quizId: QUIZ_C, sourcePath: `${OWNER_ID}/${QUIZ_C}/virus.exe` }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("unsupported_file_type");
  });

  it("corrupt pdf magic bytes → 422 parse_error", async () => {
    const ctx = ownerContext();
    ctx.client.seedStorageFile(
      `${OWNER_ID}/${QUIZ_C}/fake.pdf`,
      new TextEncoder().encode("definitely not a pdf"),
    );
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({ quizId: QUIZ_C, sourcePath: `${OWNER_ID}/${QUIZ_C}/fake.pdf` }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("parse_error");
  });

  it("single file with too little text → 422 use_browser_ocr (lowConfidence)", async () => {
    const ctx = ownerContext();
    ctx.client.seedStorageFile(
      `${OWNER_ID}/${QUIZ_C}/scan.txt`,
      new TextEncoder().encode("hi"),
    );
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({ quizId: QUIZ_C, sourcePath: `${OWNER_ID}/${QUIZ_C}/scan.txt` }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("use_browser_ocr");
  });

  it("binary disguised as .txt → 422 parse_error (null-byte guard)", async () => {
    const ctx = ownerContext();
    ctx.client.seedStorageFile(
      `${OWNER_ID}/${QUIZ_C}/binary.txt`,
      new Uint8Array([0x68, 0x69, 0x00, 0x00, 0x01]),
    );
    const { generate } = await importHandlers();
    const res = await generate.POST(
      req({ quizId: QUIZ_C, sourcePath: `${OWNER_ID}/${QUIZ_C}/binary.txt` }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("parse_error");
  });
});
