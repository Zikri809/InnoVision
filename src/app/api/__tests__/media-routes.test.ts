import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase, makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import {
  StudentFakeSupabase,
  makeStudentQuizContext,
} from "@/app/api/student-quizzes/__tests__/fake-student-supabase";
import { _resetRateLimiter, _seedRateLimit } from "@/lib/classes/rate-limit";

// ── Seams ────────────────────────────────────────────────────────────────
const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

// Storage + usage writes go through the ADMIN client — mock the boundary and
// assert the upload/remove/sign contract (face-session-routes precedent).
const storageMock = {
  upload: vi.fn().mockResolvedValue({ error: null }),
  remove: vi.fn().mockResolvedValue({ error: null }),
  createSignedUrl: vi
    .fn()
    .mockResolvedValue({ data: { signedUrl: "https://storage.test/signed?token=x" }, error: null }),
};
const adminMock = {
  storage: { from: vi.fn(() => storageMock) },
  from: vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    upsert: vi.fn().mockResolvedValue({ error: null }),
  })),
};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminMock,
}));

vi.mock("@/lib/ai/client", () => ({
  createAiClient: vi.fn(() => ({})),
  chatCompletions: vi.fn(),
  AI_MODEL: "test-model",
}));

const generateQuizMock = vi.fn();
vi.mock("@/lib/ai/quiz-prompt", () => ({
  generateQuiz: (...args: unknown[]) => generateQuizMock(...args),
}));

async function importMediaRoutes() {
  const lecturerImage = await import(
    "@/app/api/quizzes/[id]/questions/[questionId]/image/route"
  );
  const studentImage = await import(
    "@/app/api/student-quizzes/[id]/questions/[questionId]/image/route"
  );
  const sign = await import("@/app/api/question-images/[qid]/route");
  const avatar = await import("@/app/api/profile/avatar/route");
  const generate = await import("@/app/api/student-quizzes/[id]/generate/route");
  return { lecturerImage, studentImage, sign, avatar, generate };
}

const LECTURER_ID = "00000000-0000-4000-8000-00000000000a";
const STUDENT_ID = "00000000-0000-4000-8000-0000000000ff";
const QUIZ_ID = "00000000-0000-4000-8000-00000000000c";
const QUESTION_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_QUIZ_ID = "00000000-0000-4000-8000-00000000000d";

const PNG: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02];

function multipart(bytes: string | number[], filename = "pic.png", type = "image/png"): Request {
  const form = new FormData();
  const body: BlobPart =
    typeof bytes === "string" ? bytes : new Uint8Array(bytes).buffer as ArrayBuffer;
  const file = new File([body], filename, { type });
  form.append("image", file);
  // Browsers always declare content-length for uploads; Node Requests don't
  // set it automatically, so declare it explicitly (file bytes + framing).
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-length": String(file.size + 512) },
    body: form,
  });
}

function jsonReq(url: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Lecturer context owning QUIZ_ID with one question; quiz status configurable. */
function lecturerContext(quizStatus: "draft" | "live" | "closed" = "draft") {
  const ctx = makeOwnerContext({ quizStatus });
  ctx.client.seedQuestion({
    id: QUESTION_ID,
    quiz_id: QUIZ_ID,
    order_index: 0,
    type: "mcq",
    prompt: "Which?",
    options: ["a", "b"],
    correct_index: 0,
    explanation: null,
    image_path: null,
  });
  fakeHolder.current = ctx.client;
  return ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.upload.mockClear();
  storageMock.upload.mockResolvedValue({ error: null });
  storageMock.remove.mockClear();
  storageMock.remove.mockResolvedValue({ error: null });
  storageMock.createSignedUrl.mockClear();
  storageMock.createSignedUrl.mockResolvedValue({
    data: { signedUrl: "https://storage.test/signed?token=x" },
    error: null,
  });
  // Reset IMPLEMENTATIONS (not just calls) so a mockReturnValue installed by
  // one test can't leak into the next.
  adminMock.from.mockReset();
  adminMock.from.mockImplementation(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    upsert: vi.fn().mockResolvedValue({ error: null }),
  }));
  generateQuizMock.mockReset();
  fakeHolder.current = undefined;
  _resetRateLimiter();
});

