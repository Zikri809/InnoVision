import { describe, it, expect, vi } from "vitest";
import {
  ZAI_AUTH_CODES,
  ZAI_RETRYABLE_CODES,
  httpChatCompletions,
  httpLayoutParsing,
  probeGlmModel,
} from "@/lib/ai/http-compat";

describe("httpChatCompletions — browser-only OpenAI-compatible chat", () => {
  it("returns ok with content on a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "hello" } }],
        }),
      }),
    );
    const r = await httpChatCompletions({
      baseUrl: "http://localhost:11434",
      model: "glm-ocr",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("hello");
    vi.unstubAllGlobals();
  });

  it("returns http_error on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const r = await httpChatCompletions({
      baseUrl: "http://localhost:11434",
      model: "glm-ocr",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("http_error");
    vi.unstubAllGlobals();
  });

  it("returns http_error on fetch rejection (network)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const r = await httpChatCompletions({
      baseUrl: "http://localhost:11434",
      model: "glm-ocr",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("http_error");
    vi.unstubAllGlobals();
  });

  it("returns timeout when the abort fires", async () => {
    // Use a fetch that DOES observe the signal and rejects on abort — mirrors
    // real Node fetch behavior so the abort path is exercised.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      ),
    );
    const r = await httpChatCompletions({
      baseUrl: "http://localhost:11434",
      model: "glm-ocr",
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 10,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("timeout");
    vi.unstubAllGlobals();
  });

  it("returns ai_error when content is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { role: "assistant", content: "" } }] }),
      }),
    );
    const r = await httpChatCompletions({
      baseUrl: "http://localhost:11434",
      model: "glm-ocr",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("ai_error");
    vi.unstubAllGlobals();
  });
});

describe("probeGlmModel — GLM-OCR availability probe", () => {
  it("returns true when the model is listed (with :tag suffix)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "glm-ocr:latest" }] }),
      }),
    );
    const ok = await probeGlmModel({ baseUrl: "http://localhost:11434", model: "glm-ocr" });
    expect(ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it("returns true on an exact model name match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "glm-ocr" }] }),
      }),
    );
    const ok = await probeGlmModel({ baseUrl: "http://localhost:11434", model: "glm-ocr" });
    expect(ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it("returns false on connection error (ECONNREFUSED)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("ECONNREFUSED")));
    const ok = await probeGlmModel({ baseUrl: "http://127.0.0.1:1", model: "glm-ocr" });
    expect(ok).toBe(false);
    vi.unstubAllGlobals();
  });

  it("returns false on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const ok = await probeGlmModel({ baseUrl: "http://localhost:11434", model: "glm-ocr" });
    expect(ok).toBe(false);
    vi.unstubAllGlobals();
  });

  it("returns false on an empty model list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }),
    );
    const ok = await probeGlmModel({ baseUrl: "http://localhost:11434", model: "glm-ocr" });
    expect(ok).toBe(false);
    vi.unstubAllGlobals();
  });

  it("returns false when the timeout fires (signal-aborted fetch)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      ),
    );
    const ok = await probeGlmModel({ baseUrl: "http://localhost:11434", model: "glm-ocr", timeoutMs: 10 });
    expect(ok).toBe(false);
    vi.unstubAllGlobals();
  });
});

/**
 * httpLayoutParsing — the REMOTE (Z.ai) shaper.
 *
 * Contract §3.4 defines a strict precedence order and gate G9 exists because
 * PaaS commonly rides errors on HTTP 200. Every branch below is asserted
 * individually: a regression in the ORDER (not just in a branch) is what
 * silently turns a dead key into a retry storm or a truncated document into a
 * success. Tests use the `fetchImpl` seam so each response is exact.
 */
