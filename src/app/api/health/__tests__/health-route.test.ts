import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase } from "@/app/api/quizzes/__tests__/fake-supabase";

/**
 * H3-INFRA-F8 + gate S6: /api/health must stay auth-free, leak no secrets,
 * report DB reachability, and expose the pg_cron schedule health (R2-FACE-F2)
 * ONLY to an authenticated lecturer.
 *
 * S6 corrected the old shape: an ANONYMOUS caller used to receive the full cron
 * topology (job names + last status/run times) — internal ops detail on an
 * unauthenticated, DB-touching endpoint. The cron block (and its service-role
 * `cron_health()` RPC) is now lecturer-only, and the RPC is not CALLED at all
 * for anon.
 *
 * ⚠️ The admin mock below deliberately reproduces the REAL client's SHAPE — an
 * object whose `rpc` is a METHOD reading `this.rest` — because the previous
 * mock returned a plain arrow function. That difference is exactly why the
 * suite could not see a real bug: `const rpc = admin.rpc; rpc("cron_health")`
 * works against a free function but throws against the real client
 * (`Cannot read properties of undefined (reading 'rest')`), and
 * `collectCronHealth`'s catch degraded that into a permanently
 * `{ok:false, degraded:true}` cron section on every live lecturer probe. The
 * `"calls the RPC bound to its receiver"` case below fails against the detached
 * form; do NOT "simplify" the mock back to a free function.
 */
const adminState: {
  dbError: { message: string } | null;
  cron: unknown;
  cronError: { message: string } | null;
  throwOnClient: boolean;
  /** How many times the service-role cron_health() RPC was invoked. */
  cronRpcCalls: number;
  /** audit-5 O2/O5: how many times integrity_snapshot() was invoked. */
  integrityRpcCalls: number;
  /**
   * Set when `rpc` was invoked with the wrong receiver. The real postgrest
   * client stores its transport on `this`, so a detached call throws
   * "Cannot read properties of undefined (reading 'rest')"; the mock records
   * the equivalent condition instead of relying on a message match.
   */
  detachedRpcCalls: number;
  /** audit-5 O2/O5: the integrity_snapshot payload (unknown name → cron). */
  integrity: unknown;
} = {
  dbError: null,
  cron: null,
  cronError: null,
  throwOnClient: false,
  cronRpcCalls: 0,
  detachedRpcCalls: 0,
  integrityRpcCalls: 0,
  integrity: {
    windowHours: 24,
    flags24h: 0,
    flagsByAction: {},
    flaggedNow: 0,
    sealed: 0,
    submitted: 0,
    started: 0,
    pendingMarks: 0,
  },
};

/**
 * The shape of the real `SupabaseClient`: `rpc` is a PROTOTYPE METHOD that
 * dereferences `this.rest`. Calling it detached (`const f = c.rpc; f(...)`)
 * throws here exactly as it does against @supabase/postgrest-js.
 */
class FakeAdminClient {
  /** Stands in for the postgrest transport the real client hangs off `this`. */
  private readonly rest = {
    rpc: (name: string) => {
      if (name === "integrity_snapshot") {
        adminState.integrityRpcCalls += 1;
        return Promise.resolve({ data: adminState.integrity, error: null });
      }
      adminState.cronRpcCalls += 1;
      return Promise.resolve({ data: adminState.cron, error: adminState.cronError });
    },
  };

  from(): {
    select: () => { limit: () => Promise<{ data: null; error: { message: string } | null }> };
  } {
    return {
      select: () => ({
        limit: () => Promise.resolve({ data: null, error: adminState.dbError }),
      }),
    };
  }

  async rpc(name: string): Promise<{ data: unknown; error: { message: string } | null }> {
    // A detached invocation has `this === undefined`; the real client would
    // throw on the equivalent `this.rest` dereference.
    if (!this?.rest) {
      adminState.detachedRpcCalls += 1;
      throw new TypeError("Cannot read properties of undefined (reading 'rest')");
    }
    return this.rest.rpc(name);
  }
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminState.throwOnClient) throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set");
    return new FakeAdminClient();
  },
}));

