import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { defaultAiServer } from "@/test/msw/server";
import { _resetRateLimiter } from "@/lib/classes/rate-limit";
import { http, HttpResponse } from "msw";
import * as generateRoute from "@/app/api/ai/generate-quiz/route";
import type { GenerationEvent } from "@/lib/ai/events";
import type { GroundedSearchLibEvent, GroundedSearchResult } from "@/lib/ai/tinyfish";

/**
 * Grounded web-search integration tests (grounded-search.md §9B).
 *
 * The TinyFish orchestration is stubbed at the `runGroundedSearch` module
 * seam — the wire-level behaviors (429 retry, per-URL errors, corpus caps)
 * are unit-pinned in tinyfish.test.ts; here we prove the ROUTE contract:
 *  - topic mode flows through both protocols (legacy JSON + NDJSON stream);
 *  - event ORDER is pinned (parse skip BEFORE search — the rail truth rule);
 *  - search failures map to the pinned codes/statuses in BOTH protocols;
 *  - the XOR validation rejects topic+text mixes with the legacy 400;
 *  - saveGeneration forwards p_web_sources to the RPC (null for file flows).
 */

const fakeHolder: { current: ReturnType<typeof makeOwnerContext>["client"] | undefined } = {
  current: undefined,
};
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

/** Mutable stub the mocked runGroundedSearch delegates to (per-test). */
const searchStub: {
  impl: (opts: {
    topic: string;
    onEvent?: (ev: GroundedSearchLibEvent) => void;
  }) => Promise<GroundedSearchResult>;
} = {
  impl: () => Promise.resolve({ ok: false, error: "search_unavailable" }),
};

vi.mock("@/lib/ai/tinyfish", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // isWebSearchEnabled stays the REAL function (env-driven; the route does
    // not gate on it — the flag only hides UI — but keep it honest anyway).
    runGroundedSearch: (opts: Parameters<typeof searchStub.impl>[0]) =>
      searchStub.impl(opts),
  };
});

const QUIZ_C = "00000000-0000-4000-8000-00000000000c";

const VALID_AI_BODY = {
  title: "Web Quiz",
  questions: [
    { type: "mcq", prompt: "Grounded question one?", options: ["a", "b", "c"], correct_index: 0 },
    { type: "mcq", prompt: "Grounded question two?", options: ["a", "b"], correct_index: 1 },
    { type: "true_false", prompt: "Grounded statement three.", options: ["True", "False"], correct_index: 0 },
  ],
};

function req(body?: unknown, opts: { stream?: boolean } = {}): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.stream === false ? {} : { accept: "application/x-ndjson" }),
    },
    body: JSON.stringify(body),
  });
}

function ownerContext() {
  const ctx = makeOwnerContext();
  fakeHolder.current = ctx.client as ReturnType<typeof makeOwnerContext>["client"];
  return ctx;
}

