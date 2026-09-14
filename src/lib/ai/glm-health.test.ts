import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GLM_PROBE_NEGATIVE_TTL_MS,
  DEFAULT_GLM_PROBE_TTL_MS,
  GLM_PROBE_PNG_DATA_URL,
  GLM_PROBE_SPEND_USER,
  GLM_PROBE_TIMEOUT_MS,
  _resetGlmHealthForTests,
  fingerprintSecret,
  glmHealth,
  glmHealthCached,
  glmProbeNegativeTtlMs,
  glmProbeTtlMs,
} from "@/lib/ai/glm-health";
import {
  _resetGlmSpendForTests,
  glmSpendCalls,
  glmSpendUsed,
} from "@/lib/ai/glm-spend";

/**
 * glm-health — the cached, reasoned liveness verdict (gates G4 + G7).
 *
 * The money rule: on the REMOTE leg the probe is a BILLED `layout_parsing`
 * POST. These tests pin (a) that it is only run on a cold/stale cache, (b) that
 * `glmHealthCached()` NEVER probes, and (c) that the verdict carries a REASON —
 * a boolean conflates a dead key with a capacity blip and the picker then lies.
 */

const LOCAL_BASE = "http://127.0.0.1:59999";
const REMOTE_BASE = "https://api.z.ai/api/paas/v4";

/** Count fetch calls and answer each with a canned Response. */
function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    return handler(String(url));
  });
  vi.stubGlobal("fetch", fetchImpl);
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The remote success envelope for the tiny probe image. */
const REMOTE_OK = { code: 0, md_results: "# probe", data_info: { num_pages: 1 }, usage: { total_tokens: 3 } };

let spendDir: string;
let spendLedger: string;

