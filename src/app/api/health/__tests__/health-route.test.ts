import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * H3-INFRA-F8: /api/health must stay auth-free, leak no secrets, report DB
 * reachability, and surface pg_cron schedule health (R2-FACE-F2).
 */
const adminState: {
  dbError: { message: string } | null;
  cron: unknown;
  cronError: { message: string } | null;
  throwOnClient: boolean;
} = {
  dbError: null,
  cron: null,
  cronError: null,
  throwOnClient: false,
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminState.throwOnClient) throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set");
    return {
      from: () => ({
        select: () => ({ limit: () => Promise.resolve({ data: null, error: adminState.dbError }) }),
      }),
      rpc: () => Promise.resolve({ data: adminState.cron, error: adminState.cronError }),
    };
  },
}));

import { GET } from "@/app/api/health/route";
import { _resetRateLimiter } from "@/lib/classes/rate-limit";

/** Minimal request shape — the route reads only the headers. */
function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/health", { headers });
}

beforeEach(() => {
  _resetRateLimiter();
  adminState.dbError = null;
  adminState.cronError = null;
  adminState.throwOnClient = false;
  adminState.cron = {
    jobs: [
      { job: "innovision-retention", active: true, lastStatus: "succeeded", lastRunAt: "2026-09-13T03:17:00Z", everRan: true },
      { job: "innovision-quiz-autoclose", active: true, lastStatus: "succeeded", lastRunAt: "2026-09-13T03:15:00Z", everRan: true },
      { job: "innovision-notifications", active: true, lastStatus: "succeeded", lastRunAt: "2026-09-12T03:43:00Z", everRan: true },
      { job: "innovision-flag-verify-silence", active: true, lastStatus: "succeeded", lastRunAt: "2026-09-13T03:59:00Z", everRan: true },
      { job: "innovision-incident-prune", active: true, lastStatus: "succeeded", lastRunAt: "2026-09-13T04:23:00Z", everRan: true },
    ],
    count: 5,
  };
});

describe("GET /api/health", () => {
  it("returns ok:true with DB + cron health and no secret fields", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.db.reachable).toBe(true);
    expect(typeof body.db.latencyMs).toBe("number");
    expect(body.cron.ok).toBe(true);
    expect(body.cron.jobs).toHaveLength(5);
    expect(body.cron.neverRan).toEqual([]);
    expect(body.cron.missing).toEqual([]);
    // No connection strings / keys anywhere in the payload.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/service_role|supabase\.co|eyJ/);
  });

  it("returns 503 {ok:false} when the DB is unreachable", async () => {
    adminState.dbError = { message: "connection refused" };
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.db.reachable).toBe(false);
  });

  it("returns 503 {ok:false} when the admin client cannot be constructed", async () => {
    adminState.throwOnClient = true;
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it("flags a job that has NEVER run and a job missing entirely", async () => {
    adminState.cron = {
      jobs: [
        { job: "innovision-retention", active: true, lastStatus: null, lastRunAt: null, everRan: false },
        { job: "innovision-quiz-autoclose", active: true, lastStatus: "failed", lastRunAt: "2026-09-13T03:15:00Z", everRan: true },
      ],
      count: 2,
    };
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.cron.ok).toBe(false);
    expect(body.cron.neverRan).toContain("innovision-retention");
    expect(body.cron.missing).toContain("innovision-notifications");
  });

  it("degrades the cron section (not the probe) when cron_health errors", async () => {
    adminState.cronError = { message: "function public.cron_health does not exist" };
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cron.ok).toBe(false);
    expect(body.cron.degraded).toBe(true);
  });

  it("does NOT echo DB or cron error text to an unauthenticated caller", async () => {
    // A driver message carries host/port/role/schema detail — echoing it on an
    // auth-free endpoint is an information-disclosure channel.
    adminState.dbError = {
      message: 'connection to server at "db.internal.example" (10.0.0.5), port 5432 failed: role "postgres"',
    };
    const dbRes = await GET(req());
    expect(dbRes.status).toBe(503);
    const dbRaw = JSON.stringify(await dbRes.json());
    expect(dbRaw).not.toMatch(/db\.internal\.example|10\.0\.0\.5|5432|postgres/);

    _resetRateLimiter();
    adminState.dbError = null;
    adminState.cronError = { message: "permission denied for schema cron at 10.0.0.5" };
    const cronRes = await GET(req());
    const cronBody = await cronRes.json();
    const cronRaw = JSON.stringify(cronBody);
    expect(cronRaw).not.toMatch(/permission denied|10\.0\.0\.5|schema cron/);
    expect(cronBody.cron.degraded).toBe(true);
  });

  it("budgets the probe per IP (429 past the ceiling)", async () => {
    for (let i = 0; i < 30; i++) {
      expect((await GET(req({ "x-forwarded-for": "203.0.113.9" }))).status).toBe(200);
    }
    const res = await GET(req({ "x-forwarded-for": "203.0.113.9" }));
    expect(res.status).toBe(429);
    // A DIFFERENT IP still gets through — the budget is per-caller.
    expect((await GET(req({ "x-forwarded-for": "203.0.113.10" }))).status).toBe(200);
  });
});
