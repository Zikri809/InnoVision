import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
import { FakeSupabase } from "@/app/api/quizzes/__tests__/fake-supabase";
import { defaultAiServer } from "@/test/msw/server";
import { http, HttpResponse } from "msw";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetGlmSpendForTests, glmSpendCalls, glmSpendUsed } from "@/lib/ai/glm-spend";
import { _resetGlmHealthForTests } from "@/lib/ai/glm-health";
import { _resetGlmProviderWarnForTests } from "@/lib/ai/glm-provider";
import { _resetRateLimiter } from "@/lib/classes/rate-limit";

/**
 * Route tests for /api/extract/ocr — the server-side GLM-OCR proxy, BOTH legs.
 * MSW intercepts the UPSTREAM endpoints (the local models list + chat
 * completions, and the remote Z.ai `layout_parsing`) so no Docker and no live
 * key are needed (TESTING §1: AI tests never hit a real model).
 *
 * The local leg's cases predate the toggle and are kept INTACT (contract hard
 * rule 1: local behaviour must not regress). The remote cases pin the §4.5
 * table: `glm_pages_exceeded` / `glm_spend_cap` / auth → 503
 * `glm_model_unavailable` (NEVER `glm_error`) / spend recorded after success.
 */

const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

const GLM_BASE = "http://127.0.0.1:59999"; // test-only upstream port
const ZAI_BASE = "https://zai.test.invalid/api/paas/v4";
const LECTURER_ID = "00000000-0000-4000-8000-00000000000a";

function lecturerContext() {
  const client = new FakeSupabase();
  client.setUser(LECTURER_ID, "lecturer");
  fakeHolder.current = client;
  return client;
}

const PNG_DATAURL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A tiny but structurally real PDF: `%PDF` header + N `/Type /Page` objects. */
function pdfDataUrl(pageObjects: number): string {
  const parts = ["%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"];
  for (let i = 0; i < pageObjects; i++) {
    parts.push(`${i + 2} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`);
  }
  parts.push("2 0 obj\n<< /Type /Pages /Count " + pageObjects + " >>\nendobj\n%%EOF\n");
  return `data:application/pdf;base64,${Buffer.from(parts.join(""), "latin1").toString("base64")}`;
}

/**
 * Defect #12 fixture: a PDF whose page objects live in a COMPRESSED object
 * stream (`/ObjStm`, FlateDecode) — the standard output of every modern
 * producer. The `/Type /Page` objects exist but are DEFLATED, so a regex over
 * the raw bytes counts 0: the route's cheap pre-flight cannot see the page
 * count. The real page count is only discoverable by inflating the stream
 * (which pdf.js does, and the client's pre-flight uses).
 */
function compressedObjStmPdfDataUrl(pages: number): string {
  // The page objects, as a producer would store them: inside the stream.
  const inner = Array.from(
    { length: pages },
    (_, i) => `${i + 2} 0 obj << /Type /Page /Parent 2 0 R >> endobj`,
  ).join("\n");
  const deflated = deflateSync(Buffer.from(inner, "latin1"));
  const parts = [
    Buffer.from(
      "%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
        `3 0 obj\n<< /Type /ObjStm /N ${pages} /First 0 /Filter /FlateDecode ` +
        `/Length ${deflated.length} >>\nstream\n`,
      "latin1",
    ),
    deflated,
    Buffer.from(
      "\nendstream\nendobj\n" +
        `2 0 obj\n<< /Type /Pages /Count ${pages} /Kids [3 0 R] >>\nendobj\n%%EOF\n`,
      "latin1",
    ),
  ];
  return `data:application/pdf;base64,${Buffer.concat(parts).toString("base64")}`;
}

/** A 3-page PDF used across the remote-leg cases. */
const PDF_DATAURL = pdfDataUrl(3);

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

/** The remote success envelope (contract §3.2). */
function remoteOk(overrides: Record<string, unknown> = {}) {
  return {
    code: 0,
    md_results: "# Chapter 1\n\nTranscribed whole document.",
    layout_details: [[{ page: 1 }]],
    data_info: { num_pages: 12 },
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    ...overrides,
  };
}

let spendDir: string;
let spendLedger: string;