describe("httpLayoutParsing — request shape", () => {
  const OK_BODY = {
    code: 0,
    md_results: "# Page one\n\ntext",
    layout_details: [[{ page: 1 }]],
    data_info: { num_pages: 12 },
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };

  function captureFetch(body: unknown, status = 200) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("POSTs to {root}/layout_parsing with the model + file + request_id", async () => {
    const { calls, fetchImpl } = captureFetch(OK_BODY);
    const res = await httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4",
      model: "glm-ocr",
      apiKey: "secret-key",
      fileDataUrl: "data:image/png;base64,AAAA",
      requestId: "req-1",
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.z.ai/api/paas/v4/layout_parsing");
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-key");
    expect(headers["content-type"]).toBe("application/json");
    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent).toEqual({
      model: "glm-ocr",
      file: "data:image/png;base64,AAAA",
      request_id: "req-1",
    });
  });

  it("NEVER sends start_page_id / end_page_id / user_id / crop flags (gate G10)", async () => {
    const { calls, fetchImpl } = captureFetch(OK_BODY);
    await httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4",
      model: "glm-ocr",
      fileDataUrl: "data:application/pdf;base64,JVBERi0=",
      requestId: "req-2",
      fetchImpl,
    });
    const sent = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    for (const banned of [
      "start_page_id",
      "end_page_id",
      "user_id",
      "return_crop_images",
      "need_layout_visualization",
    ]) {
      expect(sent).not.toHaveProperty(banned);
    }
  });

  it("generates a fresh request_id per call when none is injected", async () => {
    const { calls, fetchImpl } = captureFetch(OK_BODY);
    await httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4",
      model: "glm-ocr",
      fileDataUrl: "data:image/png;base64,AAAA",
      fetchImpl,
    });
    await httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4",
      model: "glm-ocr",
      fileDataUrl: "data:image/png;base64,AAAA",
      fetchImpl,
    });
    const first = JSON.parse(String(calls[0].init?.body)).request_id;
    const second = JSON.parse(String(calls[1].init?.body)).request_id;
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first).not.toBe(second);
  });

  it("omits the Authorization header when no key is configured", async () => {
    const { calls, fetchImpl } = captureFetch(OK_BODY);
    await httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4",
      model: "glm-ocr",
      fileDataUrl: "data:image/png;base64,AAAA",
      fetchImpl,
    });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("normalises a trailing slash on the base URL (no double slash)", async () => {
    const { calls, fetchImpl } = captureFetch(OK_BODY);
    await httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4/",
      model: "glm-ocr",
      fileDataUrl: "data:image/png;base64,AAAA",
      fetchImpl,
    });
    expect(calls[0].url).toBe("https://api.z.ai/api/paas/v4/layout_parsing");
  });
});

