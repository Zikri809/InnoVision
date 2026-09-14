import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit } from "@/lib/classes/rate-limit";
import { clientIpFromHeaders } from "@/lib/request-ip";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — unauthenticated liveness + readiness probe (H3-INFRA-F8).
 *
 * Reports, with NO secrets and no connection strings:
 *   - `ok`          process liveness (always true when the handler runs)
 *   - `db.reachable` + latency, from a cheap `select 1`-equivalent
 *   - `cron.jobs`   each pg_cron schedule named `innovision-*`, its last
 *                   status/start time, and whether it has EVER run — the
 *                   surface R2-FACE-F2 lacked (silent pg_cron failures).
 *
 * Auth-free by design (a probe must not need a session), so it is budgeted by
 * IP instead — it still costs a DB round trip plus one service-role RPC.
 *
 * **Error text is never returned.** An earlier draft echoed `error.message`
 * from the DB probe and the cron RPC straight to the caller; on an
 * unauthenticated endpoint that is an information-disclosure channel (driver
 * messages carry host, port, role and schema detail). Failures are logged
 * server-side with the detail and reported to the caller as booleans.
 */

/** The five schedules created across 0019/0022/0030/0042. */
const EXPECTED_JOBS = [
  "innovision-retention",
  "innovision-quiz-autoclose",
  "innovision-notifications",
  "innovision-flag-verify-silence",
  "innovision-incident-prune",
] as const;

// A probe is polled by uptime monitors; 30/min per IP is far above any real
// cadence while bounding an unauthenticated DB-touching endpoint.
const HEALTH_RATE = { limit: 30, windowMs: 60_000 };

type CronHealthJob = {
  job: string;
  active: boolean;
  lastStatus: string | null;
  lastRunAt: string | null;
  everRan: boolean;
};

type CronHealthPayload = {
  jobs?: CronHealthJob[];
  count?: number;
  error?: string;
};

/** Service-role RPC for cron state (0047 §8); not in the generated types yet. */
async function fetchCronHealth(): Promise<CronHealthPayload> {
  const admin = createAdminClient();
  const rpc = admin.rpc as unknown as (
    name: string,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc("cron_health");
  if (error) return { error: error.message };
  if (!data || typeof data !== "object") return { error: "invalid_payload" };
  return data as CronHealthPayload;
}

export async function GET(request: Request) {
  const startedAt = Date.now();

  const ip = clientIpFromHeaders(request.headers);
  if (!rateLimit(`health:${ip}`, HEALTH_RATE)) {
    return Response.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "content-type": "application/json" } },
    );
  }

  let dbReachable = false;
  let dbLatencyMs: number | null = null;

  try {
    const admin = createAdminClient();
    const t0 = Date.now();
    // Cheap reachability probe: HEAD count of a one-row read. No rows move.
    const { error } = await admin
      .from("profiles")
      .select("id", { head: true, count: "exact" })
      .limit(1);
    dbLatencyMs = Date.now() - t0;
    if (error) throw new Error(error.message);
    dbReachable = true;
  } catch (err) {
    // Detail stays server-side (see the header note on disclosure).
    console.error("[api/health] DB unreachable", {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { ok: false, db: { reachable: false } },
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  let cron: {
    ok: boolean;
    jobs: CronHealthJob[];
    neverRan: string[];
    missing: string[];
    degraded: boolean;
  };
  try {
    const payload = await fetchCronHealth();
    if (payload.error) {
      console.error("[api/health] cron_health returned an error:", payload.error);
      cron = { ok: false, jobs: [], neverRan: [], missing: [], degraded: true };
    } else {
      // Strip everything but the ops-safe fields (never return_message —
      // it can embed DB details).
      const jobs: CronHealthJob[] = (payload.jobs ?? []).map((j) => ({
        job: String(j.job),
        active: Boolean(j.active),
        lastStatus: j.lastStatus ?? null,
        lastRunAt: j.lastRunAt ?? null,
        everRan: Boolean(j.everRan),
      }));
      const seen = new Set(jobs.map((j) => j.job));
      const neverRan = jobs.filter((j) => !j.everRan).map((j) => j.job);
      const missing = EXPECTED_JOBS.filter((n) => !seen.has(n));
      cron = {
        ok: neverRan.length === 0 && missing.length === 0 && jobs.every((j) => j.lastStatus !== "failed"),
        jobs,
        neverRan,
        missing,
        degraded: false,
      };
    }
  } catch (err) {
    console.error("[api/health] cron_health call failed:", err);
    cron = { ok: false, jobs: [], neverRan: [], missing: [], degraded: true };
  }

  return Response.json(
    {
      ok: true,
      db: { reachable: dbReachable, latencyMs: dbLatencyMs },
      cron,
      uptimeSec: Math.round(process.uptime()),
      checkedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
    },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