beforeEach(() => {
  fakeHolder.current = undefined;
  defaultAiServer.resetHandlers();
  _resetRateLimiter();
  _resetGlmHealthForTests();
  _resetGlmProviderWarnForTests();
  spendDir = mkdtempSync(join(tmpdir(), "glm-route-spend-"));
  spendLedger = join(spendDir, "ledger.json");
  _resetGlmSpendForTests(spendLedger);
  vi.stubEnv("GLM_BASE_URL", GLM_BASE);
  vi.stubEnv("OCR_GLM_MODEL", "glm-ocr");
  // Default to the LOCAL leg: every pre-toggle case must keep passing as-is.
  vi.stubEnv("GLM_PROVIDER", "local");
  vi.stubEnv("VLLM_API_KEY", "");
  vi.stubEnv("ZAI_BASE_URL", ZAI_BASE);
  vi.stubEnv("ZAI_API_KEY", "zai-test-secret");
  vi.stubEnv("GLM_SPEND_DISABLED", "");
  vi.stubEnv("GLM_DAILY_TOKEN_CAP", "");
  vi.stubEnv("GLM_TOKEN_PRICE_PER_MILLION", "");
  vi.stubEnv("GLM_REMOTE_MAX_PAGES", "");
});

beforeAll(() => {
  defaultAiServer.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  defaultAiServer.close();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  // Console spies in this file must not accumulate calls across tests: the
  // assertions below search `mock.calls` for the line a given test produced,
  // and a stale call from an earlier test would match first.
  vi.restoreAllMocks();
  _resetGlmSpendForTests(null);
  try {
    rmSync(spendDir, { recursive: true, force: true });
  } catch {
    // Disposable temp dir.
  }
});

/** Switch the process to the remote leg for one test. */
function useRemote() {
  vi.stubEnv("GLM_PROVIDER", "remote");
}

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

  it("never presents the local VLLM_API_KEY to the REMOTE leg", async () => {
    useRemote();
    vi.stubEnv("VLLM_API_KEY", "test-vllm-secret");
    lecturerContext();
    let remoteAuth: string | null = "unset";
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, ({ request }) => {
        remoteAuth = request.headers.get("authorization");
        return HttpResponse.json(remoteOk());
      }),
    );
    const route = await importRoute();
    await route.POST(post({ file: PNG_DATAURL, kind: "image" }));
    expect(remoteAuth).toBe("Bearer zai-test-secret");
    expect(remoteAuth).not.toContain("test-vllm-secret");
  });
});

describe("GET /api/extract/ocr — availability probe", () => {
  it("reports available:true with the full health shape when the model is listed upstream", async () => {
    lecturerContext();
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, () =>
        HttpResponse.json({ data: [{ id: "glm-ocr" }] }),
      ),
    );
    const route = await importRoute();
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.reason).toBe("ok");
    expect(body.provider).toBe("local");
    expect(body.maxPages).toBe(200);
    expect(typeof body.maxImageBytes).toBe("number");
    expect(typeof body.maxPdfBytes).toBe("number");
    expect(typeof body.checkedAt).toBe("string");
  });

  it("reports available:false + reason when the container is down", async () => {
    lecturerContext();
    // No handler registered → msw bypasses to a dead port → probe fails.
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, () => HttpResponse.error()),
    );
    const route = await importRoute();
    const res = await route.GET();
    const body = await res.json();
    expect(body.available).toBe(false);
    expect(body.reason).toBe("unreachable");
    expect(body.provider).toBe("local");
  });

  it("reports the remote leg + caps without leaking the key", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () => HttpResponse.json(remoteOk())),
    );
    const route = await importRoute();
    const res = await route.GET();
    const raw = JSON.stringify(await res.json());
    const body = JSON.parse(raw);
    expect(body.available).toBe(true);
    expect(body.provider).toBe("remote");
    expect(body.maxPages).toBe(30);
    expect(body.maxImageBytes).toBe(10 * 1024 * 1024);
    expect(body.maxPdfBytes).toBe(50 * 1024 * 1024);
    expect(raw).not.toContain("zai-test-secret");
  });

  it("requires a lecturer (student → 403)", async () => {
    const client = new FakeSupabase();
    client.setUser("00000000-0000-4000-8000-00000000000b1", "student");
    fakeHolder.current = client;
    const route = await importRoute();
    const res = await route.GET();
    expect(res.status).toBe(403);
  });

  it("uses its own tighter bucket: the 7th health call in the window is 429", async () => {
    lecturerContext();
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, () =>
        HttpResponse.json({ data: [{ id: "glm-ocr" }] }),
      ),
    );
    const route = await importRoute();
    for (let i = 0; i < 6; i++) {
      expect((await route.GET()).status).toBe(200);
    }
    const seventh = await route.GET();
    expect(seventh.status).toBe(429);
    expect((await seventh.json()).error).toBe("glm_rate_limited");
  });
});