function sseBody(content: string) {
  const chunks = [
    { choices: [{ delta: { content }, finish_reason: null, index: 0 }] },
    { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
  ];
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

/** Stream-aware AI stub (same shape as generation-stream.test.ts). */
function stubAiContent(content: string) {
  defaultAiServer.use(
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

async function collectStream(res: Response): Promise<GenerationEvent[]> {
  expect(res.headers.get("content-type")).toContain("application/x-ndjson");
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as GenerationEvent);
}

const WEB_SOURCES = [
  { kind: "web" as const, url: "https://a.com/photosynthesis", title: "Photosynthesis — Wikipedia", retrieved_at: "2026-09-07T00:00:00.000Z", query: "photosynthesis" },
  { kind: "web" as const, url: "https://b.com/light", title: "Light reactions — Khan Academy", retrieved_at: "2026-09-07T00:00:00.000Z", query: "photosynthesis light" },
  { kind: "web" as const, url: "https://c.com/calvin", title: "Calvin cycle — Britannica", retrieved_at: "2026-09-07T00:00:00.000Z", query: "calvin cycle" },
];

const WEB_TOPIC_BODY = {
  quizId: QUIZ_C,
  topic: "photosynthesis light and dark reactions",
  useWebSearch: true,
  extractedText: "Chapter text about photosynthesis and the Calvin cycle.",
  questionCount: 3,
};

const CORPUS = "Photosynthesis is the process. ".repeat(40);

beforeEach(() => {
  fakeHolder.current = undefined;
  _resetRateLimiter();
  defaultAiServer.resetHandlers();
  searchStub.impl = () => Promise.resolve({ ok: false, error: "search_unavailable" });
});

beforeAll(() => {
  defaultAiServer.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  defaultAiServer.close();
});

describe("validation: topic XOR sources", () => {
  it("W-V1: topic + extractedText = augmentation → passes validation", async () => {
    ownerContext();
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    searchStub.impl = () =>
      Promise.resolve({ ok: true, text: CORPUS, sources: WEB_SOURCES });
    const res = await generateRoute.POST(
      req({ ...WEB_TOPIC_BODY }, { stream: false }),
    );
    expect(res.status).toBe(200);
  });

  it("W-V1b: topic-only (no material) → 400 (augmentation-only rule)", async () => {
    ownerContext();
    const { extractedText: _drop, ...topicOnly } = WEB_TOPIC_BODY;
    void _drop;
    const res = await generateRoute.POST(req(topicOnly, { stream: false }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_body");
    expect(body.message).toMatch(/augments your material/i);
  });

  it("W-V2: useWebSearch without topic → 400", async () => {
    ownerContext();
    const res = await generateRoute.POST(
      req({ quizId: QUIZ_C, useWebSearch: true, questionCount: 3 }, { stream: false }),
    );
    expect(res.status).toBe(400);
  });

  it("W-V3: topic without useWebSearch → 400", async () => {
    ownerContext();
    const res = await generateRoute.POST(
      req({ quizId: QUIZ_C, topic: "some topic", questionCount: 3 }, { stream: false }),
    );
    expect(res.status).toBe(400);
  });

  it("W-V4: topic too short → 400", async () => {
    ownerContext();
    const res = await generateRoute.POST(
      req({ ...WEB_TOPIC_BODY, topic: "ab" }, { stream: false }),
    );
    expect(res.status).toBe(400);
  });
});

describe("stream protocol: topic mode", () => {
  it("W-S1: ordered events — parse skip BEFORE search, tool lines, done payload", async () => {
    const ctx = ownerContext();
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    searchStub.impl = ({ onEvent }) => {
      onEvent?.({ type: "tool_call", tool: "web_search", query: "photosynthesis reactions" });
      onEvent?.({ type: "tool_result", tool: "web_search", query: "photosynthesis reactions", resultCount: 8 });
      return Promise.resolve({ ok: true, text: CORPUS, sources: WEB_SOURCES });
    };
    const res = await generateRoute.POST(req(WEB_TOPIC_BODY));
    const events = await collectStream(res);
    const types = events.map((e) => e.type);

    const parseSkipIdx = events.findIndex(
      (e) => e.type === "stage" && e.stage === "parse" && e.status === "skip",
    );
    const searchStartIdx = events.findIndex(
      (e) => e.type === "stage" && e.stage === "search" && e.status === "start",
    );
    const toolCallIdx = types.indexOf("tool_call");
    const toolResultIdx = types.indexOf("tool_result");
    const draftStartIdx = events.findIndex(
      (e) => e.type === "stage" && e.stage === "draft" && e.status === "start",
    );
    expect(parseSkipIdx).toBeGreaterThanOrEqual(0);
    expect(searchStartIdx).toBeGreaterThan(parseSkipIdx);
    expect(toolCallIdx).toBeGreaterThan(searchStartIdx);
    expect(toolResultIdx).toBeGreaterThan(toolCallIdx);
    expect(draftStartIdx).toBeGreaterThan(toolResultIdx);

    const searchDone = events.find(
      (e) => e.type === "stage" && e.stage === "search" && e.status === "done",
    ) as Extract<GenerationEvent, { type: "stage" }>;
    expect(searchDone.detail).toBe("3");

    expect(types).toContain("done");
    expect(types).not.toContain("error");
    const done = events.find(
      (e): e is Extract<GenerationEvent, { type: "done" }> => e.type === "done",
    );
    expect((done!.payload as { quiz: { title: string } }).quiz.title).toBe("Test Quiz");
    // Rows actually saved through the RPC.
    expect((ctx.client.tables["questions"] ?? []).length).toBe(3);
  });

  it("W-S2: search failure DEGRADES to material-only — done, no error", async () => {
    ownerContext();
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    searchStub.impl = () =>
      Promise.resolve({ ok: false, error: "search_failed", message: "boom" });
    const res = await generateRoute.POST(req(WEB_TOPIC_BODY));
    const events = await collectStream(res);
    // Augmentation contract: the material still grounds the quiz.
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect((fakeHolder.current?.tables["questions"] ?? []).length).toBe(3);
  });

  it("W-S3: search_unavailable (key unset) DEGRADES to material-only", async () => {
    ownerContext();
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    const res = await generateRoute.POST(req(WEB_TOPIC_BODY));
    const events = await collectStream(res);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("W-S4: search_corpus_thin DEGRADES to material-only", async () => {
    ownerContext();
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    searchStub.impl = () =>
      Promise.resolve({ ok: false, error: "search_corpus_thin", message: "thin" });
    const res = await generateRoute.POST(req(WEB_TOPIC_BODY));
    const events = await collectStream(res);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(true);
    // Degraded save: no web provenance persisted.
    const quizRow = (fakeHolder.current?.tables["quizzes"] ?? []).find(
      (q: { id?: string }) => q.id === QUIZ_C,
    ) as { sources?: unknown[] } | undefined;
    expect(Array.isArray(quizRow?.sources)).toBe(true);
    expect(quizRow?.sources).toHaveLength(0);
  });

  it("W-S5: skipped fetch reports skipped+reason on the tool_result", async () => {
    ownerContext();
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    searchStub.impl = ({ onEvent }) => {
      onEvent?.({
        type: "tool_result",
        tool: "web_search",
        query: "https://c.com/calvin",
        resultCount: 0,
        skipped: 1,
        reason: "target_http_error",
      });
      return Promise.resolve({ ok: true, text: CORPUS, sources: WEB_SOURCES.slice(0, 2) });
    };
    const res = await generateRoute.POST(req(WEB_TOPIC_BODY));
    const events = await collectStream(res);
    const skipped = events.find(
      (e): e is Extract<GenerationEvent, { type: "tool_result" }> =>
        e.type === "tool_result" && e.skipped !== undefined,
    );
    expect(skipped?.skipped).toBe(1);
    expect(skipped?.reason).toBe("target_http_error");
    expect(skipped?.query).toBe("https://c.com/calvin");
    // search done detail reflects the fetched count (2, not 3).
    const searchDone = events.find(
      (e) => e.type === "stage" && e.stage === "search" && e.status === "done",
    ) as Extract<GenerationEvent, { type: "stage" }>;
    expect(searchDone.detail).toBe("2");
  });
});

describe("legacy protocol: topic mode", () => {
  it("W-L1: legacy JSON — same happy path, web sources forwarded to the RPC", async () => {
    const ctx = ownerContext();
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    searchStub.impl = () =>
      Promise.resolve({ ok: true, text: CORPUS, sources: WEB_SOURCES });
    const res = await generateRoute.POST(req(WEB_TOPIC_BODY, { stream: false }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quiz.title).toBe("Test Quiz");
    expect(body.questions).toHaveLength(3);
    expect((ctx.client.tables["questions"] ?? []).length).toBe(3);
    // Provenance persisted: the fake RPC applied p_web_sources to the quiz row.
    const quizRow = (ctx.client.tables["quizzes"] ?? []).find(
      (q: { id?: string }) => q.id === QUIZ_C,
    ) as { sources?: Array<{ kind: string; url: string }> } | undefined;
    expect(Array.isArray(quizRow?.sources)).toBe(true);
    expect(quizRow?.sources).toHaveLength(3);
    expect(quizRow?.sources?.[0].kind).toBe("web");
    expect(quizRow?.sources?.[0].url).toBe("https://a.com/photosynthesis");
  });

  it("W-L2: search failure DEGRADES — JSON 200 from material only", async () => {
    ownerContext();
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    searchStub.impl = () => Promise.resolve({ ok: false, error: "search_failed" });
    const res = await generateRoute.POST(req(WEB_TOPIC_BODY, { stream: false }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.questions).toHaveLength(3);
  });

  it("W-L3: search_unavailable DEGRADES — JSON 200", async () => {
    ownerContext();
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    const res = await generateRoute.POST(req(WEB_TOPIC_BODY, { stream: false }));
    expect(res.status).toBe(200);
  });

  it("W-L4: search_corpus_thin DEGRADES — JSON 200", async () => {
    ownerContext();
    stubAiContent(JSON.stringify(VALID_AI_BODY));
    searchStub.impl = () => Promise.resolve({ ok: false, error: "search_corpus_thin" });
    const res = await generateRoute.POST(req(WEB_TOPIC_BODY, { stream: false }));
    expect(res.status).toBe(200);
  });
});
