import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase, makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { _resetRateLimiter } from "@/lib/classes/rate-limit";
import * as duplicateRoute from "@/app/api/quizzes/[id]/duplicate/route";

const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

// Storage seam for the admin client (question-images copies). The fake's own
// storage only implements download; the duplicate route's storage phase rides
// the admin client exclusively.
const adminState = vi.hoisted(() => ({
  copyCalls: [] as Array<{ bucket: string; src: string; dst: string }>,
  removedPaths: [] as string[],
  copyError: null as { message: string } | null,
  throwOnCopy: false,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: (bucket: string) => ({
        copy: async (src: string, dst: string) => {
          if (adminState.throwOnCopy) throw new Error("admin client exploded");
          adminState.copyCalls.push({ bucket, src, dst });
          if (adminState.copyError) return { data: null, error: adminState.copyError };
          return { data: { path: dst }, error: null };
        },
        remove: async (paths: string[]) => {
          adminState.removedPaths.push(...paths);
          return { data: paths.map((p) => ({ path: p })), error: null };
        },
      }),
    },
  }),
}));

const QUIZ = "00000000-0000-4000-8000-00000000000c";
const LECTURER_ID = "00000000-0000-4000-8000-00000000000a";
const CLASS_ID = "00000000-0000-4000-8000-00000000000b";
const CLASS_B = "00000000-0000-4000-8000-0000000000b0";
const IMAGE_SRC = `${LECTURER_ID}/11111111-1111-4111-8111-111111111111.png`;