beforeEach(() => {
  _resetGlmHealthForTests();
  spendDir = mkdtempSync(join(tmpdir(), "glm-health-spend-"));
  spendLedger = join(spendDir, "ledger.json");
  _resetGlmSpendForTests(spendLedger);
  vi.unstubAllEnvs();
  vi.stubEnv("GLM_PROVIDER", "local");
  vi.stubEnv("GLM_BASE_URL", LOCAL_BASE);
  vi.stubEnv("OCR_GLM_MODEL", "glm-ocr");
  vi.stubEnv("GLM_PROBE_TTL_MS", "");
  vi.stubEnv("GLM_PROBE_NEGATIVE_TTL_MS", "");
  vi.stubEnv("GLM_SPEND_DISABLED", "");
  vi.stubEnv("GLM_DAILY_TOKEN_CAP", "");
  vi.stubEnv("ZAI_API_KEY", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetGlmHealthForTests();
  _resetGlmSpendForTests(null);
  try {
    rmSync(spendDir, { recursive: true, force: true });
  } catch {
    // Disposable temp dir.
  }
});

describe("local leg — free GET probe", () => {
  it("reports ok when the model is listed", async () => {
    const calls = stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
    const h = await glmHealth();
    expect(h.available).toBe(true);
    expect(h.reason).toBe("ok");
    expect(h.provider).toBe("local");
    expect(h.cached).toBe(false);
    expect(h.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(calls[0]).toContain("/v1/models");
  });

  it("reports 'unreachable' when the container is down (never a bare false)", async () => {
    stubFetch(() => {
      throw new TypeError("ECONNREFUSED");
    });
    const h = await glmHealth();
    expect(h.available).toBe(false);
    expect(h.reason).toBe("unreachable");
  });

  it("carries the provider caps for the picker", async () => {
    stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
    const h = await glmHealth();
    expect(h.maxPages).toBe(200);
    expect(h.maxPdfBytes).toBe(0);
    expect(h.maxImageBytes).toBeGreaterThan(0);
  });
});

describe("remote leg — real, billed, cached probe (G4/G7)", () => {
  beforeEach(() => {
    vi.stubEnv("GLM_PROVIDER", "remote");
    vi.stubEnv("ZAI_BASE_URL", REMOTE_BASE);
    vi.stubEnv("ZAI_API_KEY", "zai-test-key");
  });

  it("POSTs the tiny PNG to /layout_parsing (the only probe that proves key + balance + entitlement)", async () => {
    const seen: { url: string; body: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        seen.push({
          url: String(url),
          body: String(init?.body ?? ""),
          auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null,
        });
        return json(REMOTE_OK);
      }),
    );
    const h = await glmHealth();
    expect(h.available).toBe(true);
    expect(h.reason).toBe("ok");
    expect(h.provider).toBe("remote");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${REMOTE_BASE}/layout_parsing`);
    expect(seen[0].auth).toBe("Bearer zai-test-key");
    const sent = JSON.parse(seen[0].body);
    expect(sent.file).toBe(GLM_PROBE_PNG_DATA_URL);
    expect(sent.model).toBe("glm-ocr");
    // G10: never the tracking/range fields.
    expect(sent).not.toHaveProperty("user_id");
    expect(sent).not.toHaveProperty("start_page_id");
    expect(sent).not.toHaveProperty("end_page_id");
  });

  it("maps 401 → reason 'auth' (gate G4)", async () => {
    stubFetch(() => json({ code: 1, message: "bad key" }, 401));
    const h = await glmHealth();
    expect(h.available).toBe(false);
    expect(h.reason).toBe("auth");
  });

  it("maps 429 → reason 'rate_limited'", async () => {
    stubFetch(() => json({ message: "slow down" }, 429));
    const h = await glmHealth();
    expect(h.reason).toBe("rate_limited");
  });

  it("maps a transport failure → reason 'unreachable'", async () => {
    stubFetch(() => {
      throw new TypeError("ENOTFOUND");
    });
    expect((await glmHealth()).reason).toBe("unreachable");
  });

  it("maps a non-JSON/garbage 200 → reason 'error'", async () => {
    stubFetch(() => new Response("<html>", { status: 200 }));
    expect((await glmHealth()).reason).toBe("error");
  });

  it("uses the 5s probe timeout (a slow Z.ai must not hold the picker)", async () => {
    expect(GLM_PROBE_TIMEOUT_MS).toBe(5_000);
    // A fetch that never settles must abort at the probe timeout. The module
    // hard-codes 5s, so shorten the wait by faking timers for the abort only.
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("aborted", "AbortError"));
              });
            }),
        ),
      );
      const pending = glmHealth();
      await vi.advanceTimersByTimeAsync(GLM_PROBE_TIMEOUT_MS + 1);
      const h = await pending;
      expect(h.available).toBe(false);
      expect(h.reason).toBe("unreachable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT spend when ZAI_API_KEY is missing → 'misconfigured'", async () => {
    vi.stubEnv("ZAI_API_KEY", "");
    const calls = stubFetch(() => json(REMOTE_OK));
    const h = await glmHealth();
    expect(h.available).toBe(false);
    expect(h.reason).toBe("misconfigured");
    expect(h.provider).toBe("remote"); // never silently falls back to local
    expect(calls).toHaveLength(0);
  });

  it("reports 'disabled' (and does not spend) when GLM_SPEND_DISABLED=1", async () => {
    vi.stubEnv("GLM_SPEND_DISABLED", "1");
    const calls = stubFetch(() => json(REMOTE_OK));
    const h = await glmHealth();
    expect(h.available).toBe(false);
    expect(h.reason).toBe("disabled");
    expect(calls).toHaveLength(0);
  });

  it("reports the remote caps", async () => {
    stubFetch(() => json(REMOTE_OK));
    const h = await glmHealth();
    expect(h.maxPages).toBe(30);
    expect(h.maxImageBytes).toBe(10 * 1024 * 1024);
    expect(h.maxPdfBytes).toBe(50 * 1024 * 1024);
  });
});

describe("caching — TTLs and the never-probe contract", () => {
  it("serves a cached positive verdict WITHOUT a second upstream call", async () => {
    const calls = stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
    await glmHealth();
    const second = await glmHealth();
    expect(second.available).toBe(true);
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("re-probes once the positive TTL has elapsed", async () => {
    const calls = stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
    await glmHealth();
    const realNow = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(realNow + DEFAULT_GLM_PROBE_TTL_MS + 1);
    const second = await glmHealth();
    now.mockRestore();
    expect(second.cached).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("honours a custom positive TTL from env", async () => {
    vi.stubEnv("GLM_PROBE_TTL_MS", "50");
    expect(glmProbeTtlMs()).toBe(50);
    const calls = stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
    await glmHealth();
    const realNow = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(realNow + 51);
    await glmHealth();
    now.mockRestore();
    expect(calls).toHaveLength(2);
  });

  it("caches a NEGATIVE verdict for the shorter negative TTL", async () => {
    expect(glmProbeNegativeTtlMs()).toBe(DEFAULT_GLM_PROBE_NEGATIVE_TTL_MS);
    const calls = stubFetch(() => {
      throw new TypeError("ECONNREFUSED");
    });
    await glmHealth();
    // Still fresh at 1s.
    const now1 = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
    const cachedVerdict = await glmHealth();
    now1.mockRestore();
    expect(cachedVerdict.cached).toBe(true);
    expect(calls).toHaveLength(1);
    // Stale past the negative TTL → re-probe.
    const now2 = vi.spyOn(Date, "now").mockReturnValue(Date.now() + DEFAULT_GLM_PROBE_NEGATIVE_TTL_MS + 1);
    await glmHealth();
    now2.mockRestore();
    expect(calls).toHaveLength(2);
  });

  it("falls back to the default TTLs for garbage env values", () => {
    vi.stubEnv("GLM_PROBE_TTL_MS", "abc");
    vi.stubEnv("GLM_PROBE_NEGATIVE_TTL_MS", "-1");
    expect(glmProbeTtlMs()).toBe(DEFAULT_GLM_PROBE_TTL_MS);
    expect(glmProbeNegativeTtlMs()).toBe(DEFAULT_GLM_PROBE_NEGATIVE_TTL_MS);
  });

  it("force:true bypasses the cache read but refreshes it", async () => {
    const calls = stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
    await glmHealth();
    const forced = await glmHealth({ force: true });
    expect(forced.cached).toBe(false);
    expect(calls).toHaveLength(2);
    const after = await glmHealth();
    expect(after.cached).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("collapses concurrent cold probes onto ONE upstream call", async () => {
    // On the remote leg each probe costs money, so a burst of picker opens
    // must not bill once per request.
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    const calls = stubFetch(async () => {
      await gate;
      return json({ data: [{ id: "glm-ocr" }] });
    });
    const p1 = glmHealth();
    const p2 = glmHealth();
    const p3 = glmHealth();
    resolveGate();
    const results = await Promise.all([p1, p2, p3]);
    expect(calls).toHaveLength(1);
    for (const h of results) expect(h.available).toBe(true);
  });

  it("re-probes after _resetGlmHealthForTests", async () => {
    const calls = stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
    await glmHealth();
    _resetGlmHealthForTests();
    await glmHealth();
    expect(calls).toHaveLength(2);
  });
});

describe("glmHealthCached — POST-path shortcut (NEVER probes)", () => {
  it("returns null on a cold cache and performs NO upstream call", () => {
    const calls = stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
    expect(glmHealthCached()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns the fresh verdict, marked cached", async () => {
    stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
    await glmHealth();
    const c = glmHealthCached();
    expect(c).not.toBeNull();
    expect(c?.available).toBe(true);
    expect(c?.cached).toBe(true);
  });

  it("returns null once the verdict is stale (never an uncached billed call)", async () => {
    stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
    await glmHealth();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + DEFAULT_GLM_PROBE_TTL_MS + 1);
    expect(glmHealthCached()).toBeNull();
    now.mockRestore();
  });

  it("returns a fresh NEGATIVE verdict (the POST path uses it to short-circuit)", async () => {
    vi.stubEnv("GLM_PROVIDER", "remote");
    vi.stubEnv("ZAI_API_KEY", "k");
    stubFetch(() => json({}, 401));
    await glmHealth();
    const c = glmHealthCached();
    expect(c?.available).toBe(false);
    expect(c?.reason).toBe("auth");
  });

  it("performs NO fetch even when a stale verdict exists", async () => {
    const calls = stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
    await glmHealth();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + DEFAULT_GLM_PROBE_TTL_MS + 1);
    glmHealthCached();
    glmHealthCached();
    now.mockRestore();
    expect(calls).toHaveLength(1);
  });
});

/**
 * Defect #1 — the cache identity tuple.
 *
 * The old cache held ONE slot and read it without comparing the env it came
 * from. Measured consequences: flipping GLM_PROVIDER local→remote with no
 * restart served `{provider:"local",maxPages:200}` for up to 300 s (the client
 * then takes the per-page path and bills N calls for an N-page deck instead of
 * one); a stale NEGATIVE verdict from the other leg 503'd every POST with zero
 * upstream calls; a key rotation kept reporting the old key's `auth` failure.
 */
describe("cache identity — an env change is a MISS, never a stale hit (defect #1)", () => {
  it("does NOT serve the local verdict after a flip to remote", async () => {
    const calls = stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
    const local = await glmHealth();
    expect(local.provider).toBe("local");
    expect(local.maxPages).toBe(200);
    expect(calls).toHaveLength(1);

    // Flip the leg with NO restart and NO cache reset — exactly the operator
    // action that used to serve the wrong leg's verdict for 300 s.
    vi.stubEnv("GLM_PROVIDER", "remote");
    vi.stubEnv("ZAI_API_KEY", "zai-key");
    vi.stubEnv("ZAI_BASE_URL", REMOTE_BASE);
    vi.unstubAllGlobals();
    const remoteCalls = stubFetch(() => json(REMOTE_OK));

    const remote = await glmHealth();
    expect(remote.cached).toBe(false);
    expect(remote.provider).toBe("remote");
    expect(remote.maxPages).toBe(30);
    // A real probe ran for the new leg — the local verdict was NOT reused.
    expect(remoteCalls).toHaveLength(1);
  });

  it("does NOT serve the remote verdict after a flip back to local", async () => {
    vi.stubEnv("GLM_PROVIDER", "remote");
    vi.stubEnv("ZAI_API_KEY", "zai-key");
    vi.stubEnv("ZAI_BASE_URL", REMOTE_BASE);
    stubFetch(() => json(REMOTE_OK));
    expect((await glmHealth()).provider).toBe("remote");

    vi.stubEnv("GLM_PROVIDER", "local");
    vi.stubEnv("GLM_BASE_URL", LOCAL_BASE);
    vi.unstubAllGlobals();
    const calls = stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
    const local = await glmHealth();
    expect(local.provider).toBe("local");
    expect(local.maxPages).toBe(200);
    expect(calls[0]).toContain("/v1/models");
  });

  it("does NOT 503 every POST from a stale NEGATIVE verdict of the other leg", async () => {
    // Local leg, container down → cached `unreachable`.
    stubFetch(() => {
      throw new TypeError("ECONNREFUSED");
    });
    expect((await glmHealth()).reason).toBe("unreachable");

    // Flip to remote: the stale negative must NOT short-circuit the POST path.
    vi.stubEnv("GLM_PROVIDER", "remote");
    vi.stubEnv("ZAI_API_KEY", "zai-key");
    vi.stubEnv("ZAI_BASE_URL", REMOTE_BASE);
    expect(glmHealthCached()).toBeNull();

    vi.unstubAllGlobals();
    stubFetch(() => json(REMOTE_OK));
    const remote = await glmHealth();
    expect(remote.available).toBe(true);
    expect(remote.reason).toBe("ok");
  });

  it("invalidates on a key ROTATION (never the old key's auth verdict)", async () => {
    vi.stubEnv("GLM_PROVIDER", "remote");
    vi.stubEnv("ZAI_BASE_URL", REMOTE_BASE);
    vi.stubEnv("ZAI_API_KEY", "dead-key");
    stubFetch(() => json({ code: 401, message: "bad key" }, 401));
    expect((await glmHealth()).reason).toBe("auth");
    expect(glmHealthCached()?.reason).toBe("auth");

    // Rotate the key with no restart: the new key must be probed for real.
    vi.stubEnv("ZAI_API_KEY", "live-key");
    expect(glmHealthCached()).toBeNull();
    vi.unstubAllGlobals();
    const calls = stubFetch(() => json(REMOTE_OK));
    const after = await glmHealth();
    expect(after.available).toBe(true);
    expect(after.reason).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("invalidates on a baseUrl / model / maxPages change", async () => {
    for (const [key, value] of [
      ["GLM_BASE_URL", "http://127.0.0.1:59998"],
      ["OCR_GLM_MODEL", "other-model"],
    ] as const) {
      _resetGlmHealthForTests();
      vi.unstubAllGlobals();
      stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
      await glmHealth();
      expect(glmHealthCached()).not.toBeNull();
      vi.stubEnv(key, value);
      expect(glmHealthCached()).toBeNull();
      vi.stubEnv(key, key === "GLM_BASE_URL" ? LOCAL_BASE : "glm-ocr");
    }
    // maxPages lives on the remote leg.
    _resetGlmHealthForTests();
    vi.stubEnv("GLM_PROVIDER", "remote");
    vi.stubEnv("ZAI_API_KEY", "k");
    vi.stubEnv("ZAI_BASE_URL", REMOTE_BASE);
    vi.unstubAllGlobals();
    stubFetch(() => json(REMOTE_OK));
    expect((await glmHealth()).maxPages).toBe(30);
    expect(glmHealthCached()?.maxPages).toBe(30);
    vi.stubEnv("GLM_REMOTE_MAX_PAGES", "100");
    expect(glmHealthCached()).toBeNull();
  });

  it("still serves a cache HIT for the SAME identity (the cache is not disabled)", async () => {
    const calls = stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
    await glmHealth();
    const second = await glmHealth();
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("does NOT answer an in-flight probe for a DIFFERENT identity", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        await gate;
        return json({ data: [{ id: "glm-ocr" }] });
      }),
    );
    const first = glmHealth(); // local identity, in flight
    vi.stubEnv("GLM_BASE_URL", "http://127.0.0.1:59998");
    const second = glmHealth(); // different identity → must NOT join
    release();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(2);
  });

  it("fingerprintSecret is one-way, stable and never the key itself", () => {
    const fp = fingerprintSecret("super-secret-key-value");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain("super");
    expect(fp).toBe(fingerprintSecret("super-secret-key-value"));
    expect(fp).not.toBe(fingerprintSecret("super-secret-key-valuE"));
    expect(fingerprintSecret(undefined)).toBe("-");
    expect(fingerprintSecret("")).toBe("-");
  });

  it("never puts the key (or its fingerprint) into the returned verdict", async () => {
    vi.stubEnv("GLM_PROVIDER", "remote");
    vi.stubEnv("ZAI_BASE_URL", REMOTE_BASE);
    vi.stubEnv("ZAI_API_KEY", "zai-super-secret-value");
    stubFetch(() => json(REMOTE_OK));
    const h = await glmHealth();
    const raw = JSON.stringify(h);
    expect(raw).not.toContain("zai-super-secret-value");
    expect(raw).not.toContain(fingerprintSecret("zai-super-secret-value"));
  });
});

/**
 * Defect #5 — the billed probe is metered and accounted.
 *
 * The remote probe is a real `layout_parsing` POST. It used to bypass both
 * `checkGlmSpend` and `recordGlmSpend`: an over-cap user still triggered a
 * billed probe on every cold cache, and five users each billed one.
 */
describe("probe spend accounting (defect #5)", () => {
  const USER = "00000000-0000-4000-8000-00000000000a";

  beforeEach(() => {
    vi.stubEnv("GLM_PROVIDER", "remote");
    vi.stubEnv("ZAI_BASE_URL", REMOTE_BASE);
    vi.stubEnv("ZAI_API_KEY", "zai-key");
  });

  it("books the probe's usage under the reserved pseudo-user", async () => {
    stubFetch(() =>
      json({ code: 0, md_results: "# probe", data_info: { num_pages: 1 }, usage: { total_tokens: 42 } }),
    );
    await glmHealth();
    expect(glmSpendUsed(GLM_PROBE_SPEND_USER)).toBe(42);
    expect(glmSpendCalls(GLM_PROBE_SPEND_USER)).toBe(1);
  });

  it("also counts the probe against the REQUESTING user when known", async () => {
    stubFetch(() =>
      json({ code: 0, md_results: "# probe", data_info: { num_pages: 1 }, usage: { total_tokens: 42 } }),
    );
    await glmHealth({ userId: USER });
    expect(glmSpendUsed(GLM_PROBE_SPEND_USER)).toBe(42);
    expect(glmSpendUsed(USER)).toBe(42);
  });

  it("does NOT charge the requesting user when no userId is known", async () => {
    stubFetch(() =>
      json({ code: 0, md_results: "# probe", data_info: { num_pages: 1 }, usage: { total_tokens: 42 } }),
    );
    await glmHealth();
    expect(glmSpendUsed(GLM_PROBE_SPEND_USER)).toBe(42);
    expect(glmSpendUsed(USER)).toBe(0);
  });

  it("refuses to probe (no upstream call) when the requesting user is OVER CAP", async () => {
    vi.stubEnv("GLM_DAILY_TOKEN_CAP", "10");
    const calls = stubFetch(() =>
      json({ code: 0, md_results: "# probe", data_info: { num_pages: 1 }, usage: { total_tokens: 42 } }),
    );
    // First probe consumes the budget (42 > 10)…
    await glmHealth({ userId: USER });
    expect(calls).toHaveLength(1);
    _resetGlmHealthForTests();
    // …the second must NOT bill: the user is over cap.
    const h = await glmHealth({ userId: USER });
    expect(h.available).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("marks the ledger/log record as a probe (distinguishable from user spend)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    stubFetch(() =>
      json({ code: 0, md_results: "# probe", data_info: { num_pages: 1 }, usage: { total_tokens: 7 } }),
    );
    await glmHealth({ userId: USER });
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[glm-usage]"));
    expect(lines).toHaveLength(2); // pseudo-user + requesting user
    for (const line of lines) {
      expect(JSON.parse(line.slice(line.indexOf("{"))).probe).toBe(true);
    }
  });

  it("logs the accounting gap when a billed probe reports no usage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(() => json({ code: 0, md_results: "# probe", data_info: { num_pages: 1 } }));
    await glmHealth({ userId: USER });
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("no usage data"));
    expect(line).toBeDefined();
    expect(line).toContain("NOT accounted");
  });

  it("does NOT cache the cap refusal — one over-cap user must not hide the engine from everyone", async () => {
    vi.stubEnv("GLM_DAILY_TOKEN_CAP", "10");
    const OTHER = "00000000-0000-4000-8000-00000000000b";
    stubFetch(() =>
      json({ code: 0, md_results: "# probe", data_info: { num_pages: 1 }, usage: { total_tokens: 100 } }),
    );
    // USER probes once and is now over cap.
    await glmHealth({ userId: USER });
    _resetGlmHealthForTests();
    // USER's next probe is refused for the CAP reason…
    const refused = await glmHealth({ userId: USER });
    expect(refused.available).toBe(false);
    expect(refused.reason).toBe("rate_limited");
    // …and that refusal is NOT cached, so it cannot be served to another user.
    expect(glmHealthCached()).toBeNull();
    // A DIFFERENT user (with no spend) still probes successfully — the cap
    // refusal did not leak into the shared cache slot.
    const other = await glmHealth({ userId: OTHER });
    expect(other.available).toBe(true);
    expect(other.reason).toBe("ok");
  });

  it("still respects the kill switch (no upstream call, no spend)", async () => {
    vi.stubEnv("GLM_SPEND_DISABLED", "1");
    const calls = stubFetch(() => json(REMOTE_OK));
    const h = await glmHealth({ userId: USER });
    expect(h.reason).toBe("disabled");
    expect(calls).toHaveLength(0);
    expect(glmSpendUsed(USER)).toBe(0);
  });

  it("does NOT meter the free local probe", async () => {
    vi.stubEnv("GLM_PROVIDER", "local");
    vi.stubEnv("GLM_BASE_URL", LOCAL_BASE);
    stubFetch(() => json({ data: [{ id: "glm-ocr" }] }));
    await glmHealth({ userId: USER });
    expect(glmSpendUsed(USER)).toBe(0);
    expect(glmSpendUsed(GLM_PROBE_SPEND_USER)).toBe(0);
  });
});
