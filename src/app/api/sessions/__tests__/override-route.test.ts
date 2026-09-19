import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase, makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { _resetRateLimiter, _seedRateLimit } from "@/lib/classes/rate-limit";
import * as overrideRoute from "@/app/api/sessions/[id]/override/route";

/**
 * Route pins for the lecturer override endpoint (0058 §1).
 *
 * The RPC is the sole authority (ownership, the 0/0.5/1 ladder, the
 * `max_score` ceiling, the re-publish); what this suite proves is the route's
 * mapping of its typed payload, the CSRF/rate-limit preamble order, and the
 * 60s replay guard that keeps a double-click from writing twice.
 */

const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

const SESSION = "00000000-0000-4000-8000-0000000000aa";
const QUESTION = "00000000-0000-4000-8000-0000000000dd";
const LECTURER = "00000000-0000-4000-8000-00000000000a";

function req(payload?: unknown, init?: RequestInit): Request {
  return new Request(`http://localhost/api/sessions/${SESSION}/override`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

const PARAMS = { params: Promise.resolve({ id: SESSION }) };

function lecturerContext() {
  const ctx = makeOwnerContext({ quizStatus: "live" });
  ctx.client.setUser(LECTURER, "lecturer");
  fakeHolder.current = ctx.client;
  return ctx;
}

const VALID = { questionId: QUESTION, mark: 0.5, reason: "Rubric line 2 was met." };

beforeEach(() => {
  fakeHolder.current = undefined;
  _resetRateLimiter();
});

describe("I-OV-1 — happy path", () => {
  it("maps {ok:true} → 200 {ok:true}", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: { ok: true }, error: null };
    const res = await overrideRoute.POST(req(VALID), PARAMS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("accepts every ladder value (0 / 0.5 / 1)", async () => {
    for (const mark of [0, 0.5, 1]) {
      _resetRateLimiter();
      const ctx = lecturerContext();
      ctx.client.rpcResult = { data: { ok: true }, error: null };
      const res = await overrideRoute.POST(
        req({ ...VALID, mark, reason: `mark ${mark} rationale` }),
        PARAMS,
      );
      expect(res.status).toBe(200);
    }
  });
});

describe("I-OV-2 — RPC error mapping", () => {
  // Both 404 arms collapse to ONE body shape on purpose: `not_owner` (foreign
  // session) and `not_found` (missing/foreign question) must be
  // indistinguishable to the caller — the no-oracle rule.
  const cases: Array<[string, number, string]> = [
    ["not_owner", 404, "not_found"],
    ["not_found", 404, "not_found"],
    ["invalid_mark", 400, "invalid_mark"],
    ["reason_required", 400, "reason_required"],
    ["mark_exceeds_max", 400, "mark_exceeds_max"],
  ];

  it.each(cases)("%s → %i", async (error, status, bodyError) => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: { error }, error: null };
    const res = await overrideRoute.POST(req(VALID), PARAMS);
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(bodyError);
  });

  it("an unmapped payload → 503 (never a false success)", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: { surprise: true }, error: null };
    const res = await overrideRoute.POST(req(VALID), PARAMS);
    expect(res.status).toBe(503);
  });

  it("a transport error → 503", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: null, error: { message: "dead" } };
    const res = await overrideRoute.POST(req(VALID), PARAMS);
    expect(res.status).toBe(503);
  });
});

describe("I-OV-3 — payload validation", () => {
  it("rejects a mark off the ladder (never a silent clamp)", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: { ok: true }, error: null };
    const res = await overrideRoute.POST(req({ ...VALID, mark: 0.7 }), PARAMS);
    expect(res.status).toBe(400);
  });

  it("rejects a reason shorter than 5 characters", async () => {
    lecturerContext();
    const res = await overrideRoute.POST(req({ ...VALID, reason: "ok" }), PARAMS);
    expect(res.status).toBe(400);
  });

  it("rejects a non-UUID questionId", async () => {
    lecturerContext();
    const res = await overrideRoute.POST(req({ ...VALID, questionId: "x" }), PARAMS);
    expect(res.status).toBe(400);
  });

  it("rejects a non-UUID session id → 404 (no oracle)", async () => {
    lecturerContext();
    const res = await overrideRoute.POST(req(VALID), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("I-OV-4 — preamble", () => {
  it("a student → 403 before any RPC call", async () => {
    const ctx = makeOwnerContext({ quizStatus: "live" });
    ctx.client.setUser("00000000-0000-4000-8000-0000000000bb", "student");
    fakeHolder.current = ctx.client;
    const res = await overrideRoute.POST(req(VALID), PARAMS);
    expect(res.status).toBe(403);
  });

  it("CSRF cross-origin → 403", async () => {
    lecturerContext();
    const res = await overrideRoute.POST(
      req(VALID, { headers: { origin: "https://evil.test" } }),
      PARAMS,
    );
    expect(res.status).toBe(403);
  });

  it("rate limit → 429", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: { ok: true }, error: null };
    _seedRateLimit(`override:${LECTURER}`, 30);
    const res = await overrideRoute.POST(req(VALID), PARAMS);
    expect(res.status).toBe(429);
  });
});

describe("I-OV-5 — replay guard", () => {
  it("an identical resubmission inside the window returns 200 without a second RPC", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: { ok: true }, error: null };
    const first = await overrideRoute.POST(req(VALID), PARAMS);
    expect(first.status).toBe(200);
    expect(ctx.client.rpcCalls).toHaveLength(1);

    const second = await overrideRoute.POST(req(VALID), PARAMS);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
    // audit-4 M13: the replay guard's core claim is now actually counted — a
    // deleted guard would leave this at 2 and fail the test.
    expect(ctx.client.rpcCalls).toHaveLength(1);
  });

  it("a DIFFERENT mark is not suppressed (a correction must land)", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: { ok: true }, error: null };
    await overrideRoute.POST(req(VALID), PARAMS);
    const corrected = await overrideRoute.POST(req({ ...VALID, mark: 1 }), PARAMS);
    expect(corrected.status).toBe(200);
    expect(ctx.client.rpcCalls).toHaveLength(2);
  });

  // audit-4 B2: the guard must only stamp SUCCESSES. The first cut recorded
  // the hit on entry, so a failed first attempt (404/400/503) turned an
  // identical retry into a fabricated {ok:true} 200 with no write.
  it("a FAILED first attempt does not poison the replay window — the retry reaches the RPC", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: { error: "not_found" }, error: null };
    const first = await overrideRoute.POST(req(VALID), PARAMS);
    expect(first.status).toBe(404);
    expect(ctx.client.rpcCalls).toHaveLength(1);

    // Same payload, now succeeding (e.g. the transient condition cleared).
    ctx.client.rpcResult = { data: { ok: true }, error: null };
    const retry = await overrideRoute.POST(req(VALID), PARAMS);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true });
    expect(ctx.client.rpcCalls).toHaveLength(2);
  });

  it("a 503 transport failure likewise leaves the window clean", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: null, error: { message: "dead" } };
    const first = await overrideRoute.POST(req(VALID), PARAMS);
    expect(first.status).toBe(503);

    ctx.client.rpcResult = { data: { ok: true }, error: null };
    const retry = await overrideRoute.POST(req(VALID), PARAMS);
    expect(retry.status).toBe(200);
    expect(ctx.client.rpcCalls).toHaveLength(2);
  });
});