describe("POST /api/extract/ocr — local page transcription (unchanged)", () => {
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

  it("a {file,kind} body on the LOCAL leg → 400 glm_error (local is one rasterized page)", async () => {
    lecturerContext();
    const route = await importRoute();
    for (const body of [
      { file: PDF_DATAURL, kind: "pdf" },
      { file: PNG_DATAURL, kind: "image" },
    ]) {
      const res = await route.POST(post(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("glm_error");
    }
  });

  it("rejects a remote-shaped http:// URL as `file` (G5 SSRF-by-proxy ban)", async () => {
    useRemote();
    lecturerContext();
    const route = await importRoute();
    for (const file of [
      "https://attacker.example/secret.pdf",
      "http://169.254.169.254/latest/meta-data/",
      "data:application/pdf;base64," + Buffer.from("not a pdf").toString("base64"),
    ]) {
      const res = await route.POST(post({ file, kind: "pdf" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("glm_error");
    }
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

describe("POST /api/extract/ocr — remote whole-document leg", () => {
  it("transcribes a whole PDF in ONE layout_parsing call", async () => {
    useRemote();
    lecturerContext();
    const seen: { url: string; body: Record<string, unknown>; auth?: string | null }[] = [];
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, async ({ request }) => {
        seen.push({
          url: request.url,
          body: (await request.json()) as Record<string, unknown>,
          auth: request.headers.get("authorization"),
        });
        return HttpResponse.json(remoteOk());
      }),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toContain("Chapter 1");
    expect(body.pages).toBe(12);
    expect(body.numPages).toBe(12);
    expect(body.degraded).toBe(false);
    expect(body.blank).toBe(false);
    // Exactly one upstream call — no per-page loop on the metered leg.
    expect(seen).toHaveLength(1);
    expect(seen[0].body.file).toBe(PDF_DATAURL);
    expect(seen[0].body.model).toBe("glm-ocr");
    expect(seen[0].body.request_id).toMatch(/^[0-9a-f-]{36}$/i);
    // G10: range/tracking fields are NEVER sent.
    expect(seen[0].body).not.toHaveProperty("start_page_id");
    expect(seen[0].body).not.toHaveProperty("end_page_id");
    expect(seen[0].body).not.toHaveProperty("user_id");
  });

  // Defect #9 (contract §4.5 REVISED): the remote leg is whole-document ONLY.
  // The old `{image}` convenience was the vector for the 10–200× overspend gate
  // G3 exists to prevent — the client's per-page loop could drive N billed
  // calls against the metered leg while skipping the page cap.
  it("REJECTS the {image} convenience shape on the remote leg (400, NO upstream call)", async () => {
    useRemote();
    lecturerContext();
    let upstreamCalls = 0;
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () => {
        upstreamCalls++;
        return HttpResponse.json(remoteOk({ data_info: { num_pages: 1 } }));
      }),
    );
    const route = await importRoute();
    const res = await route.POST(post({ image: PNG_DATAURL }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("glm_error");
    // The whole point: no billed call was made.
    expect(upstreamCalls).toBe(0);
  });

  it("the rejection is logged server-side so the overspend attempt is visible", async () => {
    useRemote();
    lecturerContext();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const route = await importRoute();
    await route.POST(post({ image: PNG_DATAURL }));
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[glm-ocr]"));
    expect(line).toBeDefined();
    expect(line).toContain("REMOTE leg");
    // Never the key.
    expect(String(line)).not.toContain("zai-test-secret");
  });

  it("surfaces a degraded (partial) reading as degraded:true, never a silent success", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json(remoteOk({ code: 1234, message: "partial read" })),
      ),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.text).toContain("Chapter 1");
  });

  it("surfaces a confirmed blank document as blank:true with empty text", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json({ code: 0, md_results: "", data_info: { num_pages: 4 } }),
      ),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe("");
    expect(body.blank).toBe(true);
    expect(body.numPages).toBe(4);
  });

  // Gate G8: the cheap pre-flight page lower bound. Counts `/Type /Page`
  // objects in the decoded bytes and refuses WITHOUT spending.
  it("PDF over the page cap → 413 glm_pages_exceeded with NO upstream call", async () => {
    useRemote();
    lecturerContext();
    let upstreamCalls = 0;
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () => {
        upstreamCalls++;
        return HttpResponse.json(remoteOk());
      }),
    );
    vi.stubEnv("GLM_REMOTE_MAX_PAGES", "5");
    const route = await importRoute();
    const res = await route.POST(post({ file: pdfDataUrl(6), kind: "pdf" }));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("glm_pages_exceeded");
    expect(upstreamCalls).toBe(0);
  });

  it("a PDF at exactly the cap is admitted", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        // The response's own page count must also be within the cap, or the
        // post-check (below) turns the run into a 502.
        HttpResponse.json(remoteOk({ data_info: { num_pages: 5 } })),
      ),
    );
    vi.stubEnv("GLM_REMOTE_MAX_PAGES", "5");
    const route = await importRoute();
    const res = await route.POST(post({ file: pdfDataUrl(5), kind: "pdf" }));
    expect(res.status).toBe(200);
  });

  it("does NOT count `/Type /Pages` as a page (the word-boundary rule)", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json(remoteOk({ data_info: { num_pages: 1 } })),
      ),
    );
    // One real page + a /Pages node: the lower bound is 1, so a 1-page cap holds.
    vi.stubEnv("GLM_REMOTE_MAX_PAGES", "1");
    const route = await importRoute();
    const res = await route.POST(post({ file: pdfDataUrl(1), kind: "pdf" }));
    expect(res.status).toBe(200);
  });

  it("post-checks numPages > maxPages → 502 glm_error (already paid, still logged)", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json(remoteOk({ data_info: { num_pages: 99 } })),
      ),
    );
    vi.stubEnv("GLM_REMOTE_MAX_PAGES", "10");
    const route = await importRoute();
    const res = await route.POST(post({ file: pdfDataUrl(1), kind: "pdf" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("glm_error");
    // The spend is recorded even though the response is a failure: the call
    // really happened and really cost money.
    const ledger = JSON.parse(readFileSync(spendLedger, "utf8"));
    expect(ledger[Object.keys(ledger)[0]][LECTURER_ID].tokens).toBe(300);
  });

  // Gate G4: a dead key / missing entitlement is a CONFIGURATION problem.
  it("remote auth failure → 503 glm_model_unavailable (NEVER glm_error)", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json({ code: 401, message: "invalid api key" }, { status: 401 }),
      ),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("glm_model_unavailable");
    expect(JSON.stringify(body)).not.toContain("zai-test-secret");
  });

  it("remote 403 → 503 glm_model_unavailable (no entitlement)", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json({ code: 403, message: "no entitlement" }, { status: 403 }),
      ),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("glm_model_unavailable");
  });

  it("remote 429 → 429 glm_rate_limited", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json({ code: 429, message: "capacity" }, { status: 429 }),
      ),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("glm_rate_limited");
  });

  it("remote 500 → 502 glm_error (non-retryable upstream error)", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("glm_error");
  });

  it("an unknown business code without text → 502 glm_error (never retryable)", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json({ code: 12345, message: "mystery" }),
      ),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("glm_error");
  });

  it("remote without ZAI_API_KEY → 503 glm_model_unavailable (never a local fallback)", async () => {
    useRemote();
    vi.stubEnv("ZAI_API_KEY", "");
    lecturerContext();
    let upstreamCalls = 0;
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () => {
        upstreamCalls++;
        return HttpResponse.json(remoteOk());
      }),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("glm_model_unavailable");
    expect(upstreamCalls).toBe(0);
  });

  it("GLM_SPEND_DISABLED=1 → 503 glm_model_unavailable with NO upstream call", async () => {
    useRemote();
    vi.stubEnv("GLM_SPEND_DISABLED", "1");
    lecturerContext();
    let upstreamCalls = 0;
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () => {
        upstreamCalls++;
        return HttpResponse.json(remoteOk());
      }),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("glm_model_unavailable");
    expect(upstreamCalls).toBe(0);
  });

  it("daily token cap reached → 429 glm_spend_cap with NO upstream call", async () => {
    useRemote();
    vi.stubEnv("GLM_DAILY_TOKEN_CAP", "500");
    lecturerContext();
    let upstreamCalls = 0;
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () => {
        upstreamCalls++;
        return HttpResponse.json(remoteOk());
      }),
    );
    const route = await importRoute();
    // First call succeeds and consumes the budget (300 tokens)...
    expect((await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }))).status).toBe(200);
    expect(upstreamCalls).toBe(1);
    // ...the second sees the cap (300 < 500 but 600 > 500 after the record).
    const second = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(second.status).toBe(200);
    expect(upstreamCalls).toBe(2);
    // Third call: 600 used ≥ 500 cap.
    const third = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(third.status).toBe(429);
    expect((await third.json()).error).toBe("glm_spend_cap");
    expect(upstreamCalls).toBe(2);
  });

  it("records the spend + a redacted usage line after a success (never the key)", async () => {
    useRemote();
    lecturerContext();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json(
          remoteOk({
            usage: { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 },
          }),
        ),
      ),
    );
    vi.stubEnv("GLM_TOKEN_PRICE_PER_MILLION", "0.03");
    const route = await importRoute();
    expect((await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }))).status).toBe(200);

    // Durable ledger: today's bucket carries the user's tokens + calls.
    const ledger = JSON.parse(readFileSync(spendLedger, "utf8"));
    const day = Object.keys(ledger)[0];
    expect(ledger[day][LECTURER_ID].tokens).toBe(3000);
    expect(ledger[day][LECTURER_ID].calls).toBe(1);
    expect(ledger[day][LECTURER_ID].usd).toBeCloseTo(3000 / 1e6 * 0.03, 9);

    // Redacted usage log line.
    const line = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[glm-usage]"));
    expect(line).toBeDefined();
    const payload = JSON.parse(String(line).slice(String(line).indexOf("{")));
    expect(payload).toMatchObject({
      userId: LECTURER_ID,
      provider: "remote",
      model: "glm-ocr",
      numPages: 12,
      totalTokens: 3000,
    });
    expect(String(line)).not.toContain("zai-test-secret");
  });

  it("does NOT spend or record on the LOCAL leg", async () => {
    lecturerContext();
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, () =>
        HttpResponse.json({ data: [{ id: "glm-ocr" }] }),
      ),
      http.post(`${GLM_BASE}/v1/chat/completions`, () =>
        HttpResponse.json({ choices: [{ message: { content: "page text" } }] }),
      ),
    );
    const route = await importRoute();
    expect((await route.POST(post({ image: PNG_DATAURL }))).status).toBe(200);
    // No ledger file was ever created for a local run.
    expect(() => readFileSync(spendLedger, "utf8")).toThrow();
  });

  it("an unparseable body on the remote leg → 400 glm_error", async () => {
    useRemote();
    lecturerContext();
    const route = await importRoute();
    for (const body of [
      {},
      { file: PNG_DATAURL },
      { file: PNG_DATAURL, kind: "docx" },
      { file: 42, kind: "pdf" },
      { file: "", kind: "pdf" },
      { image: "not-a-dataurl" },
    ]) {
      const res = await route.POST(post(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("glm_error");
    }
  });
});