describe("lecturer question image route", () => {
  it("IMG-R1 over-cap declared length → 413 before buffering (no storage call)", async () => {
    lecturerContext("draft");
    const { lecturerImage } = await importMediaRoutes();
    const req = new Request("http://localhost/api/x", {
      method: "POST",
      headers: { "content-length": String(10 * 1024 * 1024) },
    });
    const res = await lecturerImage.POST(req, {
      params: Promise.resolve({ id: QUIZ_ID, questionId: QUESTION_ID }),
    });
    expect(res.status).toBe(413);
    expect(storageMock.upload).not.toHaveBeenCalled();
  });

  it("IMG-R2 garbage magic bytes → 400, no upload", async () => {
    lecturerContext("draft");
    const { lecturerImage } = await importMediaRoutes();
    const res = await lecturerImage.POST(multipart("<html>nope</html>", "x.png", "image/png"), {
      params: Promise.resolve({ id: QUIZ_ID, questionId: QUESTION_ID }),
    });
    expect(res.status).toBe(400);
    expect(storageMock.upload).not.toHaveBeenCalled();
  });

  it("IMG-R3 valid PNG on draft → 200; sniffed contentType; column updated", async () => {
    const ctx = lecturerContext("draft");
    const { lecturerImage } = await importMediaRoutes();
    const res = await lecturerImage.POST(multipart(PNG), {
      params: Promise.resolve({ id: QUIZ_ID, questionId: QUESTION_ID }),
    });
    expect(res.status).toBe(200);
    expect(storageMock.upload).toHaveBeenCalledTimes(1);
    const [pathArg, , opts] = storageMock.upload.mock.calls[0] as [string, Buffer, { contentType: string }];
    expect(pathArg).toMatch(new RegExp(`^${LECTURER_ID}/[0-9a-f-]{36}\\.png$`));
    expect(opts.contentType).toBe("image/png");
    const row = ctx.client.tables["questions"]!.find((q) => q.id === QUESTION_ID);
    expect(row?.image_path).toBe(pathArg);
  });

  it("IMG-R5 live quiz POST → 409 (draft-only)", async () => {
    lecturerContext("live");
    const { lecturerImage } = await importMediaRoutes();
    const res = await lecturerImage.POST(multipart(PNG), {
      params: Promise.resolve({ id: QUIZ_ID, questionId: QUESTION_ID }),
    });
    expect(res.status).toBe(409);
    expect(storageMock.upload).not.toHaveBeenCalled();
  });

  it("IMG-R4a storage failure → 503, column unchanged", async () => {
    const ctx = lecturerContext("draft");
    storageMock.upload.mockResolvedValue({ error: { message: "bucket down" } });
    const { lecturerImage } = await importMediaRoutes();
    const res = await lecturerImage.POST(multipart(PNG), {
      params: Promise.resolve({ id: QUIZ_ID, questionId: QUESTION_ID }),
    });
    expect(res.status).toBe(503);
    const row = ctx.client.tables["questions"]!.find((q) => q.id === QUESTION_ID);
    expect(row?.image_path).toBeNull();
  });

  it("IMG-R7 replace ordering: old object removed only AFTER new upload succeeds", async () => {
    const ctx = lecturerContext("draft");
    const oldPath = `${LECTURER_ID}/99999999-9999-9999-9999-999999999999.png`;
    (ctx.client.tables["questions"]!.find((q) => q.id === QUESTION_ID)! as { image_path: string }).image_path = oldPath;

    const calls: string[] = [];
    storageMock.upload.mockImplementation(async () => {
      calls.push("upload");
      return { error: null };
    });
    storageMock.remove.mockImplementation(async () => {
      calls.push("remove");
      return { error: null };
    });

    const { lecturerImage } = await importMediaRoutes();
    const res = await lecturerImage.POST(multipart(PNG), {
      params: Promise.resolve({ id: QUIZ_ID, questionId: QUESTION_ID }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["upload", "remove"]);
  });

  it("foreign question id → uniform 404", async () => {
    lecturerContext("draft");
    ctxSeedForeignQuestion();
    const { lecturerImage } = await importMediaRoutes();
    const res = await lecturerImage.POST(multipart(PNG), {
      params: Promise.resolve({ id: QUIZ_ID, questionId: OTHER_QUIZ_ID }),
    });
    expect(res.status).toBe(404);
  });

  function ctxSeedForeignQuestion() {
    const client = fakeHolder.current!;
    client.tables["questions"]!.push({
      id: OTHER_QUIZ_ID,
      quiz_id: "00000000-0000-4000-8000-000000000099",
      order_index: 0,
      type: "mcq",
      prompt: "Not mine",
      options: ["x", "y"],
      correct_index: 0,
      explanation: null,
      image_path: null,
    });
  }

  it("student calling the lecturer route → 403", async () => {
    const ctx = lecturerContext("draft");
    ctx.client.setUser(STUDENT_ID, "student");
    const { lecturerImage } = await importMediaRoutes();
    const res = await lecturerImage.POST(multipart(PNG), {
      params: Promise.resolve({ id: QUIZ_ID, questionId: QUESTION_ID }),
    });
    expect(res.status).toBe(403);
  });

  it("IMG-R6 DELETE clears column then removes best-effort", async () => {
    const ctx = lecturerContext("draft");
    const oldPath = `${LECTURER_ID}/88888888-8888-8888-8888-888888888888.png`;
    (ctx.client.tables["questions"]!.find((q) => q.id === QUESTION_ID)! as { image_path: string }).image_path = oldPath;

    const { lecturerImage } = await importMediaRoutes();
    const res = await lecturerImage.DELETE(
      new Request("http://localhost/api/x", { method: "DELETE" }),
      { params: Promise.resolve({ id: QUIZ_ID, questionId: QUESTION_ID }) },
    );
    expect(res.status).toBe(200);
    const row = ctx.client.tables["questions"]!.find((q) => q.id === QUESTION_ID);
    expect(row?.image_path).toBeNull();
    expect(storageMock.remove).toHaveBeenCalledWith([oldPath]);
  });
});

describe("practice question image route", () => {
  function studentContext() {
    const ctx = makeStudentQuizContext();
    // Default session user IS the creator (makeStudentQuizContext seeds it).
    ctx.client.seedStudentQuestion({
      id: QUESTION_ID,
      quiz_id: ctx.quizId,
      order_index: 2,
      type: "mcq",
      prompt: "Pick",
      options: ["x", "y"],
      correct_index: 0,
      explanation: null,
      image_path: null,
    });
    fakeHolder.current = ctx.client;
    return ctx;
  }

  it("creator uploads → 200 + column update", async () => {
    const ctx = studentContext();
    const { studentImage } = await importMediaRoutes();
    const res = await studentImage.POST(multipart(PNG), {
      params: Promise.resolve({ id: ctx.quizId, questionId: QUESTION_ID }),
    });
    expect(res.status).toBe(200);
    const row = ctx.client.tables["student_quiz_questions"]!.find((q) => q.id === QUESTION_ID);
    expect(String(row?.image_path)).toMatch(new RegExp(`^${ctx.ownerId}/[0-9a-f-]{36}\\.png$`));
  });

  it("non-owner student → uniform 404", async () => {
    const ctx = studentContext();
    ctx.client.setUser("00000000-0000-4000-8000-0000000000ee", "student");
    const { studentImage } = await importMediaRoutes();
    const res = await studentImage.POST(multipart(PNG), {
      params: Promise.resolve({ id: ctx.quizId, questionId: QUESTION_ID }),
    });
    expect(res.status).toBe(404);
    expect(storageMock.upload).not.toHaveBeenCalled();
  });
});

describe("sign route GET /api/question-images/[qid]", () => {
  async function seedAndCall(decision: { image_path: string; ttl_seconds: number } | null) {
    const client = new FakeSupabase();
    client.setUser(STUDENT_ID, "student");
    if (decision) client.seedResolvedImage(QUESTION_ID, decision);
    fakeHolder.current = client;
    const { sign } = await importMediaRoutes();
    return sign.GET(new Request("http://localhost/api/x"), {
      params: Promise.resolve({ qid: QUESTION_ID }),
    });
  }

  it("no visibility decision → uniform 404, nothing signed", async () => {
    const res = await seedAndCall(null);
    expect(res.status).toBe(404);
    expect(storageMock.createSignedUrl).not.toHaveBeenCalled();
  });

  it("visible → {url, expiresAt} with the RPC-provided TTL", async () => {
    const res = await seedAndCall({
      image_path: `${LECTURER_ID}/77777777-7777-7777-7777-777777777777.png`,
      ttl_seconds: 300,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain("signed");
    expect(typeof body.expiresAt).toBe("string");
    expect(storageMock.createSignedUrl).toHaveBeenCalledWith(
      `${LECTURER_ID}/77777777-7777-7777-7777-777777777777.png`,
      300,
    );
  });

  it("malformed stored path → 404 even when a decision exists (defense in depth)", async () => {
    const res = await seedAndCall({
      image_path: "../../etc/passwd",
      ttl_seconds: 3600,
    });
    expect(res.status).toBe(404);
    expect(storageMock.createSignedUrl).not.toHaveBeenCalled();
  });
});

describe("avatar route", () => {
  function userCtx(role: "student" | "lecturer" = "student") {
    const client = new StudentFakeSupabase();
    client.setUser(STUDENT_ID, role);
    client.tables["profiles"]![0]["avatar_path"] = null;
    fakeHolder.current = client;
    return client;
  }

  it("POST valid photo → column set, ok:true", async () => {
    const client = userCtx();
    const { avatar } = await importMediaRoutes();
    const res = await avatar.POST(multipart(PNG));
    expect(res.status).toBe(200);
    const profile = client.tables["profiles"]![0];
    expect(String(profile.avatar_path)).toMatch(new RegExp(`^${STUDENT_ID}/avatar\\.png$`));
  });

  it("GET self with avatar → signed URL; without → 404", async () => {
    const client = userCtx();
    const { avatar } = await importMediaRoutes();

    const none = await avatar.GET();
    expect(none.status).toBe(404);

    (client.tables["profiles"]![0] as { avatar_path: string }).avatar_path =
      `${STUDENT_ID}/avatar.png`;
    const ok = await avatar.GET();
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.url).toContain("signed");
    expect(storageMock.createSignedUrl).toHaveBeenCalledWith(`${STUDENT_ID}/avatar.png`, 3600);
  });

  it("DELETE clears the column and removes the object", async () => {
    const client = userCtx();
    (client.tables["profiles"]![0] as { avatar_path: string }).avatar_path =
      `${STUDENT_ID}/avatar.png`;
    const { avatar } = await importMediaRoutes();
    const res = await avatar.DELETE(new Request("http://localhost/api/x", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(client.tables["profiles"]![0].avatar_path).toBeNull();
    expect(storageMock.remove).toHaveBeenCalled();
  });
});

describe("student AI generate route", () => {
  function genCtx(existing = 0) {
    const ctx = makeStudentQuizContext();
    for (let i = 0; i < existing; i++) {
      ctx.client.seedStudentQuestion({
        id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`,
        quiz_id: ctx.quizId,
        order_index: i,
        type: "mcq",
        prompt: `seed ${i}`,
        options: ["a", "b"],
        correct_index: 0,
      });
    }
    fakeHolder.current = ctx.client;
    return ctx;
  }

  const goodAi = {
    ok: true as const,
    quiz: {
      title: "Generated",
      questions: Array.from({ length: 3 }, (_, i) => ({
        type: "mcq" as const,
        prompt: `Generated question ${i}`,
        options: ["alpha", "beta"],
        correct_index: 0,
        explanation: null,
      })),
    },
  };

  it("CSRF: cross-origin POST → 403", async () => {
    genCtx();
    const { generate } = await importMediaRoutes();
    const req = new Request("http://localhost/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ extractedText: "some study notes text here" }),
    });
    const res = await generate.POST(req, { params: Promise.resolve({ id: QUIZ_ID }) });
    expect(res.status).toBe(403);
  });

  it("rate limit 5/h → 429", async () => {
    const ctx = genCtx();
    const { generate } = await importMediaRoutes();
    _seedRateLimit(`sq-generate:${ctx.client.user!.id}`, 5);
    const res = await generate.POST(
      jsonReq("/api/generate", { extractedText: "some study notes text here" }),
      { params: Promise.resolve({ id: ctx.quizId }) },
    );
    expect(res.status).toBe(429);
  });

  it("non-owner quiz → uniform 404", async () => {
    const ctx = genCtx();
    ctx.client.setUser("00000000-0000-4000-8000-0000000000ee", "student");
    const { generate } = await importMediaRoutes();
    const res = await generate.POST(
      jsonReq("/api/generate", { extractedText: "some study notes text here" }),
      { params: Promise.resolve({ id: ctx.quizId }) },
    );
    expect(res.status).toBe(404);
  });
  it("missing input → 400 invalid_body", async () => {
    const ctx = genCtx();
    const { generate } = await importMediaRoutes();
    const res = await generate.POST(jsonReq("/api/generate", {}), {
      params: Promise.resolve({ id: ctx.quizId }),
    });
    expect(res.status).toBe(400);
  });

  it("invalid AI output → 422 with ZERO rows written", async () => {
    const ctx = genCtx();
    const before = (ctx.client.tables["student_quiz_questions"] ?? []).filter(
      (q) => q.quiz_id === ctx.quizId,
    ).length;
    generateQuizMock.mockResolvedValue({ ok: false as const, error: "invalid_output" });
    const { generate } = await importMediaRoutes();
    const res = await generate.POST(
      jsonReq("/api/generate", { extractedText: "some study notes text here" }),
      { params: Promise.resolve({ id: ctx.quizId }) },
    );
    expect(res.status).toBe(422);
    const after = (ctx.client.tables["student_quiz_questions"] ?? []).filter(
      (q) => q.quiz_id === ctx.quizId,
    ).length;
    expect(after).toBe(before);
  });

  it("success on existing quiz → appends via replace/append decision; daily counter incremented", async () => {
    const ctx = genCtx(0); // context already seeds 2 questions
    const seededBefore = (ctx.client.tables["student_quiz_questions"] ?? []).filter(
      (q) => q.quiz_id === ctx.quizId,
    ).length;
    generateQuizMock.mockResolvedValue(goodAi);
    const upsertMock = vi.fn().mockResolvedValue({ error: null });
    adminMock.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      upsert: upsertMock,
    });

    const { generate } = await importMediaRoutes();
    const res = await generate.POST(
      jsonReq("/api/generate", { extractedText: "some study notes text here", questionCount: 3 }),
      { params: Promise.resolve({ id: ctx.quizId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.questions).toHaveLength(3);
    expect(upsertMock).toHaveBeenCalledTimes(1);

    const total = (ctx.client.tables["student_quiz_questions"] ?? []).filter(
      (q) => q.quiz_id === ctx.quizId,
    ).length;
    expect(total).toBe(seededBefore + 3);
  });

  it("append-clamps to remaining cap slots", async () => {
    // Context seeds 2 questions; +46 = 48 existing → 2 slots remain.
    const ctx = genCtx(46);
    generateQuizMock.mockResolvedValue(goodAi);
    adminMock.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    });

    const { generate } = await importMediaRoutes();
    const res = await generate.POST(
      jsonReq("/api/generate", { extractedText: "some study notes text here", questionCount: 10 }),
      { params: Promise.resolve({ id: ctx.quizId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.questions).toHaveLength(2); // clamped to the 2 remaining slots
    // 48 existing + clamped generation = exactly 50.
    const total = (ctx.client.tables["student_quiz_questions"] ?? []).filter(
      (q) => q.quiz_id === ctx.quizId,
    ).length;
    expect(total).toBe(50);
  });
});

describe("iteration-1 audit additions", () => {
  it("AV-R1 cross-extension replace removes the OLD object (path not stable)", async () => {
    const client = new StudentFakeSupabase();
    client.setUser(STUDENT_ID, "student");
    (client.tables["profiles"]![0] as { avatar_path: string }).avatar_path =
      `${STUDENT_ID}/avatar.png`;
    fakeHolder.current = client;

    // Upload a JPEG this time ? new path avatar.jpg; old avatar.png removed.
    const JPEG: number[] = [0xff, 0xd8, 0xff, 0xe0];
    const form = new FormData();
    form.append("image", new File([new Uint8Array(JPEG).buffer as ArrayBuffer], "me.jpg", { type: "image/jpeg" }));
    const { avatar } = await importMediaRoutes();
    const res = await avatar.POST(
      new Request("http://localhost/api/x", {
        method: "POST",
        headers: { "content-length": String(JPEG.length + 512) },
        body: form,
      }),
    );
    expect(res.status).toBe(200);
    expect(client.tables["profiles"]![0].avatar_path).toBe(`${STUDENT_ID}/avatar.jpg`);
    expect(storageMock.remove).toHaveBeenCalledWith([`${STUDENT_ID}/avatar.png`]);
  });

  it("AV-R2 failed re-upload leaves the previous avatar fully intact", async () => {
    const client = new StudentFakeSupabase();
    client.setUser(STUDENT_ID, "student");
    (client.tables["profiles"]![0] as { avatar_path: string }).avatar_path =
      `${STUDENT_ID}/avatar.png`;
    fakeHolder.current = client;
    storageMock.upload.mockResolvedValue({ error: { message: "storage down" } });

    const { avatar } = await importMediaRoutes();
    const res = await avatar.POST(multipart(PNG));
    expect(res.status).toBe(503);
    // Column unchanged AND old object untouched.
    expect(client.tables["profiles"]![0].avatar_path).toBe(`${STUDENT_ID}/avatar.png`);
    expect(storageMock.remove).not.toHaveBeenCalled();
  });

  it("IMG-R4b column-update error ? rollback removes the just-uploaded object", async () => {
    const ctx = lecturerContext("draft");
    // Force the guarded UPDATE to fail via the write-error seam.
    ctx.client.updateError = "trigger exploded";
    const { lecturerImage } = await importMediaRoutes();
    const res = await lecturerImage.POST(multipart(PNG), {
      params: Promise.resolve({ id: QUIZ_ID, questionId: QUESTION_ID }),
    });
    expect(res.status).toBe(503);
    // Rollback: the NEW path was removed (upload succeeded first).
    expect(storageMock.upload).toHaveBeenCalledTimes(1);
    const [newPath] = storageMock.upload.mock.calls[0] as [string, Buffer, unknown];
    expect(storageMock.remove).toHaveBeenCalledWith([newPath]);
    const row = ctx.client.tables["questions"]!.find((q) => q.id === QUESTION_ID);
    expect(row?.image_path).toBeNull();
  });

  it("sign route rate limit 60/min ? 429", async () => {
    const client = new FakeSupabase();
    client.setUser(STUDENT_ID, "student");
    client.seedResolvedImage(QUESTION_ID, {
      image_path: `${LECTURER_ID}/77777777-7777-7777-7777-777777777777.png`,
      ttl_seconds: 3600,
    });
    fakeHolder.current = client;
    _seedRateLimit(`q-image-sign:${STUDENT_ID}`, 60);
    const { sign } = await importMediaRoutes();
    const res = await sign.GET(new Request("http://localhost/api/x"), {
      params: Promise.resolve({ qid: QUESTION_ID }),
    });
    expect(res.status).toBe(429);
  });

  it("SG-R: sourcePath outside the quiz tenant folder ? 400", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    const { generate } = await importMediaRoutes();
    // Same uid but WRONG quiz segment � must be rejected by the route.
    const foreignQuizPath = `${ctx.ownerId}/00000000-0000-4000-8000-999999999999/notes.pdf`;
    const res = await generate.POST(
      jsonReq("/api/generate", { sourcePaths: [foreignQuizPath] }),
      { params: Promise.resolve({ id: ctx.quizId }) },
    );
    expect(res.status).toBe(400);
  });

  it("SG-R: over-cap body (512 KB declared) ? 413 before parse", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    const { generate } = await importMediaRoutes();
    const req = new Request("http://localhost/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(600 * 1024) },
      body: JSON.stringify({ extractedText: "x" }),
    });
    const res = await generate.POST(req, { params: Promise.resolve({ id: ctx.quizId }) });
    expect(res.status).toBe(413);
  });

  it("SG-R: daily counter exhausted ? 429 even under the hourly cap", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client;
    adminMock.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { count: 20 } }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    });
    const { generate } = await importMediaRoutes();
    const res = await generate.POST(
      jsonReq("/api/generate", { extractedText: "some study notes text here" }),
      { params: Promise.resolve({ id: ctx.quizId }) },
    );
    expect(res.status).toBe(429);
  });

  it("SG-R: question_cap_reached on a full quiz ? 422 before any AI call", async () => {
    const ctx = makeStudentQuizContext();
    // Context seeds 2; fill to 50.
    const questions = ctx.client.tables["student_quiz_questions"]!;
    for (let i = questions.length; i < 50; i++) {
      ctx.client.seedStudentQuestion({
        id: `00000000-0000-4000-8000-${String(200 + i).padStart(12, "0")}`,
        quiz_id: ctx.quizId,
        order_index: i,
        type: "mcq",
        prompt: `filler ${i}`,
        options: ["a", "b"],
        correct_index: 0,
      });
    }
    fakeHolder.current = ctx.client;
    const { generate } = await importMediaRoutes();
    const res = await generate.POST(
      jsonReq("/api/generate", { extractedText: "some study notes text here" }),
      { params: Promise.resolve({ id: ctx.quizId }) },
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("question_cap_reached");
    expect(generateQuizMock).not.toHaveBeenCalled();
  });
});