/**
 * The cookie-session client. A `FakeSupabase` with no `setUser()` is a genuine
 * anonymous caller (`auth.getUser()` → `{user: null}`); `setUser(id, "lecturer")`
 * seeds the `profiles.role` row the route reads, mirroring `requireUser`.
 */
const sessionHolder: { current: FakeSupabase } = { current: new FakeSupabase() };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => sessionHolder.current,
}));

/**
 * audit-5 M7: the sidecar probe. Mocked so the route tests never touch the
 * network; `faceHealth` is flipped per-test.
 */
const faceState: { available: boolean } = { available: true };
vi.mock("@/lib/face/server/insightface-client", () => ({
  health: () => Promise.resolve(faceState.available),
}));

import { GET } from "@/app/api/health/route";
import { _resetRateLimiter } from "@/lib/classes/rate-limit";

const LECTURER_ID = "00000000-0000-4000-8000-00000000000a";
const STUDENT_ID = "00000000-0000-4000-8000-00000000000b";

/** Minimal request shape — the route reads only the headers. */
function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/health", { headers });
}

/** The seven healthy schedules the cron RPC reports (0059 added the AI pair). */
function healthyCron() {
  return {
    jobs: [
      { job: "innovision-retention", active: true, lastStatus: "succeeded", lastRunAt: "2026-09-13T03:17:00Z", everRan: true },
      { job: "innovision-quiz-autoclose", active: true, lastStatus: "succeeded", lastRunAt: "2026-09-13T03:15:00Z", everRan: true },
      { job: "innovision-notifications", active: true, lastStatus: "succeeded", lastRunAt: "2026-09-12T03:43:00Z", everRan: true },
      { job: "innovision-flag-verify-silence", active: true, lastStatus: "succeeded", lastRunAt: "2026-09-13T03:59:00Z", everRan: true },
      { job: "innovision-incident-prune", active: true, lastStatus: "succeeded", lastRunAt: "2026-09-13T04:23:00Z", everRan: true },
      { job: "innovision-ai-mark-sweep", active: true, lastStatus: "succeeded", lastRunAt: "2026-09-13T04:24:00Z", everRan: true },
      { job: "innovision-ai-mark-escalate", active: true, lastStatus: "succeeded", lastRunAt: "2026-09-13T04:25:00Z", everRan: true },
    ],
    count: 7,
  };
}

beforeEach(() => {
  _resetRateLimiter();
  adminState.dbError = null;
  adminState.cronError = null;
  adminState.throwOnClient = false;
  adminState.cronRpcCalls = 0;
  adminState.detachedRpcCalls = 0;
  adminState.cron = healthyCron();
  faceState.available = true;
  sessionHolder.current = new FakeSupabase();
});

describe("GET /api/health — anonymous caller (gate S6)", () => {
  it("returns ok:true with DB health and NO cron section, and never calls the cron RPC", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.db.reachable).toBe(true);
    expect(typeof body.db.latencyMs).toBe("number");
    // The load-bearing S6 inversion: no cron key at all — not null, not an
    // empty object. An ops monitor that used to read `cron.ok` anonymously must
    // now authenticate as a lecturer.
    expect("cron" in body).toBe(false);
    expect(body.cron).toBeUndefined();
    // audit-5 O2/O5: the integrity snapshot is lecturer-only too.
    expect("integrity" in body).toBe(false);
    // The RPC is skipped entirely for anon (no service-role round trip).
    expect(adminState.cronRpcCalls).toBe(0);
    expect(adminState.integrityRpcCalls).toBe(0);
    expect(adminState.detachedRpcCalls).toBe(0);
    // The liveness fields an uptime monitor needs are still present.
    expect(typeof body.uptimeSec).toBe("number");
    expect(typeof body.checkedAt).toBe("string");
    expect(typeof body.elapsedMs).toBe("number");
    // No connection strings / keys anywhere in the payload.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/service_role|supabase\.co|eyJ/);
  });

  it("omits cron for an authenticated STUDENT too (lecturer-only, not merely auth-only)", async () => {
    sessionHolder.current.setUser(STUDENT_ID, "student");
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect("cron" in body).toBe(false);
    expect("integrity" in body).toBe(false);
    expect(adminState.cronRpcCalls).toBe(0);
    expect(adminState.integrityRpcCalls).toBe(0);
  });

  it("degrades to no-cron (not a 500) when the profile read fails", async () => {
    sessionHolder.current.setUser(LECTURER_ID, "lecturer");
    sessionHolder.current.selectError = "connection reset by peer";
    sessionHolder.current.selectErrorTable = "profiles";
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect("cron" in body).toBe(false);
  });

  it("degrades to no-cron when the session client throws (no request scope)", async () => {
    // `cookies()` throws outside a request scope; the probe must survive that
    // and still report liveness.
    sessionHolder.current = {
      auth: {
        getUser: async () => {
          throw new Error("cookies() was called outside a request scope");
        },
      },
    } as unknown as FakeSupabase;
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect("cron" in body).toBe(false);
  });
});