/**
 * Defect #4 — billed calls the ledger never recorded.
 *
 * The old route recorded spend ONLY when `res.ok === true`. An HTTP-200 error
 * envelope carrying `usage.total_tokens: 999999` recorded NOTHING (the ledger
 * file was never created) — and that is precisely the G9 shape where upstream
 * may well have done the work. A success whose `usage` was absent recorded 0,
 * and a timeout recorded nothing.
 */
describe("spend accounting covers every billed attempt (defect #4)", () => {
  const readLedger = () => JSON.parse(readFileSync(spendLedger, "utf8"));

  it("records usage from an HTTP-200 error envelope (the 999999 case)", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json({ code: 77777, message: "capacity degraded", usage: { total_tokens: 999_999 } }),
      ),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    // Still a typed failure to the CLIENT (no text was returned)…
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("glm_error");
    // …but the MONEY was spent and is now recorded.
    const ledger = readLedger();
    expect(ledger[Object.keys(ledger)[0]][LECTURER_ID].tokens).toBe(999_999);
    expect(ledger[Object.keys(ledger)[0]][LECTURER_ID].calls).toBe(1);
  });

  it("records a string-typed total_tokens instead of coercing it to 0", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json(remoteOk({ usage: { total_tokens: "3000" } })),
      ),
    );
    const route = await importRoute();
    expect((await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }))).status).toBe(200);
    const ledger = readLedger();
    expect(ledger[Object.keys(ledger)[0]][LECTURER_ID].tokens).toBe(3000);
  });

  it("records an ABSENT usage as usagePresent:false (honest gap, not a free call)", async () => {
    useRemote();
    lecturerContext();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json({ code: 0, md_results: "# deck", data_info: { num_pages: 3 } }),
      ),
    );
    const route = await importRoute();
    expect((await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }))).status).toBe(200);
    const line = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[glm-usage]"));
    expect(line).toBeDefined();
    const payload = JSON.parse(String(line).slice(String(line).indexOf("{")));
    expect(payload.usagePresent).toBe(false);
    expect(payload.totalTokens).toBe(0);
    // The call is still counted — the work happened.
    expect(glmSpendCalls(LECTURER_ID)).toBe(1);
  });

  it("records the degraded success's usage (it was billed)", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json(
          remoteOk({ code: 77777, message: "capacity degraded", usage: { total_tokens: 4321 } }),
        ),
      ),
    );
    const route = await importRoute();
    expect((await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }))).status).toBe(200);
    expect(glmSpendUsed(LECTURER_ID)).toBe(4321);
  });

  it("logs the accounting gap when a remote attempt produces no usage data", async () => {
    useRemote();
    lecturerContext();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () => HttpResponse.error()),
    );
    const route = await importRoute();
    await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("no usage data"));
    expect(line).toBeDefined();
    expect(line).toContain("NOT accounted");
    // Never the key.
    expect(String(line)).not.toContain("zai-test-secret");
  });
});

