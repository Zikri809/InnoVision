import { describe, it, expect, vi } from "vitest";
import { httpChatCompletions, probeOllamaModel } from "@/lib/ai/http-compat";

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
      baseUrl: "http://ollama",
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
      baseUrl: "http://ollama",
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
      baseUrl: "http://ollama",
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
      baseUrl: "http://ollama",
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
      baseUrl: "http://ollama",
      model: "glm-ocr",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("ai_error");
    vi.unstubAllGlobals();
  });
});

describe("probeOllamaModel — Ollama availability probe", () => {
  it("returns true when the model is listed (with :tag suffix)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: "glm-ocr:latest" }] }),
      }),
    );
    const ok = await probeOllamaModel({ baseUrl: "http://ollama", model: "glm-ocr" });
    expect(ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it("returns true on an exact model name match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: "glm-ocr" }] }),
      }),
    );
    const ok = await probeOllamaModel({ baseUrl: "http://ollama", model: "glm-ocr" });
    expect(ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it("returns false on connection error (ECONNREFUSED)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("ECONNREFUSED")));
    const ok = await probeOllamaModel({ baseUrl: "http://127.0.0.1:1", model: "glm-ocr" });
    expect(ok).toBe(false);
    vi.unstubAllGlobals();
  });

  it("returns false on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const ok = await probeOllamaModel({ baseUrl: "http://ollama", model: "glm-ocr" });
    expect(ok).toBe(false);
    vi.unstubAllGlobals();
  });

  it("returns false on an empty model list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) }),
    );
    const ok = await probeOllamaModel({ baseUrl: "http://ollama", model: "glm-ocr" });
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
    const ok = await probeOllamaModel({ baseUrl: "http://ollama", model: "glm-ocr", timeoutMs: 10 });
    expect(ok).toBe(false);
    vi.unstubAllGlobals();
  });
});
