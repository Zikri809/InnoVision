import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { FakeSupabase } from "@/app/api/quizzes/__tests__/fake-supabase";
import { defaultAiServer } from "@/test/msw/server";
import { http, HttpResponse } from "msw";

/**
 * Route tests for /api/extract/ocr — the server-side GLM-OCR proxy.
 * MSW intercepts the UPSTREAM vLLM endpoints (the models list and chat
 * completions) so no Docker is needed (TESTING §1: AI tests never hit a
 * real model).
 */

const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

const GLM_BASE = "http://127.0.0.1:59999"; // test-only upstream port

function lecturerContext() {
  const client = new FakeSupabase();
  client.setUser("00000000-0000-4000-8000-00000000000a", "lecturer");
  fakeHolder.current = client;
  return client;
}

const PNG_DATAURL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function post(body?: unknown, init?: RequestInit): Request {
  return new Request("http://localhost/api/extract/ocr", {
    method: init?.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function importRoute() {
  return import("@/app/api/extract/ocr/route");
}

beforeEach(() => {
  fakeHolder.current = undefined;
  defaultAiServer.resetHandlers();
  vi.stubEnv("GLM_BASE_URL", GLM_BASE);
  vi.stubEnv("OCR_GLM_MODEL", "glm-ocr");
});

beforeAll(() => {
  defaultAiServer.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  defaultAiServer.close();
  vi.unstubAllEnvs();
});

describe("audit-3 R3-DEP-F2 — VLLM_API_KEY forwarding", () => {
  it("sends Authorization: Bearer on the probe and the chat call when the key is set", async () => {
    vi.stubEnv("VLLM_API_KEY", "test-vllm-secret");
    lecturerContext();
    const seen: { probe?: string | null; chat?: string | null } = {};
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, ({ request }) => {
        seen.probe = request.headers.get("authorization");
        return HttpResponse.json({ data: [{ id: "glm-ocr" }] });
      }),
      http.post(`${GLM_BASE}/v1/chat/completions`, ({ request }) => {
        seen.chat = request.headers.get("authorization");
        return HttpResponse.json({ choices: [{ message: { content: "page text" } }] });
      }),
    );
    const route = await importRoute();
    const res = await route.POST(post({ image: PNG_DATAURL }));
    expect(res.status).toBe(200);
    expect(seen.probe).toBe("Bearer test-vllm-secret");
    expect(seen.chat).toBe("Bearer test-vllm-secret");
  });

  it("sends NO Authorization header when the key is unset (keyless loopback default)", async () => {
    vi.stubEnv("VLLM_API_KEY", "");
    lecturerContext();
    let probeAuth: string | null = "unset";
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, ({ request }) => {
        probeAuth = request.headers.get("authorization");
        return HttpResponse.json({ data: [{ id: "glm-ocr" }] });
      }),
      http.post(`${GLM_BASE}/v1/chat/completions`, () =>
        HttpResponse.json({ choices: [{ message: { content: "page text" } }] }),
      ),
    );
    const route = await importRoute();
    const res = await route.POST(post({ image: PNG_DATAURL }));
    expect(res.status).toBe(200);
    expect(probeAuth).toBeNull();
  });
});

describe("GET /api/extract/ocr — availability probe", () => {
  it("reports available:true when the model is listed upstream", async () => {
    lecturerContext();
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, () =>
        HttpResponse.json({ data: [{ id: "glm-ocr" }] }),
      ),
    );
    const route = await importRoute();
    const res = await route.GET();
    expect(res.status).toBe(200);
    expect((await res.json()).available).toBe(true);
  });

  it("reports available:false when the container is down", async () => {
    lecturerContext();
    // No handler registered → msw bypasses to a dead port → probe fails.
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, () => HttpResponse.error()),
    );
    const route = await importRoute();
    const res = await route.GET();
    expect((await res.json()).available).toBe(false);
  });

  it("requires a lecturer (student → 403)", async () => {
    const client = new FakeSupabase();
    client.setUser("00000000-0000-4000-8000-00000000000b1", "student");
    fakeHolder.current = client;
    const route = await importRoute();
    const res = await route.GET();
    expect(res.status).toBe(403);
  });
});