/**
 * Defect #6 — the upstream business `code` must reach a redacted log line on
 * every degraded/error path, per-user. The plan requires it; the empty code
 * extension point is useless if an operator cannot see WHICH code is firing.
 */
describe("upstream code/message reaches the ops log (defect #6)", () => {
  it("logs the code + message for a DEGRADED 200 (77777)", async () => {
    useRemote();
    lecturerContext();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json(remoteOk({ code: 77777, message: "capacity degraded" })),
      ),
    );
    const route = await importRoute();
    expect((await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }))).status).toBe(200);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("[glm-ocr-code]"));
    expect(line).toBeDefined();
    const payload = JSON.parse(String(line).slice(String(line).indexOf("{")));
    expect(payload).toMatchObject({
      userId: LECTURER_ID,
      provider: "remote",
      outcome: "degraded",
      code: "77777",
      // `degradedReason` is the `code: message` pair.
      message: "77777: capacity degraded",
    });
    expect(String(line)).not.toContain("zai-test-secret");
  });

  it("logs the code for an ERROR envelope with no text (88888 → 502)", async () => {
    useRemote();
    lecturerContext();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json({ code: 88888, message: "mystery failure" }),
      ),
    );
    const route = await importRoute();
    expect((await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }))).status).toBe(502);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("[glm-ocr-code]"));
    expect(line).toBeDefined();
    expect(line).toContain("88888");
    const payload = JSON.parse(String(line).slice(String(line).indexOf("{")));
    expect(payload).toMatchObject({ outcome: "error:ai_error", code: "88888" });
  });

  it("logs the code for an auth envelope (401 on HTTP 200)", async () => {
    useRemote();
    lecturerContext();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json({ code: 401, message: "invalid api key", md_results: "text" }),
      ),
    );
    const route = await importRoute();
    expect((await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }))).status).toBe(503);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("[glm-ocr-code]"));
    expect(line).toContain("401");
    expect(line).toContain("error:auth");
  });

  it("never logs the key, even when upstream echoes it in the message", async () => {
    useRemote();
    lecturerContext();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json({
          code: 55555,
          message: "credential zai-test-secret rejected",
          md_results: "text",
        }),
      ),
    );
    const route = await importRoute();
    await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    const all = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(all).not.toContain("zai-test-secret");
    expect(all).toContain("[redacted]");
  });
});