function req(body: unknown, opts?: { origin?: string }): Request {
  return new Request("http://localhost/api/duplicate", {
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

function seedSourceQuestions(ctx: ReturnType<typeof makeOwnerContext>) {
  ctx.client.seedQuestion({
    id: "00000000-0000-4000-8000-00000000000d",
    quiz_id: QUIZ,
    order_index: 0,
    type: "mcq",
    prompt: "Imaged?",
    options: ["a", "b"],
    correct_index: 0,
    image_path: IMAGE_SRC,
  });
  ctx.client.seedQuestion({
    id: "00000000-0000-4000-8000-00000000000e",
    quiz_id: QUIZ,
    order_index: 1,
    type: "true_false",
    prompt: "Plain?",
    options: ["True", "False"],
    correct_index: 0,
    image_path: null,
  });
}

beforeEach(() => {
  fakeHolder.current = undefined;
  adminState.copyCalls.length = 0;
  adminState.removedPaths.length = 0;
  adminState.copyError = null;
  adminState.throwOnCopy = false;
  _resetRateLimiter();
});

describe("POST /api/quizzes/[id]/duplicate", () => {
  it("U-AP2-R1 clones within the class → 201 {quizId} + draft copy state", async () => {
    const ctx = ownerContext({ status: "live" });
    seedSourceQuestions(ctx);
    const quiz = ctx.client.tables["quizzes"]![0];
    quiz.opens_at = "2026-01-01T00:00:00Z";
    quiz.results_revealed_at = "2026-01-02T00:00:00Z";
    quiz.source_file_url = "https://example.org/file.pdf";
    quiz.source_text = "kept provenance";

    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(201);
    const { quizId } = (await res.json()) as { quizId: string };

    const quizzes = ctx.client.tables["quizzes"] ?? [];
    const clone = quizzes.find((q) => q.id === quizId);
    expect(clone).toBeDefined();
    expect(clone!.title).toBe("Test Quiz (copy)");
    expect(clone!.created_by).toBe(LECTURER_ID);
    // Live source → draft destination; linkage/session state never copied.
    expect(clone!.status).toBe("draft");
    expect(clone!.opens_at).toBeNull();
    expect(clone!.results_revealed_at).toBeNull();
    expect(clone!.source_file_url).toBeNull();
    // Plain-text provenance IS copied.
    expect(clone!.source_text).toBe("kept provenance");
    // Source untouched.
    expect(quiz.status).toBe("live");
    expect(quiz.title).toBe("Test Quiz");

    const questions = ctx.client.tables["questions"] ?? [];
    const cloneQuestions = questions.filter((q) => q.quiz_id === quizId);
    expect(cloneQuestions).toHaveLength(2);
    expect(cloneQuestions.map((q) => q.order_index)).toEqual([0, 1]);
    expect(cloneQuestions.every((q) => q.id !== questions[0].id)).toBe(true);
  });

  it("U-AP2-R2 copies each image object to a fresh path and repoints the clone row", async () => {
    const ctx = ownerContext();
    seedSourceQuestions(ctx);

    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(201);
    const { quizId } = (await res.json()) as { quizId: string };

    expect(adminState.copyCalls).toHaveLength(1);
    const call = adminState.copyCalls[0];
    expect(call.bucket).toBe("question-images");
    expect(call.src).toBe(IMAGE_SRC);
    expect(call.dst.startsWith(`${LECTURER_ID}/`)).toBe(true);

    const cloneQuestions = (ctx.client.tables["questions"] ?? []).filter(
      (q) => q.quiz_id === quizId,
    );
    const imagedClone = cloneQuestions.find((q) => q.prompt === "Imaged?");
    expect(imagedClone!.image_path).toBe(call.dst);
    // Clone never shares the source object once the phase lands.
    expect(imagedClone!.image_path).not.toBe(IMAGE_SRC);
    // The plain question is untouched by the storage phase.
    const plainClone = cloneQuestions.find((q) => q.prompt === "Plain?");
    expect(plainClone!.image_path).toBeNull();
  });

  it("U-AP2-R3 a copy failure NULLs that clone's image_path but still succeeds", async () => {
    const ctx = ownerContext();
    seedSourceQuestions(ctx);
    adminState.copyError = { message: "storage down" };

    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(201);
    const { quizId } = (await res.json()) as { quizId: string };
    const imagedClone = (ctx.client.tables["questions"] ?? []).find(
      (q) => q.quiz_id === quizId && q.prompt === "Imaged?",
    );
    expect(imagedClone!.image_path).toBeNull();
  });

  it("U-AP2-R4 an unvalidatable source path is never copied (fail closed)", async () => {
    const ctx = ownerContext();
    ctx.client.seedQuestion({
      id: "00000000-0000-4000-8000-00000000000d",
      quiz_id: QUIZ,
      order_index: 0,
      type: "mcq",
      prompt: "Evil?",
      options: ["a", "b"],
      correct_index: 0,
      image_path: "../../etc/passwd",
    });

    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(201);
    expect(adminState.copyCalls).toHaveLength(0);
    const { quizId } = (await res.json()) as { quizId: string };
    const evilClone = (ctx.client.tables["questions"] ?? []).find(
      (q) => q.quiz_id === quizId,
    );
    expect(evilClone!.image_path).toBeNull();
  });

  it("U-AP2-R5 a failed column UPDATE rolls the copied object back", async () => {
    const ctx = ownerContext();
    seedSourceQuestions(ctx);
    ctx.client.updateError = "db down";

    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(201);
    expect(adminState.copyCalls).toHaveLength(1);
    expect(adminState.removedPaths).toEqual([adminState.copyCalls[0].dst]);
  });

  it("U-AP2-R6 clones into another owned class", async () => {
    const ctx = ownerContext();
    ctx.client.seedClass(CLASS_B, LECTURER_ID);
    seedSourceQuestions(ctx);

    const res = await duplicateRoute.POST(req({ destClassId: CLASS_B }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(201);
    const { quizId } = (await res.json()) as { quizId: string };
    const clone = (ctx.client.tables["quizzes"] ?? []).find((q) => q.id === quizId);
    expect(clone!.class_id).toBe(CLASS_B);
  });

  it("U-AP2-R7 409 for an archived destination class", async () => {
    const ctx = ownerContext();
    ctx.client.seedClass(CLASS_B, LECTURER_ID);
    const clsB = (ctx.client.tables["classes"] ?? []).find((c) => c.id === CLASS_B);
    clsB!.archived_at = "2026-01-01T00:00:00Z";

    const res = await duplicateRoute.POST(req({ destClassId: CLASS_B }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("class_archived");
  });

  it("U-AP2-R8 404 for a destination class the caller does not own (no oracle)", async () => {
    const ctx = ownerContext();
    ctx.client.seedClass(CLASS_B, "00000000-0000-4000-8000-0000000000ee");

    const res = await duplicateRoute.POST(req({ destClassId: CLASS_B }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(404);
  });

  it("U-AP2-R9 404 for a non-owner source lecturer", async () => {
    const ctx = ownerContext();
    ctx.client.seedClass(CLASS_B, "00000000-0000-4000-8000-0000000000ee");
    ctx.client.setUser("00000000-0000-4000-8000-0000000000ee", "lecturer");

    const res = await duplicateRoute.POST(req({ destClassId: CLASS_B }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(404);
  });

  it("U-AP2-R10 401 for unauthenticated callers", async () => {
    const ctx = ownerContext();
    ctx.client.user = null;
    ctx.client.profileRole = null;
    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(401);
  });

  it("U-AP2-R11 403 for cross-origin requests (CSRF)", async () => {
    ownerContext();
    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }, { origin: "https://evil.example" }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("invalid_origin");
  });

  it("U-AP2-R12 429 when the duplicate budget is exhausted", async () => {
    const { _seedRateLimit } = await import("@/lib/classes/rate-limit");
    ownerContext();
    _seedRateLimit(`quiz-duplicate:${LECTURER_ID}`, 30);
    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(429);
  });

  it("U-AP2-R13 400 for an invalid payload (missing/foreign destClassId)", async () => {
    ownerContext();
    const res = await duplicateRoute.POST(req({ destClassId: "nope" }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(400);
  });

  it("U-AP2-R14 404 for a non-uuid id", async () => {
    ownerContext();
    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("U-AP2-R15 maps clone_quiz class_archived (DB backstop) → 409", async () => {
    const ctx = ownerContext();
    ctx.client.rpcError = { message: "class_archived" };
    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("class_archived");
  });

  it("U-AP2-R16 503 for an unknown RPC error (drift insurance)", async () => {
    const ctx = ownerContext();
    ctx.client.rpcError = { message: "totally_unknown" };
    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("internal");
  });

  it("U-AP2-R17 maps RPC 404 arms (not_quiz_owner / quiz_not_found / not_class_owner)", async () => {
    for (const message of ["not_quiz_owner", "quiz_not_found", "not_class_owner"]) {
      const ctx = ownerContext();
      ctx.client.rpcError = { message };
      const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
        params: Promise.resolve({ id: QUIZ }),
      });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("not_found");
    }
  });

  it("U-AP2-R18 503 when clone_quiz returns a non-string id", async () => {
    const ctx = ownerContext();
    seedSourceQuestions(ctx);
    ctx.client.rpcResult = { data: 42, error: null };
    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("internal");
  });

  it("U-AP2-R19 413 when content-length exceeds 64 KiB (default cap, small payload route)", async () => {
    ownerContext();
    const bigBody = "x".repeat(80 * 1024);
    const res = await duplicateRoute.POST(
      new Request("http://localhost/api/duplicate", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(bigBody.length) },
        body: bigBody,
      }),
      { params: Promise.resolve({ id: QUIZ }) },
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("payload_too_large");
  });

  it("U-AP2-R20 400 invalid_json for an unparseable body", async () => {
    ownerContext();
    const res = await duplicateRoute.POST(
      new Request("http://localhost/api/duplicate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ unclosed",
      }),
      { params: Promise.resolve({ id: QUIZ }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });

  it("U-AP2-R21 a clone with zero imaged questions never touches storage", async () => {
    const ctx = ownerContext();
    seedSourceQuestions(ctx);
    // Both source questions plain — override the imaged one.
    ctx.client.tables["questions"] = (ctx.client.tables["questions"] ?? []).map((q) => ({
      ...q,
      image_path: null,
    }));

    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(201);
    expect(adminState.copyCalls).toHaveLength(0);
    expect(adminState.removedPaths).toHaveLength(0);
  });

  it("U-AP2-R22 copies EVERY imaged question (multi-image loop)", async () => {
    const ctx = ownerContext();
    ctx.client.seedQuestion({
      id: "00000000-0000-4000-8000-00000000000d",
      quiz_id: QUIZ,
      order_index: 0,
      type: "mcq",
      prompt: "Img 1?",
      options: ["a", "b"],
      correct_index: 0,
      image_path: `${LECTURER_ID}/11111111-1111-4111-8111-111111111111.png`,
    });
    ctx.client.seedQuestion({
      id: "00000000-0000-4000-8000-00000000000e",
      quiz_id: QUIZ,
      order_index: 1,
      type: "mcq",
      prompt: "Img 2?",
      options: ["c", "d"],
      correct_index: 1,
      image_path: `${LECTURER_ID}/22222222-2222-4222-8222-222222222222.webp`,
    });

    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(201);
    expect(adminState.copyCalls).toHaveLength(2);
    expect(adminState.copyCalls.every((c) => c.bucket === "question-images")).toBe(true);
    expect(new Set(adminState.copyCalls.map((c) => c.dst)).size).toBe(2);
  });

  it("U-AP2-R23 a failed image-phase select fail-closes every clone image_path", async () => {
    const ctx = ownerContext();
    seedSourceQuestions(ctx);
    ctx.client.selectError = "select failed";
    ctx.client.selectErrorTable = "questions";

    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(201);
    const { quizId } = (await res.json()) as { quizId: string };
    const cloneQuestions = (ctx.client.tables["questions"] ?? []).filter(
      (q) => q.quiz_id === quizId,
    );
    expect(cloneQuestions.every((q) => q.image_path === null)).toBe(true);
  });

  it("U-AP2-R24 an unexpected phase THROW fail-closes (outer catch, never a raw 500)", async () => {
    const ctx = ownerContext();
    seedSourceQuestions(ctx);
    adminState.throwOnCopy = true;

    const res = await duplicateRoute.POST(req({ destClassId: CLASS_ID }), {
      params: Promise.resolve({ id: QUIZ }),
    });
    expect(res.status).toBe(201);
    const { quizId } = (await res.json()) as { quizId: string };
    const cloneQuestions = (ctx.client.tables["questions"] ?? []).filter(
      (q) => q.quiz_id === quizId,
    );
    expect(cloneQuestions.every((q) => q.image_path === null)).toBe(true);
  });
});