describe("POST /api/extract/ocr — page transcription", () => {
  it("transcribes one page through the upstream chat endpoint", async () => {
    lecturerContext();
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, () =>
        HttpResponse.json({ data: [{ id: "glm-ocr" }] }),
      ),
      http.post(`${GLM_BASE}/v1/chat/completions`, async () => {
        // Sanity: the proxy forwards the vision payload shape.
        return HttpResponse.json({
          choices: [{ message: { content: "Chapter 1 transcribed text" } }],
        });
      }),
    );
    const route = await importRoute();
    const res = await route.POST(post({ image: PNG_DATAURL }));
    expect(res.status).toBe(200);
    expect((await res.json()).text).toContain("Chapter 1");
  });

  it("unreachable container → 503 glm_model_unavailable", async () => {
    lecturerContext();
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, () => HttpResponse.error()),
    );
    const route = await importRoute();
    const res = await route.POST(post({ image: PNG_DATAURL }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("glm_model_unavailable");
  });

  it("upstream HTTP failure → 502 glm_error", async () => {
    lecturerContext();
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, () =>
        HttpResponse.json({ data: [{ id: "glm-ocr" }] }),
      ),
      http.post(`${GLM_BASE}/v1/chat/completions`, () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    const route = await importRoute();
    const res = await route.POST(post({ image: PNG_DATAURL }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("glm_error");
  });

  // audit-3 F-F10: an upstream 429 is a capacity/rate signal, not a page-read
  // failure. It must surface as its own code so the dialog says "rate limited,
  // retry" instead of provoking retries into the same spent window.
  it("upstream 429 → 429 glm_rate_limited (distinct from glm_error)", async () => {
    lecturerContext();
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, () =>
        HttpResponse.json({ data: [{ id: "glm-ocr" }] }),
      ),
      http.post(`${GLM_BASE}/v1/chat/completions`, () =>
        HttpResponse.json({ error: "too many" }, { status: 429 }),
      ),
    );
    const route = await importRoute();
    const res = await route.POST(post({ image: PNG_DATAURL }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("glm_rate_limited");
  });

  it("malformed image field → 400 glm_error", async () => {
    lecturerContext();
    const route = await importRoute();
    const res = await route.POST(post({ image: "not-a-dataurl" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("glm_error");
  });

  it("invalid JSON body → 400", async () => {
    lecturerContext();
    const route = await importRoute();
    const bad = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect((await route.POST(bad)).status).toBe(400);
  });

  // audit-3 F-F4: the limiter alone admitted a second batch of 20 at t≈60s
  // while the first batch (90s each) was still running → up to 40 concurrent
  // GPU holds. The in-flight guard caps concurrent pages per user.
  it("caps concurrent page inferences per user (F-F4 in-flight guard)", async () => {
    lecturerContext();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, () =>
        HttpResponse.json({ data: [{ id: "glm-ocr" }] }),
      ),
      http.post(`${GLM_BASE}/v1/chat/completions`, async () => {
        await gate;
        return HttpResponse.json({ choices: [{ message: { content: "page text" } }] });
      }),
    );
    const route = await importRoute();
    // Two pages are admitted (the ceiling); the third is rejected as busy.
    const p1 = route.POST(post({ image: PNG_DATAURL }));
    const p2 = route.POST(post({ image: PNG_DATAURL }));
    const third = await route.POST(post({ image: PNG_DATAURL }));
    expect(third.status).toBe(429);
    expect((await third.json()).error).toBe("glm_busy");
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // The slots are released — a later request succeeds.
    const after = await route.POST(post({ image: PNG_DATAURL }));
    expect(after.status).toBe(200);
  });
});
