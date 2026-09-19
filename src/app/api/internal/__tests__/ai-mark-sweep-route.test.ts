import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _resetRateLimiter } from "@/lib/classes/rate-limit";
import * as sweepRoute from "@/app/api/internal/ai-mark-sweep/route";
import * as worker from "@/lib/ai/marking-worker";

/**
 * Route pins for the service-role sweep endpoint.
 *
 * The load-bearing property is the AUTH posture (A6-12): the bearer is the
 * whole gate — the route is `checkSameOrigin`-exempt because its caller is a
 * database, so a missing or mismatched key must fail CLOSED with 401 and must
 * do so BEFORE the body is read or the worker runs. The worker itself is
 * mocked: its DB orchestration is pinned by the live verify harness, and what
 * this suite proves is the route's contract around it.
 */

const SWEEP_KEY = "test-service-role-key-0123456789";

vi.mock("@/lib/ai/marking-worker", () => ({
  markClaimedBatch: vi.fn(),
}));

const rpcMock = vi.fn();
const adminMock = { rpc: rpcMock };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminMock,
}));

const markClaimedBatch = vi.mocked(worker.markClaimedBatch);

const SESSION = "00000000-0000-4000-8000-0000000000aa";
const QUESTION = "00000000-0000-4000-8000-0000000000dd";
const QUIZ = "00000000-0000-4000-8000-0000000000cc";
const LEDGER = "00000000-0000-4000-8000-0000000000ee";
const TOKEN = "00000000-0000-4000-8000-0000000000ff";

function body(overrides: Record<string, unknown> = {}) {
  return {
    claim_token: TOKEN,
    rows: [
      {
        ledger_id: LEDGER,
        session_id: SESSION,
        question_id: QUESTION,
        attempt_version: 1,
        quiz_id: QUIZ,
      },
    ],
    ...overrides,
  };
}