describe("GET /api/health — authenticated lecturer (gate S6)", () => {
  it("returns the cron section for a lecturer", async () => {
    sessionHolder.current.setUser(LECTURER_ID, "lecturer");
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.db.reachable).toBe(true);
    expect(body.cron.ok).toBe(true);
    expect(body.cron.jobs).toHaveLength(7);
    expect(body.cron.neverRan).toEqual([]);
    expect(body.cron.missing).toEqual([]);
    expect(adminState.cronRpcCalls).toBe(1);
    // audit-5 O2/O5: the integrity snapshot rides the same lecturer-only gate.
    expect(adminState.integrityRpcCalls).toBe(1);
    expect(body.integrity.flaggedNow).toBe(0);
    expect(body.integrity.flags24h).toBe(0);
    // Still no secrets in the lecturer payload.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/service_role|supabase\.co|eyJ/);
  });

  it("flags a job that has NEVER run and a job missing entirely (lecturer only)", async () => {
    sessionHolder.current.setUser(LECTURER_ID, "lecturer");
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

  it("calls the RPC BOUND to its receiver (regression: a detached `admin.rpc` loses `this`)", async () => {
    // The bug this pins: `const rpc = admin.rpc; await rpc("cron_health")`.
    // Against the real @supabase/postgrest-js client that throws
    // "Cannot read properties of undefined (reading 'rest')", which
    // collectCronHealth swallows into `{ok:false, degraded:true}` — so the
    // endpoint answers 200/ok:true with a permanently degraded cron section and
    // the runbook's `cron.jobs[7]` check can never pass. The FakeAdminClient
    // above is a method-on-an-object precisely so this test can see it; a mock
    // returning a free function passes whether or not the route is detached.
    sessionHolder.current.setUser(LECTURER_ID, "lecturer");
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(adminState.detachedRpcCalls).toBe(0);
    // The cron section is REAL data, not the degraded fallback that a lost
    // receiver produces.
    expect(body.cron.degraded).toBe(false);
    expect(body.cron.ok).toBe(true);
    expect(body.cron.jobs).toHaveLength(7);
  });

  it("degrades the cron section (not the probe) when cron_health errors", async () => {
    sessionHolder.current.setUser(LECTURER_ID, "lecturer");
    adminState.cronError = { message: "function public.cron_health does not exist" };
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cron.ok).toBe(false);
    expect(body.cron.degraded).toBe(true);
  });
});

describe("GET /api/health — sidecar probe (audit-5 M7)", () => {
  it("reports face.available for an ANONYMOUS caller (uptime-monitor reachable)", async () => {
    faceState.available = true;
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.face).toEqual({ available: true });
  });

  it("reports face.available:false when the sidecar is down, without failing the probe", async () => {
    faceState.available = false;
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.face.available).toBe(false);
    // Still no cron topology for anon.
    expect("cron" in body).toBe(false);
  });
});

describe("GET /api/health — failure modes unchanged", () => {
  it("returns 503 {ok:false} when the DB is unreachable", async () => {
    adminState.dbError = { message: "connection refused" };
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.db.reachable).toBe(false);
    // The 503 short-circuits before the cron work — no RPC, no cron key.
    expect(adminState.cronRpcCalls).toBe(0);
    expect("cron" in body).toBe(false);
  });

  it("returns 503 {ok:false} when the admin client cannot be constructed", async () => {
    adminState.throwOnClient = true;
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
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
    sessionHolder.current.setUser(LECTURER_ID, "lecturer");
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