/**
 * Defect #7 — gate G4 for an HTTP-200 auth envelope. With `ZAI_AUTH_CODES`
 * empty, `{code:403, md_results:"text"}` on HTTP 200 returned 200
 * `degraded:true` — an entitlement failure reported as a successful extraction.
 */
describe("HTTP-200 auth envelope is never a silent success (defect #7)", () => {
  it.each([401, 403])("code %i WITH text → 503 glm_model_unavailable", async (code) => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json(remoteOk({ code, message: "no entitlement" })),
      ),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("glm_model_unavailable");
    // NEVER a success body, and never glm_error.
    expect(body.text).toBeUndefined();
    expect(body.degraded).toBeUndefined();
  });

  it.each([401, 403])("code %i WITHOUT text → 503 glm_model_unavailable", async (code) => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json({ code, message: "no entitlement" }),
      ),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("glm_model_unavailable");
  });

  it("still records the billed auth envelope's usage", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json(remoteOk({ code: 403, usage: { total_tokens: 77 } })),
      ),
    );
    const route = await importRoute();
    await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(glmSpendUsed(LECTURER_ID)).toBe(77);
  });
});

/**
 * Defect #10 — two reporting deviations + the unknown-page-count fabrication.
 */
describe("remote reporting deviations (defect #10)", () => {
  it("an over-cap dataUrl → 413 payload_too_large, NOT 400 glm_error", async () => {
    useRemote();
    lecturerContext();
    // Over REMOTE_MAX_DATAURL_CHARS but under the body cap (which adds slack).
    const huge = `data:application/pdf;base64,${"A".repeat(36_000_100)}`;
    const route = await importRoute();
    const res = await route.POST(post({ file: huge, kind: "pdf" }));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("payload_too_large");
  });

  it("reports pages:null (not a fabricated 1) when the page count is unknown", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        // No data_info at all → the page count is genuinely unknown.
        HttpResponse.json({ code: 0, md_results: "# deck", usage: { total_tokens: 10 } }),
      ),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.numPages).toBeNull();
    // The contract asks for `numPages: null` while keeping `pages` present so
    // the current client (numPages ?? pages ?? 1) can distinguish unknown.
    expect(body).toHaveProperty("pages");
    expect(body.pages).toBeNull();
  });

  it("still reports a real page count when upstream provides one", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () => HttpResponse.json(remoteOk())),
    );
    const route = await importRoute();
    const body = await (await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }))).json();
    expect(body.numPages).toBe(12);
    expect(body.pages).toBe(12);
  });
});

