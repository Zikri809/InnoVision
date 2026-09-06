import { describe, it, expect, vi } from "vitest";
import { chatStream, type StreamDelta } from "@/lib/ai/client";
import type OpenAI from "openai";

/**
 * U-ST (Phase 1.5) — the upstream streaming client.
 *
 * The OpenAI SDK is faked at the `chat.completions.create` boundary: the fake
 * returns an async-iterable of chunks (exactly what `stream: true` consumes).
 * Coverage targets the behaviors the wire contract depends on: reasoning
 * passthrough, tool-call fragment accumulation across chunk boundaries,
 * finish_reason handling (stop / length / reasoning-ate-budget), the three
 * distinct abort reasons (deadline / idle / cancelled), and onDelta forwarding.
 */

type FakeChunk = {
  choices: Array<{
    delta: Record<string, unknown>;
    finish_reason: string | null;
    index: number;
  }>;
};

function fakeClient(chunks: FakeChunk[], opts: { throwOnIterate?: Error } = {}) {
  const create = vi.fn().mockImplementation(async () => {
    if (opts.throwOnIterate) {
      return {
        async *[Symbol.asyncIterator]() {
          throw opts.throwOnIterate!;
        },
      };
    }
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  });
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, create };
}

const USER = [{ role: "user" as const, content: "hi" }];

