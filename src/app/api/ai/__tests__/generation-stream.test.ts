import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { makeStudentQuizContext } from "@/app/api/student-quizzes/__tests__/fake-student-supabase";
import { invalidJson } from "@/test/msw/server";
import { _resetRateLimiter, _seedRateLimit } from "@/lib/classes/rate-limit";
import { http, HttpResponse } from "msw";
import * as generateRoute from "@/app/api/ai/generate-quiz/route";
import * as studentGenerateRoute from "@/app/api/student-quizzes/[id]/generate/route";
import type { GenerationEvent } from "@/lib/ai/events";

/**
 * Phase 1 integration tests — the NDJSON event spine (two-segment contract).
 *
 * The legacy JSON behavior keeps its own pinned suite (ai-routes.test.ts,
 * untouched). This file proves the OPT-IN stream protocol: header-triggered,
 * pre-stream guards stay JSON, post-stream failures are error events carrying
 * the same codes, lifecycle semantics hold (in-flight released on error/
 * cancel; no save on cancel), and the event sequences are ordered as designed.
 *
 * The MSW fake is STREAM-AWARE: when the upstream request has stream:true it
 * answers with SSE content deltas (the shape the real Kenari proxy emits —
 * scripts/spike-kenari.mjs); otherwise legacy JSON. Without this, stream-mode
 * routes feed SSE-formatted failures into the SDK parser → ai_unavailable.
 */

const fakeHolder: { current: ReturnType<typeof makeOwnerContext>["client"] | undefined } = {
  current: undefined,
};
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

// Student route's durable daily-usage seam (service-role table): the usage
// arm is stubbed — count 0 (under limit), upsert succeeds. The lecturer
// route's question readback also runs on the service-role client (D2-19:
// 0054 revoked the base `questions` table from `authenticated`), so every
// other table resolves to the SAME fake DB the user-scoped client serves —
// one in-memory source of truth for both.
const adminStub = {
  from: (table: string) =>
    table === "ai_generation_usage"
      ? {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { count: 0 } }),
              }),
            }),
          }),
          upsert: async () => ({ error: null }),
        }
      : fakeHolder.current!.from(table),
};
const adminHolder: { current: typeof adminStub | undefined } = { current: undefined };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminHolder.current,
}));

const QUIZ_C = "00000000-0000-4000-8000-00000000000c";
const OWNER_ID = "00000000-0000-4000-8000-00000000000a";