/**
 * Defect #11 — a body carrying BOTH `image` and `file`.
 *
 * The baseline LOCAL leg read `image` and ignored `file` → 200. Rejecting is
 * the deliberate choice (silently picking one of two conflicting payloads is
 * how a client bug becomes "we transcribed the wrong thing" with no signal);
 * this test PINS it so the behaviour change is covered rather than incidental.
 */
describe("a body carrying both `image` and `file` is rejected (defect #11)", () => {
  it("LOCAL leg → 400 glm_error with NO upstream call", async () => {
    lecturerContext();
    let upstreamCalls = 0;
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, () => {
        upstreamCalls++;
        return HttpResponse.json({ data: [{ id: "glm-ocr" }] });
      }),
      http.post(`${GLM_BASE}/v1/chat/completions`, () => {
        upstreamCalls++;
        return HttpResponse.json({ choices: [{ message: { content: "text" } }] });
      }),
    );
    const route = await importRoute();
    const res = await route.POST(post({ image: PNG_DATAURL, file: PNG_DATAURL, kind: "image" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("glm_error");
    expect(upstreamCalls).toBe(0);
  });

  it("REMOTE leg → 400 glm_error with NO upstream call", async () => {
    useRemote();
    lecturerContext();
    let upstreamCalls = 0;
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () => {
        upstreamCalls++;
        return HttpResponse.json(remoteOk());
      }),
    );
    const route = await importRoute();
    const res = await route.POST(post({ image: PNG_DATAURL, file: PDF_DATAURL, kind: "pdf" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("glm_error");
    expect(upstreamCalls).toBe(0);
  });
});

/**
 * Defect #12 — the PDF page lower bound is a LOWER BOUND, and the route must be
 * honest about it rather than pretending the pre-flight is reliable.
 */
describe("PDF page lower bound is honest about its limits (defect #12)", () => {
  it("a compressed-object-stream PDF PASSES the pre-flight, is refused post-response, and the spend IS recorded", async () => {
    useRemote();
    lecturerContext();
    vi.stubEnv("GLM_REMOTE_MAX_PAGES", "5");
    let upstreamCalls = 0;
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () => {
        upstreamCalls++;
        // The real page count only becomes visible HERE (post-response).
        return HttpResponse.json(
          remoteOk({ data_info: { num_pages: 300 }, usage: { total_tokens: 12_345 } }),
        );
      }),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: compressedObjStmPdfDataUrl(300), kind: "pdf" }));
    // (a) the pre-flight could NOT see the 300 pages, so the billed call happened
    expect(upstreamCalls).toBe(1);
    // (b) the post-check refused it
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("glm_error");
    // (c) the real spend is recorded — the backstop is not a silent loss
    const ledger = JSON.parse(readFileSync(spendLedger, "utf8"));
    expect(ledger[Object.keys(ledger)[0]][LECTURER_ID].tokens).toBe(12_345);
  });

  it("logs the over-cap paid call LOUDLY with the real spend and page count", async () => {
    useRemote();
    lecturerContext();
    vi.stubEnv("GLM_REMOTE_MAX_PAGES", "5");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json(
          remoteOk({ data_info: { num_pages: 300 }, usage: { total_tokens: 12_345 } }),
        ),
      ),
    );
    const route = await importRoute();
    await route.POST(post({ file: compressedObjStmPdfDataUrl(300), kind: "pdf" }));
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("OVER-CAP PAID CALL"));
    expect(line).toBeDefined();
    expect(line).toContain("300");
    expect(line).toContain("12345");
    expect(line).toContain("BILLED");
  });

  it("does NOT refuse a valid compressed PDF whose lower bound is 0", async () => {
    useRemote();
    lecturerContext();
    vi.stubEnv("GLM_REMOTE_MAX_PAGES", "5");
    let upstreamCalls = 0;
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () => {
        upstreamCalls++;
        // A genuinely small compressed PDF: unknown to the regex, fine upstream.
        return HttpResponse.json(remoteOk({ data_info: { num_pages: 3 } }));
      }),
    );
    const route = await importRoute();
    const res = await route.POST(post({ file: compressedObjStmPdfDataUrl(3), kind: "pdf" }));
    // A lower bound of 0 must NOT reject the document — that would refuse
    // valid PDFs.
    expect(upstreamCalls).toBe(1);
    expect(res.status).toBe(200);
  });
});

