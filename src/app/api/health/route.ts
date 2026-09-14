import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/classes/rate-limit";
import { clientIpFromHeaders } from "@/lib/request-ip";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — liveness + readiness probe (H3-INFRA-F8).
 *
 * Reports, with NO secrets and no connection strings:
 *   - `ok`          process liveness (always true when the handler runs)
 *   - `db.reachable` + latency, from a cheap `select 1`-equivalent
 *   - `cron.*`      ONLY for an authenticated LECTURER: each pg_cron schedule
 *                   named `innovision-*`, its last status/start time, and
 *                   whether it has EVER run — the surface R2-FACE-F2 lacked
 *                   (silent pg_cron failures).
 *
 * **Gate S6 — the cron block is lecturer-only.** The endpoint is
 * unauthenticated + DB-touching, so an ANONYMOUS caller used to receive the
 * full cron topology (job names, schedules' last status and run times) for the
 * cost of one GET. That is internal ops detail with no liveness value: an
 * anonymous response is now exactly
 * `{ok, db:{reachable,latencyMs}, uptimeSec, checkedAt, elapsedMs}` with NO
 * `cron` key and NO service-role `cron_health()` RPC call.
 *
 * On cost, precisely — an earlier revision of this comment claimed "one query,
 * not two", and that is the wrong number for the wrong reason. The anon saving
 * is the SKIPPED `cron_health()` RPC, not a fixed one-round-trip budget. The DB
 * probe is a `HEAD` to `/rest/v1/profiles`, and `@supabase/postgrest-js` retries
 * `GET`/`HEAD` on a 520/503 or a network error up to `DEFAULT_MAX_RETRIES` (3).
 * Measured through a counting proxy against local Supabase: ONE request per
 * probe over 25/25 healthy runs (the anon handler issued exactly
 * `HEAD /rest/v1/profiles?select=id&limit=1`), and TWO when a single 503 is
 * injected — which is how a probe can legitimately cost two requests, and is
 * almost certainly what an earlier measurement saw. So: 1 when PostgREST is
 * healthy, up to 4 while it is flapping, plus the `auth.getUser()` +
 * `profiles.role` round trips the lecturer check adds for a signed-in caller.
 * The probe shape is left alone deliberately: a cheaper-looking probe would only
 * make a number smaller, not the system better. This endpoint is polled as a
 * keep-alive, and what matters for a keep-alive is that it stays cheap in the
 * normal case — not that its worst case is minimal.
 *
 * The session is resolved the way the rest of the codebase does it
 * (`requireUser` in `src/lib/classes/guards.ts`: `auth.getUser()` then the
 * caller's own `profiles.role` via the ANON cookie client so RLS applies) —
 * but WITHOUT its 403/401 responses. A missing, invalid or failed session is
 * not an error here: it simply means "no cron section", because the probe must
 * stay reachable for unauthenticated uptime monitors.
 *
 * Auth-free by design (a probe must not need a session), so it is budgeted by
 * IP instead.
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

type CronSection = {
  ok: boolean;
  jobs: CronHealthJob[];
  neverRan: string[];
  missing: string[];
  degraded: boolean;
};

/**
 * Service-role RPC for cron state (0047 §8; typed as `cron_health` in the
 * generated `Database` since the migration was applied).
 *
 * ⚠️ The call is BOUND (`admin.rpc(...)`), and that is load-bearing. An earlier
 * revision wrote `const rpc = admin.rpc; await rpc("cron_health")` — detaching
 * the method from its receiver. The real @supabase/postgrest-js client keeps
 * its transport on `this` (`this.rest`), so the detached call throws
 * `Cannot read properties of undefined (reading 'rest')`, which
 * `collectCronHealth`'s catch swallows into `{ok:false, degraded:true}`. The
 * endpoint then reports `ok:true` while the cron section is permanently
 * degraded — exactly what live lecturer probes returned, and why the operator
 * procedure in `docs/DEPLOY_VPS.md` §12 (`ok` + `jobs[5]`) could not be
 * satisfied. Reproduced against local Supabase with the real service-role key:
 *
 *   DETACHED THREW: Cannot read properties of undefined (reading 'rest')
 *   BOUND ok: jobs= 5 err= null
 *
 * The route test's admin mock models this shape (a METHOD that reads `this.rest`
 * rather than a free function), so this class of bug fails the suite instead of
 * passing it.
 */
async function fetchCronHealth(): Promise<CronHealthPayload> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("cron_health");
  if (error) return { error: error.message };
  if (!data || typeof data !== "object") return { error: "invalid_payload" };
  return data as unknown as CronHealthPayload;
}

/**
 * True only for an authenticated LECTURER. Any other outcome — no session, a
 * student, a DB error while reading the profile, or no request scope at all
 * (`cookies()` throws outside a request) — is `false`, never a response. The
 * caller treats `false` as "omit the cron block", which is exactly the
 * pre-existing anonymous shape, so a failure here can only remove detail, never
 * break the probe.
 *
 * Mirrors `requireUser`'s resolution (auth.getUser → profiles.role via the anon
 * client so RLS applies) rather than inventing a second role path.
 */
async function callerIsLecturer(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (error || !profile) return false;

    return profile.role === "lecturer";
  } catch (err) {
    // Never fatal: the probe's liveness contract outranks the cron detail.
    console.warn("[api/health] session resolution failed; omitting the cron section", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function collectCronHealth(): Promise<CronSection> {
  try {
    const payload = await fetchCronHealth();
    if (payload.error) {
      console.error("[api/health] cron_health returned an error:", payload.error);
      return { ok: false, jobs: [], neverRan: [], missing: [], degraded: true };
    }
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
    return {
      ok: neverRan.length === 0 && missing.length === 0 && jobs.every((j) => j.lastStatus !== "failed"),
      jobs,
      neverRan,
      missing,
      degraded: false,
    };
  } catch (err) {
    console.error("[api/health] cron_health call failed:", err);
    return { ok: false, jobs: [], neverRan: [], missing: [], degraded: true };
  }
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

  // Gate S6: the cron block (and its service-role RPC) is lecturer-only. The
  // RPC is not merely hidden from the payload — it is never CALLED for anon, so
  // an anonymous probe skips a service-role round trip entirely (it still pays
  // the DB probe above; see the header note on the exact request count).
  const isLecturer = await callerIsLecturer();
  const cron = isLecturer ? await collectCronHealth() : undefined;

  return Response.json(
    {
      ok: true,
      db: { reachable: dbReachable, latencyMs: dbLatencyMs },
      // Absent — not `null`/`undefined`-but-present — for anyone but a lecturer.
      ...(cron ? { cron } : {}),
      uptimeSec: Math.round(process.uptime()),
      checkedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
    },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