function req(payload?: unknown, init?: RequestInit): Request {
  return new Request("http://localhost/api/internal/ai-mark-sweep", {
    method: "POST",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

function authed(payload?: unknown): Request {
  return req(payload, { headers: { authorization: `Bearer ${SWEEP_KEY}` } });
}

beforeEach(() => {
  _resetRateLimiter();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SWEEP_KEY);
  markClaimedBatch.mockReset();
  markClaimedBatch.mockResolvedValue({
    claimed: 1,
    applied: 1,
    discarded: 0,
    failed: 0,
  });
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: 0, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("I-AI-1 — bearer auth fails closed (A6-12)", () => {
  it("missing authorization header → 401, worker never runs", async () => {
    const res = await sweepRoute.POST(req(body()));
    expect(res.status).toBe(401);
    expect(markClaimedBatch).not.toHaveBeenCalled();
  });

  it("wrong bearer → 401", async () => {
    const res = await sweepRoute.POST(
      req(body(), { headers: { authorization: "Bearer wrong-key" } }),
    );
    expect(res.status).toBe(401);
    expect(markClaimedBatch).not.toHaveBeenCalled();
  });

  it("a non-Bearer scheme → 401 (never a bare-key match)", async () => {
    const res = await sweepRoute.POST(
      req(body(), { headers: { authorization: SWEEP_KEY } }),
    );
    expect(res.status).toBe(401);
  });

  it("an unconfigured server key → 401 even with a matching-looking header", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const res = await sweepRoute.POST(authed(body()));
    expect(res.status).toBe(401);
    expect(markClaimedBatch).not.toHaveBeenCalled();
  });

  // audit-4 deploy fix: the bearer is AI_MARK_WORKER_KEY when set, falling back
  // to SUPABASE_SERVICE_ROLE_KEY. Both arms must be pinned — a regression that
  // dropped the named override would silently 401 a dedicated-key deployment,
  // and one that ignored the fallback would 401 the default deployment.
  it("AI_MARK_WORKER_KEY takes precedence over the service-role key", async () => {
    vi.stubEnv("AI_MARK_WORKER_KEY", "dedicated-marking-key");
    // The service-role key is still set, but must NOT be accepted now.
    const withServiceRole = await sweepRoute.POST(authed(body()));
    expect(withServiceRole.status).toBe(401);
    const withDedicated = await sweepRoute.POST(
      req(body(), { headers: { authorization: "Bearer dedicated-marking-key" } }),
    );
    expect(withDedicated.status).toBe(200);
    expect(markClaimedBatch).toHaveBeenCalledTimes(1);
  });

  it("falls back to SUPABASE_SERVICE_ROLE_KEY when AI_MARK_WORKER_KEY is unset", async () => {
    vi.stubEnv("AI_MARK_WORKER_KEY", "");
    const res = await sweepRoute.POST(authed(body()));
    expect(res.status).toBe(200);
  });

  it("expectedSweepKey resolves the two sources in order", () => {
    const env = (v: Record<string, string | undefined>) => v as unknown as NodeJS.ProcessEnv;
    expect(sweepRoute.expectedSweepKey(env({ AI_MARK_WORKER_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "b" }))).toBe("a");
    expect(sweepRoute.expectedSweepKey(env({ SUPABASE_SERVICE_ROLE_KEY: "b" }))).toBe("b");
    // A whitespace-only override is treated as unset, not as the bearer.
    expect(sweepRoute.expectedSweepKey(env({ AI_MARK_WORKER_KEY: "  ", SUPABASE_SERVICE_ROLE_KEY: "b" }))).toBe("b");
    expect(sweepRoute.expectedSweepKey(env({}))).toBeUndefined();
  });
});

describe("I-AI-2 — happy path runs the worker then escalates", () => {
  it("200 with the worker's tally and the escalation count", async () => {
    rpcMock.mockResolvedValue({ data: 2, error: null });
    const res = await sweepRoute.POST(authed(body()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, claimed: 1, applied: 1, escalated: 2 });
    expect(markClaimedBatch).toHaveBeenCalledTimes(1);
    // Escalation is a SEPARATE RPC call after the worker (A6-2) — its own txn.
    expect(rpcMock).toHaveBeenCalledWith("escalate_stale_marks");
  });

  it("a failed escalation does NOT fail the sweep (marks already landed)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = await sweepRoute.POST(authed(body()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.escalated).toBeNull();
  });

  it("an empty row set still escalates (nothing to mark, stale rows to resolve)", async () => {
    markClaimedBatch.mockResolvedValue({ claimed: 0, applied: 0, discarded: 0, failed: 0 });
    const res = await sweepRoute.POST(authed(body({ rows: [] })));
    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("escalate_stale_marks");
  });
});

describe("I-AI-3 — payload validation", () => {
  it("rejects a non-UUID claim_token", async () => {
    const res = await sweepRoute.POST(authed(body({ claim_token: "nope" })));
    expect(res.status).toBe(400);
    expect(markClaimedBatch).not.toHaveBeenCalled();
  });

  it("rejects a row with a non-UUID question_id", async () => {
    const res = await sweepRoute.POST(
      authed(
        body({
          rows: [
            {
              ledger_id: LEDGER,
              session_id: SESSION,
              question_id: "not-a-uuid",
              attempt_version: 1,
              quiz_id: QUIZ,
            },
          ],
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an attempt_version below 1", async () => {
    const res = await sweepRoute.POST(
      authed(
        body({
          rows: [
            {
              ledger_id: LEDGER,
              session_id: SESSION,
              question_id: QUESTION,
              attempt_version: 0,
              quiz_id: QUIZ,
            },
          ],
        }),
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe("I-AI-4 — rate limit", () => {
  it("429 past the per-minute ceiling", async () => {
    for (let i = 0; i < 60; i++) {
      await sweepRoute.POST(authed(body()));
    }
    const res = await sweepRoute.POST(authed(body()));
    expect(res.status).toBe(429);
  });
});

describe("I-AI-5 — a worker throw is a typed 503, never a raw 500", () => {
  it("the claim has already committed, so the lease owns recovery", async () => {
    markClaimedBatch.mockRejectedValue(new Error("db exploded"));
    const res = await sweepRoute.POST(authed(body()));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe("internal");
  });
});
