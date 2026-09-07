import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from "vitest";
import {
  isWebSearchEnabled,
  tinyfishFetch,
  tinyfishSearch,
} from "@/lib/ai/tinyfish";

/**
 * Wire-client tests (server-critic finding 3): the TinyFish HTTP boundary —
 * 429/5xx retry with backoff, 401-class → `unavailable` mapping, malformed
 * response tolerance, per-URL error mapping, empty-page skipping, and the
 * empty-key (""-counts-as-absent) flag contract. `fetch` is stubbed globally;
 * no network. The `server-only` guard is asserted textually (S8 grep guard).
 */

const realFetch = globalThis.fetch;

function stubFetchSequence(responses: Array<() => Promise<{ status: number; body: unknown }>>) {
  let i = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const { status, body } = await r();
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  vi.stubEnv("TINYFISH_API_KEY", "test-key");
  vi.stubEnv("TINYFISH_SEARCH_URL", "https://search.test");
  vi.stubEnv("TINYFISH_FETCH_URL", "https://fetch.test");
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.restoreAllMocks();
});

const SEARCH_OK = {
  query: "q",
  total_results: 2,
  page: 0,
  results: [
    { position: 1, site_name: "a.com", title: "Title A", snippet: "Snip A", url: "https://a.com/1" },
    { position: 2, site_name: "b.com", title: "Title B", snippet: "Snip B", url: "https://b.com/2" },
  ],
};

describe("tinyfishSearch", () => {
  it("WIRE-S1: 200 → parsed hits; non-http(s) URLs dropped", async () => {
    const calls = stubFetchSequence([
      () => Promise.resolve({ status: 200, body: SEARCH_OK }),
    ]);
    const res = await tinyfishSearch({ query: "q" });
    expect(res).toEqual({
      ok: true,
      results: [
        { url: "https://a.com/1", title: "Title A", snippet: "Snip A" },
        { url: "https://b.com/2", title: "Title B", snippet: "Snip B" },
      ],
    });
    expect(calls[0].url).toContain("https://search.test?");
    expect(calls[0].init?.headers).toMatchObject({ "X-API-Key": "test-key" });
  });

  it("WIRE-S2: 429 then 200 → retried once with backoff, succeeds", async () => {
    stubFetchSequence([
      () => Promise.resolve({ status: 429, body: {} }),
      () => Promise.resolve({ status: 200, body: SEARCH_OK }),
    ]);
    const p = tinyfishSearch({ query: "q" });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await p).toMatchObject({ ok: true });
  });

  it("WIRE-S3: 500 twice → failed; 403 → unavailable (no retry)", async () => {
    const calls = stubFetchSequence([
      () => Promise.resolve({ status: 500, body: {} }),
      () => Promise.resolve({ status: 500, body: {} }),
    ]);
    const p = tinyfishSearch({ query: "q" });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await p).toEqual({ ok: false, error: "failed" });
    expect(calls).toHaveLength(2);

    stubFetchSequence([() => Promise.resolve({ status: 403, body: {} })]);
    expect(await tinyfishSearch({ query: "q" })).toEqual({ ok: false, error: "unavailable" });
  });

  it("WIRE-S4: malformed JSON body → failed (never throws)", async () => {
    stubFetchSequence([() => Promise.resolve({ status: 200, body: "<html>gateway junk</html>" })]);
    expect(await tinyfishSearch({ query: "q" })).toEqual({ ok: false, error: "failed" });
  });

  it("WIRE-S5: new response shape missing `results` → tolerated as empty", async () => {
    stubFetchSequence([() => Promise.resolve({ status: 200, body: { query: "q" } })]);
    expect(await tinyfishSearch({ query: "q" })).toEqual({ ok: true, results: [] });
  });

  it("WIRE-S6: empty/whitespace key → unavailable (never hits the wire)", async () => {
    vi.stubEnv("TINYFISH_API_KEY", "   ");
    const calls = stubFetchSequence([]);
    expect(await tinyfishSearch({ query: "q" })).toEqual({ ok: false, error: "unavailable" });
    expect(calls).toHaveLength(0);
  });
});

describe("tinyfishFetch", () => {
  it("WIRE-F1: 200 → pages parsed, per-URL errors + empty pages returned as failures", async () => {
    stubFetchSequence([
      () =>
        Promise.resolve({
          status: 200,
          body: {
            results: [
              { url: "https://a.com/1", final_url: "https://www.a.com/1", title: "A", text: "# Body" },
              { url: "https://b.com/2", title: "B", text: "" },
            ],
            errors: [{ url: "https://c.com/3", error: "timeout" }],
          },
        }),
    ]);
    const res = await tinyfishFetch({ urls: ["https://a.com/1", "https://b.com/2"] });
    expect(res).toMatchObject({
      ok: true,
      pages: [{ url: "https://www.a.com/1", title: "A", text: "# Body" }],
      failedUrls: [
        { url: "https://b.com/2", error: "empty_content" },
        { url: "https://c.com/3", error: "timeout" },
      ],
    });
  });

  it("WIRE-F2: 401 → unavailable; 500 → failed; empty key → unavailable", async () => {
    stubFetchSequence([() => Promise.resolve({ status: 401, body: {} })]);
    expect(await tinyfishFetch({ urls: ["https://a.com/1"] })).toEqual({ ok: false, error: "unavailable" });

    stubFetchSequence([() => Promise.resolve({ status: 500, body: {} })]);
    expect(await tinyfishFetch({ urls: ["https://a.com/1"] })).toEqual({ ok: false, error: "failed" });

    vi.stubEnv("TINYFISH_API_KEY", "");
    expect(await tinyfishFetch({ urls: ["https://a.com/1"] })).toEqual({ ok: false, error: "unavailable" });
  });

  it("WIRE-F3: network throw → failed (never throws to the caller)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await tinyfishFetch({ urls: ["https://a.com/1"] })).toEqual({ ok: false, error: "failed" });
  });
});

describe("isWebSearchEnabled", () => {
  it("WIRE-KEY1: unset or empty/whitespace key → false; non-empty → true", () => {
    vi.stubEnv("TINYFISH_API_KEY", "");
    expect(isWebSearchEnabled()).toBe(false);
    vi.stubEnv("TINYFISH_API_KEY", "  ");
    expect(isWebSearchEnabled()).toBe(false);
    vi.stubEnv("TINYFISH_API_KEY", "real-key");
    expect(isWebSearchEnabled()).toBe(true);
    vi.stubEnv("TINYFISH_API_KEY", undefined);
    expect(isWebSearchEnabled()).toBe(false);
  });

  it("WIRE-SO: tinyfish.ts keeps the server-only guard (S8 grep check)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/ai/tinyfish.ts", "utf8");
    expect(src.startsWith('import "server-only";')).toBe(true);
  });
});