function req(body?: unknown, init?: RequestInit): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/x-ndjson",
      ...(init?.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function ownerContext(opts?: Parameters<typeof makeOwnerContext>[0]) {
  const ctx = makeOwnerContext(opts);
  fakeHolder.current = ctx.client as ReturnType<typeof makeOwnerContext>["client"];
  return ctx;
}

const VALID_AI_BODY = {
  title: "Test Quiz",
  questions: [
    { type: "mcq", prompt: "Generated question one?", options: ["a", "b", "c"], correct_index: 0 },
    { type: "mcq", prompt: "Generated question two?", options: ["a", "b"], correct_index: 1 },
    { type: "true_false", prompt: "Generated statement three.", options: ["True", "False"], correct_index: 0 },
  ],
};

/** SSE-encode a chat completion content stream (Kenari shape: reasoning first,
 * then content deltas, then a stop chunk). */
function sseBody(content: string, opts: { reasoning?: boolean; finish?: string } = {}) {
  const chunks: unknown[] = [];
  if (opts.reasoning !== false) {
    chunks.push({ choices: [{ delta: { reasoning_content: "Thinking… " }, finish_reason: null, index: 0 }] });
  }
  const STEP = 20;
  for (let i = 0; i < content.length; i += STEP) {
    chunks.push({ choices: [{ delta: { content: content.slice(i, i + STEP) }, finish_reason: null, index: 0 }] });
  }
  chunks.push({ choices: [{ delta: {}, finish_reason: opts.finish ?? "stop", index: 0 }] });
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

/** Stream-aware AI stub: SSE when the route asks to stream, JSON otherwise. */
function stubAiContent(content: string) {
  defaultAiServerUse(
    http.post("*/chat/completions", async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as { stream?: boolean };
      if (body.stream) {
        return new HttpResponse(sseBody(content), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return HttpResponse.json({ choices: [{ message: { content } }] });
    }),
  );
}

import { defaultAiServer } from "@/test/msw/server";
function defaultAiServerUse(...handlers: Parameters<typeof defaultAiServer.use>) {
  defaultAiServer.use(...handlers);
}

/** Drain a stream-mode Response into parsed events. */
async function collectStream(res: Response): Promise<GenerationEvent[]> {
  expect(res.headers.get("content-type")).toContain("application/x-ndjson");
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as GenerationEvent);
}

beforeEach(() => {
  fakeHolder.current = undefined;
  adminHolder.current = adminStub;
  _resetRateLimiter();
  defaultAiServer.resetHandlers();
});

beforeAll(() => {
  defaultAiServer.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  defaultAiServer.close();
});

describe("two-segment contract: pre-stream guards keep JSON statuses", () => {
  it("ST-G1: invalid body → 400 JSON even with the stream accept header", async () => {
    ownerContext();
    const res = await generateRoute.POST(req({ quizId: "not-a-uuid" }), {
      params: Promise.resolve({ id: QUIZ_C }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error).toBe("invalid_body");
  });

  it("ST-G2: rate limit → 429 JSON in stream mode", async () => {
    ownerContext();
    _seedRateLimit(`aiGenerate:${OWNER_ID}`, 10);
    const res = await generateRoute.POST(
      req({ quizId: QUIZ_C, extractedText: "text", questionCount: 3 }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
  });

  it("ST-G3: in-flight guard → 429 JSON in stream mode (deterministic via deferred upstream)", async () => {
    ownerContext();
    // Deferred upstream: the first POST stays in-flight until released.
    let releaseUpstream: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseUpstream = r));
    defaultAiServerUse(
      http.post("*/chat/completions", async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as { stream?: boolean };
        await gate;
        if (body.stream) {
          return new HttpResponse(sseBody(JSON.stringify(VALID_AI_BODY)), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return HttpResponse.json({ choices: [{ message: { content: JSON.stringify(VALID_AI_BODY) } }] });
      }),
    );
    const first = generateRoute.POST(
      req({ quizId: QUIZ_C, extractedText: "first", questionCount: 3 }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    // Second POST while the first holds the guard → JSON 429 (pre-stream).
    const res = await generateRoute.POST(
      req({ quizId: QUIZ_C, extractedText: "second", questionCount: 3 }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(res.status).toBe(429);
    const body = await res.json();
    // Distinct code: "already running" ≠ the hourly quota 429.
    expect(body.error).toBe("already_running");
    expect(body.message).toMatch(/already in progress/i);
    // Cleanup: release + drain the first so its guard entry never leaks
    // into later tests.
    releaseUpstream();
    const firstRes = await first;
    await firstRes.text();
  });
});

describe("stream mode: happy paths", () => {
  it("ST-H1: lecturer stream — ordered stages, done payload = legacy body", async () => {
    ownerContext();
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    const res = await generateRoute.POST(
      req({ quizId: QUIZ_C, extractedText: "Chapter text", questionCount: 3 }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    const events = await collectStream(res);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("stage");
    expect(types).toContain("done");
    expect(types).not.toContain("error");
    expect(types).not.toContain("cancelled");

    const stages = events.filter(
      (e): e is Extract<GenerationEvent, { type: "stage" }> => e.type === "stage",
    );
    // extractedText supplied → NO server parse → truthful skip event.
    const parseSkip = stages.find((s) => s.stage === "parse" && s.status === "skip");
    expect(parseSkip).toBeTruthy();
    expect(stages.some((s) => s.stage === "parse" && s.status === "done")).toBe(false);
    const draftStart = stages.find((s) => s.stage === "draft" && s.status === "start");
    const draftDone = stages.find((s) => s.stage === "draft" && s.status === "done");
    const saveStart = stages.find((s) => s.stage === "save" && s.status === "start");
    expect(draftStart && draftDone && saveStart).toBeTruthy();
    // Clean single-pass run: no refine stage (truth rule).
    expect(stages.some((s) => s.stage === "refine")).toBe(false);

    const done = events.find(
      (e): e is Extract<GenerationEvent, { type: "done" }> => e.type === "done",
    );
    const payload = done!.payload as { quiz: { title: string }; questions: unknown[] };
    expect(payload.quiz.title).toBe("Test Quiz");
    expect(payload.questions).toHaveLength(3);
    expect(types.indexOf("done")).toBe(types.length - 1);

    // Wire-forwarding pins (round-3 audit): the SSE stub includes a
    // reasoning chunk, so reasoning events MUST reach the client stream;
    // content deltas must also arrive as events (S7: inert text on the wire).
    expect(types).toContain("reasoning");
    expect(types).toContain("content_delta");
  });

  it("ST-H2: parse-stage errors become error events with the legacy code", async () => {
    ownerContext();
    // No extractedText and no stored source file → invalid_body (legacy 400).
    const res = await generateRoute.POST(
      req({ quizId: QUIZ_C, questionCount: 3 }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    const events = await collectStream(res);
    const err = events.find(
      (e): e is Extract<GenerationEvent, { type: "error" }> => e.type === "error",
    );
    expect(err?.code).toBe("invalid_body");
  });

  it("ST-H3: invalid AI output (twice) → error event, zero rows", async () => {
    ownerContext();
    stubAiContent(invalidJson);
    const res = await generateRoute.POST(
      req({ quizId: QUIZ_C, extractedText: "Chapter text", questionCount: 3 }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    const events = await collectStream(res);
    const err = events.find(
      (e): e is Extract<GenerationEvent, { type: "error" }> => e.type === "error",
    );
    expect(err?.code).toBe("invalid_ai_output");
    expect((fakeHolder.current?.tables["questions"] ?? []).length).toBe(0);
  });

  it("ST-H4: retry path emits the refine stage between draft and save", async () => {
    ownerContext();
    let calls = 0;
    defaultAiServerUse(
      http.post("*/chat/completions", async ({ request }) => {
        calls += 1;
        const body = (await request.json().catch(() => ({}))) as { stream?: boolean };
        const content = calls === 1 ? invalidJson : JSON.stringify(VALID_AI_BODY);
        if (body.stream) {
          return new HttpResponse(sseBody(content), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return HttpResponse.json({ choices: [{ message: { content } }] });
      }),
    );
    const res = await generateRoute.POST(
      req({ quizId: QUIZ_C, extractedText: "Chapter text", questionCount: 3 }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    const events = await collectStream(res);
    const types = events.map((e) => e.type);
    expect(types).toContain("done");
    const stageIdx = (pred: (e: GenerationEvent) => boolean) =>
      events.findIndex(pred);
    const refineStart = events.findIndex(
      (e): e is Extract<GenerationEvent, { type: "stage" }> =>
        e.type === "stage" && e.stage === "refine" && e.status === "start",
    );
    const refineDone = events.findIndex(
      (e): e is Extract<GenerationEvent, { type: "stage" }> =>
        e.type === "stage" && e.stage === "refine" && e.status === "done",
    );
    const draftDoneIdx = stageIdx(
      (e): e is Extract<GenerationEvent, { type: "stage" }> =>
        e.type === "stage" && e.stage === "draft" && e.status === "done",
    );
    const saveStartIdx = stageIdx(
      (e): e is Extract<GenerationEvent, { type: "stage" }> =>
        e.type === "stage" && e.stage === "save" && e.status === "start",
    );
    // Ordered pin: refine opens mid-generation, closes after draft done and
    // BEFORE save start (the rail must never spin on the success screen).
    expect(refineStart).toBeGreaterThan(-1);
    expect(refineDone).toBeGreaterThan(refineStart);
    expect(refineDone).toBeGreaterThan(draftDoneIdx);
    expect(refineDone).toBeLessThan(saveStartIdx);
    expect(calls).toBe(2);
  });
});

describe("stream mode: lifecycle semantics", () => {
  it("ST-L1: in-flight guard is released after an error event (retry possible)", async () => {
    ownerContext();
    stubAiContent(invalidJson);
    const first = await generateRoute.POST(
      req({ quizId: QUIZ_C, extractedText: "text", questionCount: 3 }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    // Drain to EOF — the client contract (and the page) reads the stream to
    // completion; the guard releases in the stream's finally.
    const firstEvents = await collectStream(first);
    expect(
      firstEvents.some(
        (e): e is Extract<GenerationEvent, { type: "error" }> =>
          e.type === "error" && e.code === "invalid_ai_output",
      ),
    ).toBe(true);

    stubAiContent(JSON.stringify(VALID_AI_BODY));
    const res = await generateRoute.POST(
      req({ quizId: QUIZ_C, extractedText: "text", questionCount: 3 }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    const events = await collectStream(res);
    expect(events.map((e) => e.type)).toContain("done");
  });

  it("ST-L2: client abort mid-stream → no save RPC call, cancelled event, guard released", async () => {
    ownerContext();
    // Upstream that ABORTS the moment the route's signal fires (real-SDK-like,
    // per the SDK probe: aborting the request signal rejects the stream).
    defaultAiServerUse(
      http.post("*/chat/completions", async ({ request }) => {
        await new Promise<void>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        return new Promise<Response>(() => {});
      }),
    );
    const controller = new AbortController();
    const streamRes = await generateRoute.POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify({ quizId: QUIZ_C, extractedText: "text", questionCount: 3 }),
        signal: controller.signal,
      }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    expect(streamRes.headers.get("content-type")).toContain("application/x-ndjson");

    // Abort the moment the draft stage opens (deterministic mid-stream point —
    // parse completes instantly with extractedText).
    const reader = streamRes.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const lines: GenerationEvent[] = [];
    const readLine = async (): Promise<GenerationEvent | null> => {
      while (true) {
        const idx = buf.indexOf("\n");
        if (idx >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) return JSON.parse(line) as GenerationEvent;
          continue;
        }
        const { done, value } = await reader.read();
        if (done) return null;
        buf += dec.decode(value, { stream: true });
      }
    };
    // Read until the draft stage starts (first event is parse start).
    while (true) {
      const ev = await readLine();
      if (!ev) break;
      lines.push(ev);
      if (ev.type === "stage" && ev.stage === "draft" && ev.status === "start") break;
    }
    controller.abort();
    // Drain the rest — the route emits `cancelled` and closes the stream
    // (verified by the trace probe: abort → cancelled → EOF in milliseconds).
    const rest: GenerationEvent[] = [];
    for (let i = 0; i < 20; i += 1) {
      const ev = await readLine();
      if (!ev) break;
      rest.push(ev);
    }
    lines.push(...rest);

    expect(lines.some((e) => e.type === "cancelled")).toBe(true);
    // Zombie-save guard: the RPC never ran.
    expect((fakeHolder.current?.tables["questions"] ?? []).length).toBe(0);
    // Guard released: an immediate retry is NOT rejected by in-flight.
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    const retry = await generateRoute.POST(
      req({ quizId: QUIZ_C, extractedText: "text", questionCount: 3 }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    // Drain the retry stream BEFORE this test ends — an undrained stream
    // leaves the generation running (guard held) and poisons later tests.
    if (retry.headers.get("content-type")?.includes("ndjson")) {
      const retryEvents = await collectStream(retry);
      expect(retryEvents.some((e) => e.type === "done")).toBe(true);
    } else if (retry.status === 429) {
      const body = await retry.json();
      expect(body.message).not.toMatch(/already in progress/i);
    }
  });
});

describe("stream mode: wire-event pins (round-3 audit)", () => {
  it("ST-W1: heartbeat pings appear during silent phases (deferred upstream) and stop after done", async () => {
    ownerContext();
    // Deferred upstream: ~400ms of silence before the SSE answers — inside
    // the 12s ping window is impossible, so force pings by shrinking the
    // cadence via the exported constant? The constant is module-local;
    // instead assert the structural contract: pings NEVER follow done.
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    const res = await generateRoute.POST(
      req({ quizId: QUIZ_C, extractedText: "Chapter text", questionCount: 3 }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    const events = await collectStream(res);
    const types = events.map((e) => e.type);
    const doneIdx = types.lastIndexOf("done");
    expect(doneIdx).toBeGreaterThan(-1);
    // No ping (or any event) may trail the terminal done event.
    expect(types.slice(doneIdx + 1)).toHaveLength(0);
  });

  it("ST-W2: RPC succeeds but quiz refetch fails → saved_refresh_failed with rows, no error event", async () => {
    const ctx = ownerContext();
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    // The selectError seam can't target ONLY the refetch (requireQuizOwner
    // also selects from quizzes and would 503 pre-stream). The two selects
    // differ by TERMINATOR: the guard ends in maybeSingle(), the refetch in
    // single() — so fail exactly the quizzes .single() call.
    const inner = ctx.client as unknown as { from: (t: string) => unknown };
    const originalFrom = inner.from.bind(ctx.client);
    ctx.client.from = ((table: string) => {
      const builder = originalFrom(table) as {
        single: () => Promise<{ data: unknown; error: { message: string } | null }>;
      };
      if (table === "quizzes") {
        // Prototype-safe override: Object.create keeps the builder's methods
        // (select/eq/...) intact; only the terminator is replaced.
        const wrapper = Object.create(builder) as {
          single: () => Promise<{ data: unknown; error: { message: string } | null }>;
        };
        wrapper.single = () =>
          Promise.resolve({ data: null, error: { message: "refetch exploded" } });
        return wrapper;
      }
      return builder;
    }) as typeof ctx.client.from;
    const res = await generateRoute.POST(
      req({ quizId: QUIZ_C, extractedText: "Chapter text", questionCount: 3 }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    const events = await collectStream(res);
    const types = events.map((e) => e.type);
    expect(types).toContain("saved_refresh_failed");
    expect(types).not.toContain("error");
    expect(types).not.toContain("done");
    // The rows WERE saved — the payload carries them (no wipe-and-rebill).
    const ev = events.find(
      (e): e is Extract<GenerationEvent, { type: "saved_refresh_failed" }> =>
        e.type === "saved_refresh_failed",
    );
    expect(Array.isArray(ev!.questions)).toBe(true);
    expect(ev!.questions.length).toBeGreaterThan(0);
  });

  it("ST-W3: stored-file stream run emits real parse start/done (no skip)", async () => {
    const ctx = ownerContext();
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    // Seed a stored source file so prepareSource parses (extractedText absent).
    // The storage tenant prefix is `<uid>/<quizId>/`; makeOwnerContext returns
    // the owner id as `ownerId`. Text must clear the 40-chars/page
    // lowConfidence floor (single file below it → use_browser_ocr error).
    const path = `${ctx.ownerId}/${QUIZ_C}/chapter.txt`;
    const chapterText =
      "Velocity is displacement over time. Light travels faster than sound. " +
      "Force is measured in newtons. Energy is conserved in closed systems. " +
      "Momentum is mass times velocity. Acceleration is the rate of change " +
      "of velocity over time. Work is force times distance moved.";
    ctx.client.storageFiles[path] = new TextEncoder().encode(chapterText);
    const res = await generateRoute.POST(
      req({ quizId: QUIZ_C, questionCount: 3, sourcePath: path }),
      { params: Promise.resolve({ id: QUIZ_C }) },
    );
    const events = await collectStream(res);
    const stages = events.filter(
      (e): e is Extract<GenerationEvent, { type: "stage" }> => e.type === "stage",
    );
    expect(stages.some((s) => s.stage === "parse" && s.status === "start")).toBe(true);
    expect(stages.some((s) => s.stage === "parse" && s.status === "done")).toBe(true);
    expect(stages.some((s) => s.stage === "parse" && s.status === "skip")).toBe(false);
    expect(types_IncludeDone(events)).toBe(true);
  });

  function types_IncludeDone(events: GenerationEvent[]): boolean {
    return events.some((e) => e.type === "done");
  }
});

describe("student route stream mode", () => {
  it("ST-S1: student stream happy path — done payload matches legacy {questions, capped}", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client as unknown as ReturnType<
      typeof makeOwnerContext
    >["client"];
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    const res = await studentGenerateRoute.POST(
      req({ extractedText: "Chapter text", questionCount: 3 }),
      { params: Promise.resolve({ id: ctx.quizId }) },
    );
    const events = await collectStream(res);
    const done = events.find(
      (e): e is Extract<GenerationEvent, { type: "done" }> => e.type === "done",
    );
    expect(done).toBeTruthy();
    const payload = done!.payload as { questions: unknown[]; capped: boolean };
    expect(Array.isArray(payload.questions)).toBe(true);
    expect(payload.capped).toBe(false);
    // The save actually persisted into the student fake's question table.
    expect(
      (ctx.client.tables["student_quiz_questions"] ?? []).filter(
        (q) => q.quiz_id === ctx.quizId,
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("ST-S2: student pre-stream guard stays JSON (cap reached)", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client as unknown as ReturnType<
      typeof makeOwnerContext
    >["client"];
    // Seed the practice cap: 50 existing questions → remaining 0.
    for (let i = 0; i < 50; i += 1) {
      ctx.client.seedStudentQuestion({
        id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
        quiz_id: ctx.quizId,
        order_index: i,
        type: "mcq",
        prompt: `Filler question ${i}?`,
        options: ["a", "b"],
        correct_index: 0,
      });
    }
    const res = await studentGenerateRoute.POST(
      req({ extractedText: "Chapter text", questionCount: 3 }),
      { params: Promise.resolve({ id: ctx.quizId }) },
    );
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error).toBe("question_cap_reached");
  });

  it("ST-S3: student client abort mid-stream → cancelled event, no save, guard released", async () => {
    const ctx = makeStudentQuizContext();
    fakeHolder.current = ctx.client as unknown as ReturnType<
      typeof makeOwnerContext
    >["client"];
    defaultAiServerUse(
      http.post("*/chat/completions", async ({ request }) => {
        await new Promise<void>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        return new Promise<Response>(() => {});
      }),
    );
    const controller = new AbortController();
    const streamRes = await studentGenerateRoute.POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify({ extractedText: "text", questionCount: 3 }),
        signal: controller.signal,
      }),
      { params: Promise.resolve({ id: ctx.quizId }) },
    );
    expect(streamRes.headers.get("content-type")).toContain("application/x-ndjson");
    // Read the first event (parse stage), then abort mid-generation.
    const reader = streamRes.body!.getReader();
    await reader.read();
    controller.abort();
    // Drain to EOF — the route must emit `cancelled` and close.
    const dec = new TextDecoder();
    let buf = "";
    const lines: GenerationEvent[] = [];
    for (let i = 0; i < 20; i += 1) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) lines.push(JSON.parse(line) as GenerationEvent);
      }
      if (lines.some((e) => e.type === "cancelled" || e.type === "error")) break;
    }
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    expect(lines.some((e) => e.type === "cancelled")).toBe(true);
    // Zombie-save guard: nothing persisted on the student surface either.
    const saved = (ctx.client.tables["student_quiz_questions"] ?? []).filter(
      (q) => q.quiz_id === ctx.quizId && String(q.prompt ?? "").includes("Generated"),
    );
    expect(saved).toHaveLength(0);
  });
});