/**
 * Defect #5 (route side) — the billed GET probe is metered and accounted.
 */
describe("GET probe spend accounting (defect #5)", () => {
  it("books the probe's usage and counts it against the requesting user", async () => {
    useRemote();
    lecturerContext();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () =>
        HttpResponse.json(remoteOk({ data_info: { num_pages: 1 }, usage: { total_tokens: 42 } })),
      ),
    );
    const route = await importRoute();
    expect((await route.GET()).status).toBe(200);
    // The ledger exists and carries the probe spend under both identities.
    const ledger = JSON.parse(readFileSync(spendLedger, "utf8"));
    const bucket = ledger[Object.keys(ledger)[0]];
    expect(bucket[LECTURER_ID].tokens).toBe(42);
    expect(bucket["__glm_probe__"].tokens).toBe(42);
  });

  it("an over-cap user's GET does NOT bill a probe", async () => {
    useRemote();
    vi.stubEnv("GLM_DAILY_TOKEN_CAP", "10");
    lecturerContext();
    let upstreamCalls = 0;
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () => {
        upstreamCalls++;
        return HttpResponse.json(
          remoteOk({ data_info: { num_pages: 1 }, usage: { total_tokens: 100 } }),
        );
      }),
    );
    const route = await importRoute();
    // First GET probes and consumes the budget (100 > 10 cap).
    expect((await route.GET()).status).toBe(200);
    expect(upstreamCalls).toBe(1);
    _resetGlmHealthForTests();
    // Second GET: the user is over cap → no billed probe.
    const second = await route.GET();
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.available).toBe(false);
    expect(upstreamCalls).toBe(1);
  });

  it("does not charge the probe to a LOCAL user (the local probe is free)", async () => {
    lecturerContext();
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, () => HttpResponse.json({ data: [{ id: "glm-ocr" }] })),
    );
    const route = await importRoute();
    expect((await route.GET()).status).toBe(200);
    // No ledger file at all for a local probe.
    expect(() => readFileSync(spendLedger, "utf8")).toThrow();
  });
});

/**
 * Defect #1 (route side) — the GET verdict must never be served for the WRONG
 * leg. This is the end-to-end shape of the critic's measurement: a flip from
 * local to remote with no restart used to serve `{provider:"local",
 * maxPages:200}` for up to 300 s, so the client took the per-page path and
 * billed N calls for an N-page deck instead of one.
 */
describe("GET never serves the wrong leg's verdict after an env flip (defect #1)", () => {
  it("reports the REMOTE leg immediately after a local→remote flip", async () => {
    lecturerContext();
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, () => HttpResponse.json({ data: [{ id: "glm-ocr" }] })),
    );
    const route = await importRoute();
    const first = await (await route.GET()).json();
    expect(first.provider).toBe("local");
    expect(first.maxPages).toBe(200);

    // Flip with NO restart and NO explicit cache reset.
    useRemote();
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () => HttpResponse.json(remoteOk())),
    );
    const second = await (await route.GET()).json();
    expect(second.provider).toBe("remote");
    expect(second.maxPages).toBe(30);
    expect(second.cached).toBe(false);
  });

  it("a POST is not short-circuited by the OTHER leg's stale negative verdict", async () => {
    // Local leg: container down → a cached `unreachable` verdict.
    lecturerContext();
    defaultAiServer.use(
      http.get(`${GLM_BASE}/v1/models`, () => HttpResponse.error()),
    );
    const route = await importRoute();
    await route.GET();

    // Flip to remote and POST: the stale local negative must not 503 it.
    useRemote();
    let upstreamCalls = 0;
    defaultAiServer.use(
      http.post(`${ZAI_BASE}/layout_parsing`, () => {
        upstreamCalls++;
        return HttpResponse.json(remoteOk());
      }),
    );
    const res = await route.POST(post({ file: PDF_DATAURL, kind: "pdf" }));
    expect(upstreamCalls).toBe(1);
    expect(res.status).toBe(200);
  });
});
