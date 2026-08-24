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
});