describe("chatStream — happy paths", () => {
  it("U-ST1: buffers content, forwards reasoning + content deltas, returns stop", async () => {
    const { client, create } = fakeClient([
      { choices: [{ delta: { reasoning_content: "think " }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: { content: '{"a"' }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: { content: ":1}" }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
    ]);
    const deltas: StreamDelta[] = [];
    const res = await chatStream({
      client,
      model: "test",
      messages: USER,
      idleTimeoutMs: 0,
      onDelta: (d) => deltas.push(d),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe('{"a":1}');
    expect(res.reasoningText).toBe("think ");
    expect(res.finishReason).toBe("stop");
    expect(deltas.map((d) => d.content).join("")).toBe('{"a":1}');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true, model: "test" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("U-ST2: falls back to the `reasoning` twin when reasoning_content is absent", async () => {
    const { client } = fakeClient([
      { choices: [{ delta: { reasoning: "twin only" }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: { content: "ok" }, finish_reason: "stop", index: 0 }] },
    ]);
    const res = await chatStream({ client, model: "test", messages: USER, idleTimeoutMs: 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reasoningText).toBe("twin only");
  });

  it("U-ST3: accumulates tool_call fragments across chunks by index", async () => {
    const { client } = fakeClient([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "calc", arguments: '{"expr"' } }] }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"2+2}' } }] }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_2", function: { name: "calc", arguments: '{"expr":"1+1}' } }] }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
    ]);
    const res = await chatStream({ client, model: "test", messages: USER, idleTimeoutMs: 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls[0]).toEqual({
      index: 0,
      id: "call_1",
      name: "calc",
      arguments: '{"expr":"2+2}',
    });
    // Content-less tool-call stream is still a success (loop continues).
    expect(res.text).toBe("");
  });
});

describe("chatStream — reasoning-only salvage (Kenari/GLM live behavior)", () => {
  // Real observed shape (2026-09): GLM streamed the COMPLETE quiz JSON into
  // the reasoning channel and ended with content empty + finish_reason "stop"
  // — previously a hard "budget exhausted" failure.
  const QUIZ_JSON = '{"title":"Java Exception Handling Quiz","questions":[{"type":"mcq","prompt":"Q?","options":["a","b","c","d"],"correct_index":0,"explanation":"because"}]}';

  it("U-ST9: full JSON in reasoning with empty content is salvaged as the answer", async () => {
    const { client } = fakeClient([
      { choices: [{ delta: { reasoning_content: "Let me draft the quiz.\n" }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: { reasoning_content: QUIZ_JSON }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
    ]);
    const res = await chatStream({ client, model: "test", messages: USER, idleTimeoutMs: 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe(QUIZ_JSON);
    expect(res.finishReason).toBe("stop");
  });

  it("U-ST10: token-fragmented JSON across many reasoning deltas coalesces into one salvage", async () => {
    const fragSize = 7;
    const frags: string[] = [];
    for (let i = 0; i < QUIZ_JSON.length; i += fragSize) frags.push(QUIZ_JSON.slice(i, i + fragSize));
    const { client } = fakeClient([
      ...frags.map((f) => ({ choices: [{ delta: { reasoning: f }, finish_reason: null, index: 0 }] })),
      { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
    ]);
    const res = await chatStream({ client, model: "test", messages: USER, idleTimeoutMs: 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe(QUIZ_JSON);
  });

  it("U-ST11: abandoned draft then final object → the LAST parseable object wins", async () => {
    const draft = '{"title":"draft';
    const { client } = fakeClient([
      { choices: [{ delta: { reasoning_content: `trying ${draft}` }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: { reasoning_content: " …nah. Final:\n" }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: { reasoning_content: QUIZ_JSON }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
    ]);
    const res = await chatStream({ client, model: "test", messages: USER, idleTimeoutMs: 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe(QUIZ_JSON);
  });

  it("U-ST12: braces inside JSON strings survive the balance scan", async () => {
    const tricky = '{"title":"curly } and { inside","questions":[]}';
    const { client } = fakeClient([
      { choices: [{ delta: { reasoning_content: tricky }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
    ]);
    const res = await chatStream({ client, model: "test", messages: USER, idleTimeoutMs: 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe(tricky);
  });

  it("U-ST13: reasoning with NO parseable JSON keeps the budget-exhausted failure (U-ST5 unchanged)", async () => {
    const { client } = fakeClient([
      { choices: [{ delta: { reasoning_content: "thinking forever, never a brace" }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
    ]);
    const res = await chatStream({ client, model: "test", messages: USER, idleTimeoutMs: 0 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("ai_error");
    expect(res.message).toMatch(/budget/);
  });
});

describe("chatStream — truncation & empty", () => {
  it("U-ST4: finish_reason=length maps to a truncation error carrying finishReason", async () => {
    const { client } = fakeClient([
      { choices: [{ delta: { content: '{"partial"' }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: "length", index: 0 }] },
    ]);
    const res = await chatStream({ client, model: "test", messages: USER, idleTimeoutMs: 0 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("ai_error");
    expect(res.message).toMatch(/truncated/i);
    expect(res.finishReason).toBe("length");
  });

  it("U-ST5: reasoning with NO content → distinct budget-exhausted signature", async () => {
    const { client } = fakeClient([
      { choices: [{ delta: { reasoning_content: "thinking forever " }, finish_reason: null, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
    ]);
    const res = await chatStream({ client, model: "test", messages: USER, idleTimeoutMs: 0 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("ai_error");
    expect(res.message).toMatch(/budget/);
  });
});

describe("chatStream — abort reasons", () => {
  it("U-ST6: caller-signal abort → 'cancelled' (distinct from timeout)", async () => {
    // A never-ending iterator: the abort must cut iteration and return
    // 'cancelled' — NOT the generic timeout mapping the legacy path used.
    let release: (() => void) | undefined;
    const create = vi.fn().mockImplementation(async () => {
      return (async function* () {
        yield { choices: [{ delta: { reasoning_content: "start" }, finish_reason: null, index: 0 }] };
        await new Promise<void>((r) => (release = r)); // hangs until abort resolves it
      })();
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    const outer = new AbortController();
    const p = chatStream({
      client,
      model: "test",
      messages: USER,
      timeoutMs: 30_000,
      idleTimeoutMs: 0,
      signal: outer.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    outer.abort();
    release?.();
    const res = await p;
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("cancelled");
  });

  it("U-ST7: idle (inter-chunk silence) abort → 'timeout' with the silent-stream message", async () => {
    const create = vi.fn().mockImplementation(
      async (_body: unknown, init: { signal: AbortSignal }) => {
        const signal = init.signal;
        return (async function* () {
          yield { choices: [{ delta: { reasoning_content: "one" }, finish_reason: null, index: 0 }] };
          // Realistic SDK emulation: aborting the request rejects the stream.
          await new Promise<void>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("Request was aborted.")), { once: true });
          });
        })();
      },
    );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const res = await chatStream({
      client,
      model: "test",
      messages: USER,
      idleTimeoutMs: 30,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("timeout");
    expect(res.message).toMatch(/silent/i);
  }, 10_000);
});

describe("chatStream — upstream failure", () => {
  it("U-ST8: an iterator that throws mid-stream → ai_error, not timeout", async () => {
    const { client } = fakeClient([], { throwOnIterate: new Error("connection reset") });
    const res = await chatStream({ client, model: "test", messages: USER, idleTimeoutMs: 0 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("ai_error");
    expect(res.message).toMatch(/connection reset/);
  });
});
