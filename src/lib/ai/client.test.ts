import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chatCompletions } from "@/lib/ai/client";
import type OpenAI from "openai";

/**
 * Unit tests for chatCompletions (the OpenAI-compatible round-trip wrapper).
 * These exercise the timeout clamping, outer-abort, empty-response, and
 * temperature/jsonMode plumbing that the route tests only reach indirectly.
 */

type CreateFn = (opts: unknown, reqOpts?: { signal?: AbortSignal }) => Promise<{
  choices?: { message?: { content?: string } }[];
}>;

function makeClient(create: CreateFn): OpenAI {
  return {
    chat: {
      completions: {
        create,
      },
    },
  } as unknown as OpenAI;
}

describe("chatCompletions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the model text on success", async () => {
    const client = makeClient(async () => ({
      choices: [{ message: { content: "hello" } }],
    }));
    const res = await chatCompletions({
      client,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res).toEqual({ ok: true, text: "hello" });
  });

  it("returns ai_error on an empty model response", async () => {
    const client = makeClient(async () => ({ choices: [{ message: {} }] }));
    const res = await chatCompletions({
      client,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("ai_error");
  });

  it("clamps the per-call timeout to the smaller of timeoutMs and the 45s default", async () => {
    let capturedSignal: AbortSignal | undefined;
    const client = makeClient(async (_opts, reqOpts) => {
      capturedSignal = reqOpts?.signal;
      return new Promise((_resolve, reject) => {
        reqOpts?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    });
    const promise = chatCompletions({
      client,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    });
    // Advance past the clamped 5s (not the 45s default).
    await vi.advanceTimersByTimeAsync(6_000);
    const res = await promise;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("timeout");
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("aborts when the outer signal fires", async () => {
    const controller = new AbortController();
    const client = makeClient(async (_opts, reqOpts) => {
      return new Promise((_resolve, reject) => {
        reqOpts?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    });
    const promise = chatCompletions({
      client,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });
    controller.abort();
    const res = await promise;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("timeout");
  });

  it("passes temperature and jsonMode through to the provider", async () => {
    let captured: { temperature?: number; response_format?: unknown } | undefined;
    const client = makeClient(async (opts) => {
      captured = opts as { temperature?: number; response_format?: unknown };
      return { choices: [{ message: { content: "x" } }] };
    });
    await chatCompletions({
      client,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      jsonMode: false,
    });
    expect(captured?.temperature).toBe(0);
    expect(captured?.response_format).toBeUndefined();
  });
});