describe("httpLayoutParsing — §3.4 precedence, step by step", () => {
  /** Build a fetchImpl that always answers with `body`/`status`. */
  function stub(body: unknown, status = 200, raw?: string): typeof fetch {
    return vi.fn(async () =>
      new Response(raw ?? JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
  }

  const call = (fetchImpl: typeof fetch, timeoutMs = 120_000) =>
    httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4",
      model: "glm-ocr",
      apiKey: "k",
      fileDataUrl: "data:image/png;base64,AAAA",
      requestId: "r",
      timeoutMs,
      fetchImpl,
    });

  // 1. transport error
  it("1. network rejection → http_error with the message", async () => {
    const res = await call(
      vi.fn(async () => {
        throw new TypeError("ECONNREFUSED");
      }) as unknown as typeof fetch,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("http_error");
      expect(res.message).toContain("ECONNREFUSED");
    }
  });

  it("1. abort → timeout (no message leak)", async () => {
    // A short injected timeout so the abort fires inside the test budget.
    const res = await call(
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      ) as unknown as typeof fetch,
      10,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("timeout");
  });
  // 2. 429
  it("2. HTTP 429 → rate_limited (even with an error body)", async () => {
    const res = await call(stub({ code: 1234, message: "slow down" }, 429));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("rate_limited");
  });

  // 3. 401/403 → auth (gate G4)
  it.each([401, 403])("3. HTTP %i → auth (gate G4, never glm_error)", async (status) => {
    const res = await call(stub({ code: 9999, message: "no key" }, status));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("auth");
      expect(res.message).toContain(String(status));
    }
  });

  it("3. auth wins over a retryable-looking body code", async () => {
    // The HTTP status is the transport truth; a body code cannot downgrade an
    // auth failure into a retry.
    const res = await call(stub({ code: 429, message: "quota" }, 401));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("auth");
  });

  // 4. other non-ok
  it("4. other non-ok → http_error carrying the status", async () => {
    const res = await call(stub({ anything: true }, 500));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("http_error");
      expect(res.message).toContain("500");
    }
  });

  it("4. 404 (the /v1-shaped URL bug) → http_error, not auth", async () => {
    const res = await call(stub({ message: "not found" }, 404));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("http_error");
  });

  // 5. non-JSON
  it("5. a non-JSON 200 body → ai_error (non-retryable)", async () => {
    const res = await call(stub({}, 200, "<html>gateway</html>"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("ai_error");
  });

  it("5. a JSON scalar (not an object) → ai_error", async () => {
    const res = await call(stub({}, 200, "42"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("ai_error");
  });

  // 6/8. success
  it("6. code 0 + md_results → ok, with usage + num_pages parsed", async () => {
    const res = await call(
      stub({
        code: 0,
        md_results: "# Deck",
        data_info: { num_pages: 12 },
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.markdown).toBe("# Deck");
      expect(res.numPages).toBe(12);
      expect(res.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
      expect(res.degraded).toBe(false);
      expect(res.blank).toBe(false);
    }
  });

  it("6. code may be the STRING \"0\"", async () => {
    const res = await call(stub({ code: "0", md_results: "text", data_info: { num_pages: 1 } }));
    expect(res.ok).toBe(true);
  });

  it("6. code may be the number 200", async () => {
    const res = await call(stub({ code: 200, md_results: "text", data_info: { num_pages: 1 } }));
    expect(res.ok).toBe(true);
  });

  it("6. an ABSENT code with md_results is a success", async () => {
    const res = await call(stub({ md_results: "text", data_info: { num_pages: 2 } }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.numPages).toBe(2);
  });

  it("6. missing usage → all-zero usage (never NaN)", async () => {
    const res = await call(stub({ code: 0, md_results: "x", data_info: { num_pages: 1 } }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it("6. a garbage num_pages → null (never 0, never NaN)", async () => {
    for (const bad of [0, -1, "abc", null, undefined, {}, NaN]) {
      const res = await call(
        stub({ code: 0, md_results: "x", data_info: { num_pages: bad } }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.numPages).toBeNull();
    }
  });

  // 7. error codes
  it("7. an UNKNOWN non-zero code WITH text → ok + degraded (never silent success)", async () => {
    const res = await call(
      stub({ code: 1234, message: "partial", md_results: "half a deck", data_info: { num_pages: 3 } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.markdown).toBe("half a deck");
      expect(res.degraded).toBe(true);
      expect(res.degradedReason).toContain("1234");
      expect(res.degradedReason).toContain("partial");
      expect(res.blank).toBe(false);
    }
  });

  it("7. an UNKNOWN non-zero code WITHOUT text → ai_error (NEVER retryable)", async () => {
    const res = await call(stub({ code: 1234, message: "boom" }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("ai_error");
      expect(res.code).toBe("1234");
    }
  });

  it("7. a string code is normalised to its string form", async () => {
    const res = await call(stub({ code: "E42", message: "unknown" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("E42");
  });

  it("7. the NESTED envelope {error:{code,message}} is accepted (no text → ai_error)", async () => {
    const res = await call(stub({ error: { code: 4711, message: "nested boom" } }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("ai_error");
      expect(res.code).toBe("4711");
    }
  });

  it("7. the nested envelope with text → degraded, reason carries code + message", async () => {
    const res = await call(
      stub({
        error: { code: 4711, message: "nested partial" },
        md_results: "some text",
        data_info: { num_pages: 1 },
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.degraded).toBe(true);
      expect(res.degradedReason).toContain("4711");
      expect(res.degradedReason).toContain("nested partial");
    }
  });

  it("7. a nested code with NO message still degrades (reason = the code)", async () => {
    const res = await call(stub({ error: { code: 55 }, md_results: "t" }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.degraded).toBe(true);
      expect(res.degradedReason).toBe("55");
    }
  });

  it("masks an echoed API key in an upstream message (defensive redaction)", async () => {
    // A well-behaved PaaS never echoes the credential, but the hard rule is
    // absolute: no key material may reach a response, log line or error string.
    const res = await httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4",
      model: "glm-ocr",
      apiKey: "sk-super-secret-key-value",
      fileDataUrl: "data:image/png;base64,AAAA",
      requestId: "r",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            code: 4321,
            message: "invalid credential sk-super-secret-key-value supplied",
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).not.toContain("sk-super-secret-key-value");
      expect(res.message).toContain("[redacted]");
    }
  });

  it("masks an echoed key in a degradedReason too", async () => {
    const res = await httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4",
      model: "glm-ocr",
      apiKey: "sk-super-secret-key-value",
      fileDataUrl: "data:image/png;base64,AAAA",
      requestId: "r",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            code: 4321,
            message: "quota for sk-super-secret-key-value exceeded",
            md_results: "partial",
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.degradedReason).not.toContain("sk-super-secret-key-value");
      expect(res.degradedReason).toContain("[redacted]");
    }
  });

  it("7. the FLAT code wins over a nested one (flat precedence)", async () => {
    const res = await call(stub({ code: 11, error: { code: 22, message: "nested" } }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("11");
  });

  it("7. code 0 with a nested error object is still a success", async () => {
    // `code` is present and zero, so the nested block is not consulted.
    const res = await call(
      stub({ code: 0, error: { code: 7 }, md_results: "ok text", data_info: { num_pages: 1 } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.degraded).toBe(false);
  });

  // 8. blank-document handling
  it("8. md_results MISSING → ai_error (never {text:''})", async () => {
    const res = await call(stub({ code: 0, data_info: { num_pages: 3 } }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("ai_error");
  });

  it("8. md_results NULL → ai_error", async () => {
    const res = await call(stub({ code: 0, md_results: null, data_info: { num_pages: 3 } }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("ai_error");
  });

  it("8. md_results as an ARRAY (the md_results[] shorthand) → ai_error", async () => {
    const res = await call(
      stub({ code: 0, md_results: ["# p1", "# p2"], data_info: { num_pages: 2 } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("ai_error");
  });

  it("8. md_results:'' WITH a positive num_pages → blank success", async () => {
    const res = await call(stub({ code: 0, md_results: "", data_info: { num_pages: 3 } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.markdown).toBe("");
      expect(res.blank).toBe(true);
      expect(res.numPages).toBe(3);
      expect(res.degraded).toBe(false);
    }
  });

  it("8. md_results:'' WITHOUT num_pages → ai_error (unconfirmed blank)", async () => {
    const res = await call(stub({ code: 0, md_results: "" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("ai_error");
  });

  it("8. md_results:'' with a non-positive/garbage num_pages → ai_error", async () => {
    for (const bad of [0, -3, "abc", null]) {
      const res = await call(stub({ code: 0, md_results: "", data_info: { num_pages: bad } }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("ai_error");
    }
  });

  it("8. a blank response with a non-zero UNKNOWN code and no text → ai_error", async () => {
    // An error envelope is never a blank document.
    const res = await call(stub({ code: 9, message: "err", md_results: "", data_info: { num_pages: 2 } }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("ai_error");
  });
});

/**
 * Defect #4 — usage must be reported whenever the body carries it, on the
 * FAILURE arm too, and `usagePresent` must distinguish "upstream reported zero"
 * from "upstream reported nothing". A billed call recorded as 0 is a lie; a
 * billed call recorded as nothing at all is worse.
 */
describe("httpLayoutParsing — usage accounting on every path (defect #4)", () => {
  function stub(body: unknown, status = 200): typeof fetch {
    return vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
  }

  const call = (body: unknown, status = 200) =>
    httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4",
      model: "glm-ocr",
      apiKey: "k",
      fileDataUrl: "data:image/png;base64,AAAA",
      requestId: "r",
      fetchImpl: stub(body, status),
    });

  it("accepts NUMERIC STRINGS in usage (a string total_tokens is not silently 0)", async () => {
    const res = await call({
      code: 0,
      md_results: "text",
      data_info: { num_pages: 1 },
      usage: { prompt_tokens: "1000", completion_tokens: "2000", total_tokens: "3000" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.usage).toEqual({ promptTokens: 1000, completionTokens: 2000, totalTokens: 3000 });
      expect(res.usagePresent).toBe(true);
    }
  });

  it("reports usagePresent:true for a reported ZERO total (different from absent)", async () => {
    const res = await call({
      code: 0,
      md_results: "text",
      data_info: { num_pages: 1 },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.usagePresent).toBe(true);
      expect(res.usage.totalTokens).toBe(0);
    }
  });

  it("reports usagePresent:false when usage is ABSENT (never a fabricated 0)", async () => {
    const res = await call({ code: 0, md_results: "text", data_info: { num_pages: 1 } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.usagePresent).toBe(false);
      expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    }
  });

  it("derives totalTokens from reported parts when only the parts are given", async () => {
    const res = await call({
      code: 0,
      md_results: "text",
      data_info: { num_pages: 1 },
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.usage.totalTokens).toBe(30);
      expect(res.usagePresent).toBe(true);
    }
  });

  // The G9 money case: an HTTP-200 error envelope that reports usage.
  it("carries usage on an UNKNOWN-CODE failure (the billed error envelope)", async () => {
    const res = await call({
      code: 77777,
      message: "capacity degraded",
      usage: { total_tokens: 999_999 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("ai_error");
      expect(res.usage.totalTokens).toBe(999_999);
      expect(res.usagePresent).toBe(true);
    }
  });

  it("carries usage on the DEGRADED success arm too", async () => {
    const res = await call({
      code: 77777,
      message: "capacity degraded",
      md_results: "partial text",
      usage: { total_tokens: 555 },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.degraded).toBe(true);
      expect(res.usage.totalTokens).toBe(555);
      expect(res.usagePresent).toBe(true);
    }
  });

  it("carries usage on the rate_limited (retryable-code, no text) arm", async () => {
    const res = await call({ code: 429, message: "busy", usage: { total_tokens: 12 } });
    // code 429 is NOT in the retryable set, so this is the unknown-code path…
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.usage.totalTokens).toBe(12);
  });

  it("reports usagePresent:false on a transport failure (nothing was parsed)", async () => {
    const res = await httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4",
      model: "glm-ocr",
      apiKey: "k",
      fileDataUrl: "data:image/png;base64,AAAA",
      requestId: "r",
      fetchImpl: (async () => {
        throw new TypeError("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.usagePresent).toBe(false);
      expect(res.usage.totalTokens).toBe(0);
    }
  });

  it("carries usage on an HTTP 429 (capacity) response body", async () => {
    const res = await call({ message: "slow down" }, 429);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("rate_limited");
      // A 429 body is not read (the status is the signal) — nothing invented.
      expect(res.usagePresent).toBe(false);
    }
  });

  it("still never returns NaN for a garbage usage object", async () => {
    for (const bad of [null, 7, "x", [], { total_tokens: "abc" }, { total_tokens: {} }]) {
      const res = await call({ code: 0, md_results: "t", data_info: { num_pages: 1 }, usage: bad });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(Number.isFinite(res.usage.totalTokens)).toBe(true);
        expect(res.usage.totalTokens).toBe(0);
        expect(res.usagePresent).toBe(false);
      }
    }
  });
});

/**
 * Defect #8 — redaction of `code`, and no length gate on the secret.
 */
describe("httpLayoutParsing — redaction covers code and short keys (defect #8)", () => {
  const callWith = (body: unknown, apiKey: string | undefined) =>
    httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4",
      model: "glm-ocr",
      apiKey,
      fileDataUrl: "data:image/png;base64,AAAA",
      requestId: "r",
      fetchImpl: (async () =>
        new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch,
    });

  it("redacts a key echoed in the upstream CODE (it used to pass verbatim)", async () => {
    const res = await callWith(
      { code: "sk-super-secret-key-value", message: "bad" },
      "sk-super-secret-key-value",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).not.toContain("sk-super-secret-key-value");
      expect(res.code).toBe("[redacted]");
      expect(JSON.stringify(res)).not.toContain("sk-super-secret-key-value");
    }
  });

  it("redacts a key echoed in the code of a DEGRADED response", async () => {
    const res = await callWith(
      { code: "sk-super-secret-key-value", md_results: "text" },
      "sk-super-secret-key-value",
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.degradedReason).not.toContain("sk-super-secret-key-value");
      expect(res.code).toBe("[redacted]");
    }
  });

  it("redacts a SIX-char key (the old length gate let it through in full)", async () => {
    const res = await callWith({ code: 1234, message: "key ab12cd is invalid" }, "ab12cd");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).not.toContain("ab12cd");
      expect(res.message).toContain("[redacted]");
    }
  });

  it("redacts a ONE-char key without mangling the rest of the message", async () => {
    const res = await callWith({ code: 1234, message: "key X is invalid" }, "X");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).not.toContain("key X is");
      expect(res.message).toContain("[redacted]");
      // The rest of the sentence survives.
      expect(res.message).toContain("is invalid");
    }
  });

  it("does not explode when the key is absent (nothing to redact)", async () => {
    const res = await callWith({ code: 1234, message: "plain message" }, undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toBe("plain message");
  });
});

/**
 * Defect #10(b) — `num_pages` must be a positive INTEGER.
 */
describe("httpLayoutParsing — num_pages is an integer or null (defect #10b)", () => {
  const call = (numPages: unknown) =>
    httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4",
      model: "glm-ocr",
      apiKey: "k",
      fileDataUrl: "data:image/png;base64,AAAA",
      requestId: "r",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ code: 0, md_results: "text", data_info: { num_pages: numPages } }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });

  it("rejects a FRACTIONAL page count (12.7 → null, never numPages:12.7)", async () => {
    const res = await call(12.7);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.numPages).toBeNull();
  });

  it("rejects a fractional STRING page count too", async () => {
    const res = await call("12.7");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.numPages).toBeNull();
  });

  it("still accepts genuine integers, numeric and string", async () => {
    for (const [input, expected] of [[12, 12], ["12", 12], [" 12 ", 12]] as const) {
      const res = await call(input);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.numPages).toBe(expected);
    }
  });

  it("a fractional page count cannot confirm a blank document", async () => {
    const res = await httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4",
      model: "glm-ocr",
      fileDataUrl: "data:image/png;base64,AAAA",
      requestId: "r",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ code: 0, md_results: "", data_info: { num_pages: 3.5 } }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("ai_error");
  });
});

describe("ZAI code sets — provisional extension points", () => {
  it("keeps the RETRYABLE set EMPTY (the live code list is owed; inventing codes burns billing)", () => {
    expect(ZAI_RETRYABLE_CODES.size).toBe(0);
  });

  // Defect #7 (contract §4.2, revised): the AUTH set is seeded with the two
  // HTTP-standard auth codes. With it empty, `{code:403, md_results:"text"}` on
  // HTTP 200 fell into the unknown-code branch and returned a SILENT SUCCESS —
  // an entitlement failure reported to the user as a successful extraction.
  // 401/403 are not invented Z.ai codes; they are the standard meanings.
  it("seeds AUTH with the two HTTP-standard auth codes (401/403)", () => {
    expect([...ZAI_AUTH_CODES].sort()).toEqual(["401", "403"]);
  });

  it("an unknown code is never treated as retryable", async () => {
    // The empty sets are load-bearing: this asserts the fail-closed default
    // even if a future edit adds codes, by using a code that must not be in
    // any documented capacity set.
    const res = await httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4",
      model: "glm-ocr",
      fileDataUrl: "data:image/png;base64,AAAA",
      requestId: "r",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ code: 999999, message: "unknown" }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("ai_error");
  });

  // The two branches below are DEAD while the sets are empty, which is exactly
  // why they need pinning: the extension point must WORK the day a measured
  // live code lands, or the ops response to a real capacity/auth code is wrong.
  // The sets are typed ReadonlySet, so the test reaches them through a cast and
  // restores the empty state afterwards (module state is per test file).
  function withCode(set: ReadonlySet<string>, code: string, fn: () => Promise<void>) {
    const mutable = set as Set<string>;
    mutable.add(code);
    return fn().finally(() => mutable.delete(code));
  }

  it("a code registered as RETRYABLE with text → ok + degraded (partial read)", async () => {
    await withCode(ZAI_RETRYABLE_CODES, "777", async () => {
      const res = await httpLayoutParsing({
        baseUrl: "https://api.z.ai/api/paas/v4",
        model: "glm-ocr",
        fileDataUrl: "data:image/png;base64,AAAA",
        requestId: "r",
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({ code: 777, md_results: "partial", data_info: { num_pages: 2 } }),
            { status: 200 },
          )) as unknown as typeof fetch,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.degraded).toBe(true);
        expect(res.degradedReason).toBe("777");
      }
    });
    expect(ZAI_RETRYABLE_CODES.size).toBe(0);
  });

  it("a code registered as RETRYABLE without text → rate_limited (the retry signal)", async () => {
    await withCode(ZAI_RETRYABLE_CODES, "777", async () => {
      const res = await httpLayoutParsing({
        baseUrl: "https://api.z.ai/api/paas/v4",
        model: "glm-ocr",
        fileDataUrl: "data:image/png;base64,AAAA",
        requestId: "r",
        fetchImpl: (async () =>
          new Response(JSON.stringify({ code: 777, message: "busy" }), {
            status: 200,
          })) as unknown as typeof fetch,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe("rate_limited");
        expect(res.code).toBe("777");
      }
    });
  });

  it("a code registered as AUTH → auth (always), even with text present", async () => {
    await withCode(ZAI_AUTH_CODES, "888", async () => {
      const res = await httpLayoutParsing({
        baseUrl: "https://api.z.ai/api/paas/v4",
        model: "glm-ocr",
        fileDataUrl: "data:image/png;base64,AAAA",
        requestId: "r",
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({ code: 888, md_results: "text", data_info: { num_pages: 1 } }),
            { status: 200 },
          )) as unknown as typeof fetch,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("auth");
    });
    // Only the seeded 401/403 survive the cleanup.
    expect([...ZAI_AUTH_CODES].sort()).toEqual(["401", "403"]);
  });

  // Defect #7: the seeded codes, on an HTTP 200 envelope, with AND without text.
  // The with-text case is the important one — it used to be a silent success.
  const callCode = (body: unknown) =>
    httpLayoutParsing({
      baseUrl: "https://api.z.ai/api/paas/v4",
      model: "glm-ocr",
      apiKey: "k",
      fileDataUrl: "data:image/png;base64,AAAA",
      requestId: "r",
      fetchImpl: (async () =>
        new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch,
    });

  it.each(["401", "403"])(
    "a seeded AUTH code %s on HTTP 200 WITH text → auth, never a success",
    async (code) => {
      const res = await callCode({
        code: Number(code),
        message: "no entitlement",
        md_results: "a whole deck of text",
        data_info: { num_pages: 12 },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe("auth");
        expect(res.code).toBe(code);
        // The paid-for text must not be handed back on an auth failure: the
        // caller must not be able to treat this as a degraded-but-usable read.
        expect(res).not.toHaveProperty("markdown");
      }
    },
  );

  it.each(["401", "403"])(
    "a seeded AUTH code %s on HTTP 200 WITHOUT text → auth",
    async (code) => {
      const res = await callCode({ code: Number(code), message: "no entitlement" });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("auth");
    },
  );

  it("a seeded AUTH code still carries the reported usage (it was billed)", async () => {
    const res = await callCode({
      code: 403,
      md_results: "text",
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.usage.totalTokens).toBe(30);
      expect(res.usagePresent).toBe(true);
    }
  });
});
