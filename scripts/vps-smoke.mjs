// VPS smoke — ops gate O4 (docs/PLAN_VPS_DEPLOYMENT.md §6 / §10.3).
//
// WHY THIS EXISTS: every `scripts/verify-*.mjs` harness calls
// `assertLocalTarget()` (scripts/lib/target-guard.mjs) and REFUSES a non-loopback
// Supabase URL by design — they are laptop harnesses holding the service-role
// key, not a deployment gate. That left the VPS cutover with no automated check
// at all: only a one-time eyeball smoke. This script is that gate. It is
// deliberately STANDALONE (node builtins + @supabase/* from the repo's
// node_modules) and imports NOTHING from scripts/lib — in particular not
// `remote-env.mjs`, which now requires `PROD_CONFIRM_TOKEN` for destructive
// runs and would make a read-only smoke abort.
//
// WHAT IT ASSERTS (hard — a failure exits non-zero):
//   1. `GET /api/health` → 200, `ok === true`, `db.reachable === true`.
//   2. `GET /api/extract/ocr` UNAUTHENTICATED → 401/403 (the auth gate is ON).
//   3. A login round trip (see the `login` check below).
//   4. An authenticated quiz-session fetch (SKIPPED, non-fatal, when no
//      session id can be discovered — a fresh deployment legitimately has none).
//   5. `GET /api/extract/ocr` AUTHENTICATED → the probe shape the engine picker
//      depends on: `available`, `provider`, `maxPages`, `reason` — AND
//      `available === true`. The engine actually being USABLE is the whole
//      point of the gate: a shape-only check reports PASS on a dead upstream
//      (`available:false, reason:"unreachable"`) and the O4 gate would then
//      green-light a deployment whose OCR is entirely non-functional. When the
//      probe says `available:false` this check FAILS and prints the `reason`
//      (the actionable part). `--allow-ocr-unavailable` downgrades it to a
//      loud SKIP for the legitimate "OCR intentionally not configured yet"
//      case — never a silent PASS.
//
// WHAT IT ONLY REPORTS: the `cron` block. ⚠️ The health route returns
// `ok: true` even when `cron.degraded` is true (it is a LIVENESS flag), so a
// smoke that asserts on top-level `ok` would pass a deployment whose five
// pg_cron schedules are all dead. This script asserts on `cron.*` and NEVER on
// `ok` for cron. Pass `--expect-cron` to make cron failures fatal (use it in
// the post-cutover run, not on a database whose cron is still being enabled).
//
// LOGIN: `@supabase/ssr`'s `createServerClient` is driven with an in-memory
// cookie jar, so the cookie it produces is the same one the app's own
// `createClient()` reads (same library, same base64url chunked encoding, same
// pinned `SUPABASE_AUTH_COOKIE` name — src/lib/env.ts:47). A raw
// `POST {sb}/auth/v1/token?grant_type=password` fallback is attempted when the
// SSR client is unavailable; it re-encodes the grant response in the same
// `base64-<base64url(JSON)>` shape, so the app accepts it too (verified live).
// If BOTH fail the check fails LOUDLY — never a silent pass (a smoke that
// cannot log in cannot have proved the auth surface).
//
// Usage:
//   node scripts/vps-smoke.mjs [--base-url URL] [--email E] [--password P]
//                              [--expect-cron] [--expect-provider local|remote]
//                              [--allow-ocr-unavailable]
//                              [--sb-url URL] [--anon-key KEY]
//
// Secrets: `--password`, the anon key and the session cookie are never printed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * The pinned session-cookie name. MUST equal `SUPABASE_AUTH_COOKIE` in
 * src/lib/env.ts — the app reads exactly this name, so a smoke that writes a
 * differently-named cookie would report a false 401.
 */
const AUTH_COOKIE = "sb-innovision-auth-token";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";

// ─── Output (mirrors scripts/verify-*.mjs) ─────────────────────────────────

/** Every check: `hard` failures exit non-zero, `skip` is a reported non-fatal. */
const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const tag = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : "SKIP";
  console.log(`${tag}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function warn(line) {
  console.log(`WARN  ${line}`);
}

// ─── Args / env ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    email: null,
    password: null,
    expectCron: false,
    expectProvider: "any",
    allowOcrUnavailable: false,
    sbUrl: null,
    anonKey: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base-url") args.baseUrl = argv[++i];
    else if (a === "--email") args.email = argv[++i];
    else if (a === "--password") args.password = argv[++i];
    else if (a === "--expect-cron") args.expectCron = true;
    else if (a === "--expect-provider") args.expectProvider = argv[++i];
    else if (a === "--allow-ocr-unavailable") args.allowOcrUnavailable = true;
    else if (a === "--sb-url") args.sbUrl = argv[++i];
    else if (a === "--anon-key") args.anonKey = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  args.baseUrl = String(args.baseUrl).replace(/\/$/, "");
  return args;
}

function usage() {
  console.log(
    [
      "InnoVision VPS smoke (ops gate O4)",
      "",
      "  node scripts/vps-smoke.mjs [options]",
      "",
      "  --base-url URL        app origin (default http://127.0.0.1:3000)",
      "  --email EMAIL         lecturer account for the authenticated checks",
      "  --password PASS       its password (never printed)",
      "  --expect-cron         make cron.* failures FATAL (post-cutover run)",
      "  --expect-provider P   local|remote|any (default any): warn when the OCR",
      "                          probe reports a different leg. `any` warns about",
      "                          `local` whenever --base-url is NOT loopback,",
      "                          i.e. a real deployment serving the free leg.",
      "  --allow-ocr-unavailable",
      "                        accept an OCR probe reporting available:false —",
      "                          the engine is not usable, but this run does not",
      "                          fail on it. Reported as SKIP + a loud WARNING,",
      "                          NEVER as PASS. Use only when OCR is",
      "                          intentionally not configured on this host yet.",
      "  --sb-url URL          Supabase base URL for the login round trip",
      "                          (default: .env.local NEXT_PUBLIC_SUPABASE_URL,",
      "                          else {base-url}/sb)",
      "  --anon-key KEY        Supabase anon key (default: .env.local)",
      "",
      "  Exit 0 only when every hard check passed. cron is REPORT-ONLY unless",
      "  --expect-cron is given: the health route returns ok:true even when",
      "  cron.degraded is true, so `ok` is never a cron assertion. The OCR probe",
      "  is HARD on available:true — a shape-only pass would green-light a",
      "  deployment whose OCR engine is dead (ops gate O4).",
    ].join("\n"),
  );
}

/** Minimal .env.local reader (no dotenv dep). Missing file → {}. */
function loadDotEnvLocal() {
  const p = path.join(REPO_ROOT, ".env.local");
  if (!fs.existsSync(p)) return {};
  return fs
    .readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.trim().startsWith("#"))
    .reduce((acc, l) => {
      const idx = l.indexOf("=");
      if (idx > 0) acc[l.slice(0, idx).trim()] = l.slice(idx + 1).trim();
      return acc;
    }, {});
}

const isLoopback = (url) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url);

// ─── HTTP helper ───────────────────────────────────────────────────────────

async function request(url, { method = "GET", cookie, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: cookie ? { cookie } : {},
      signal: controller.signal,
      redirect: "manual",
    });
    let body = null;
    let text = "";
    try {
      text = await res.text();
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body, text, ok: res.ok };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Login ─────────────────────────────────────────────────────────────────

/**
 * Build a Supabase client whose cookie store is an in-memory jar, so
 * `signInWithPassword` writes the app-compatible session cookie into it.
 *
 * Returns `{ cookieHeader, client }` or throws with a reason. The cookie value
 * itself is never logged.
 */
async function loginViaSsr({ sbUrl, anonKey, email, password }) {
  const { createServerClient } = await import("@supabase/ssr");
  const jar = new Map();
  const client = createServerClient(sbUrl, anonKey, {
    cookieOptions: { name: AUTH_COOKIE },
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const c of list) {
          if (c.value) jar.set(c.name, c.value);
          else jar.delete(c.name);
        }
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signInWithPassword: ${error.message}`);
  if (jar.size === 0) throw new Error("signInWithPassword wrote no auth cookie");
  return {
    cookieHeader: [...jar.entries()].map(([n, v]) => `${n}=${v}`).join("; "),
    client,
  };
}

/**
 * Fallback: raw password grant. Used only when `@supabase/ssr` is unavailable
 * (e.g. a pruned production install). Re-encodes the session in the same
 * base64url-with-`base64-`-prefix shape `@supabase/ssr` writes, so the app's
 * server client can read it.
 */
async function loginViaPasswordGrant({ sbUrl, anonKey, email, password }) {
  const res = await fetch(`${sbUrl.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anonKey },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.error_description ?? body?.msg ?? body?.error ?? `HTTP ${res.status}`;
    throw new Error(`password grant: ${msg}`);
  }
  if (!body?.access_token) throw new Error("password grant returned no access_token");
  const encoded = `base64-${Buffer.from(JSON.stringify(body), "utf8").toString("base64url")}`;
  return { cookieHeader: `${AUTH_COOKIE}=${encoded}`, client: null };
}

/** Candidate Supabase base URLs, most-likely first. */
function supabaseCandidates(args, dotenv) {
  const list = [];
  if (args.sbUrl) list.push(args.sbUrl.replace(/\/$/, ""));
  const fromEnv = dotenv.NEXT_PUBLIC_SUPABASE_URL;
  if (fromEnv) list.push(fromEnv.replace(/\/$/, ""));
  // A loopback Supabase URL is unreachable from a remote browser, so the app
  // re-points the BROWSER client at its own `/sb` rewrite (src/lib/supabase/
  // client.ts). The smoke runs on the host, so both may work — try the /sb
  // prefix last, since it depends on the rewrite being baked into the build.
  list.push(`${args.baseUrl}/sb`);
  return [...new Set(list)];
}

// ─── Checks ────────────────────────────────────────────────────────────────

async function checkHealth(baseUrl) {
  let res;
  try {
    res = await request(`${baseUrl}/api/health`);
  } catch (err) {
    record("health", "FAIL", `unreachable: ${err instanceof Error ? err.message : err}`);
    return null;
  }
  if (res.status !== 200) {
    record("health", "FAIL", `HTTP ${res.status}`);
    return null;
  }
  const body = res.body;
  if (!body || typeof body !== "object") {
    record("health", "FAIL", "non-JSON body");
    return null;
  }
  if (body.ok !== true) {
    record("health", "FAIL", `ok=${JSON.stringify(body.ok)} (expected true)`);
    return null;
  }
  if (body.db?.reachable !== true) {
    record("health", "FAIL", `db.reachable=${JSON.stringify(body.db?.reachable)} (expected true)`);
    return null;
  }
  record("health", "PASS", `ok=true db.reachable=true latencyMs=${body.db?.latencyMs ?? "?"}`);
  return body;
}

async function checkOcrAuthGate(baseUrl) {
  const res = await request(`${baseUrl}/api/extract/ocr`);
  if (res.status === 401 || res.status === 403) {
    record("ocr-auth-gate", "PASS", `unauthenticated GET → HTTP ${res.status}`);
    return;
  }
  record(
    "ocr-auth-gate",
    "FAIL",
    `unauthenticated GET /api/extract/ocr returned HTTP ${res.status} — expected 401/403. ` +
      "The route is serving anonymous callers; check requireLecturer wiring.",
  );
}

async function checkLogin(args, dotenv) {
  if (!args.email || !args.password) {
    record(
      "login",
      "FAIL",
      "--email/--password not supplied — the authenticated checks below cannot run. " +
        "This is a hard failure, NOT a skip: an unauthenticated smoke proves nothing about the auth surface.",
    );
    return null;
  }
  const anonKey = args.anonKey ?? dotenv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) {
    record(
      "login",
      "FAIL",
      "no Supabase anon key: pass --anon-key or set NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local",
    );
    return null;
  }

  const candidates = supabaseCandidates(args, dotenv);
  const attempts = [];

  for (const sbUrl of candidates) {
    for (const [label, fn] of [
      ["@supabase/ssr cookie jar", loginViaSsr],
      ["raw grant_type=password", loginViaPasswordGrant],
    ]) {
      try {
        const out = await fn({ sbUrl, anonKey, email: args.email, password: args.password });
        record("login", "PASS", `${args.email} via ${label} (${sbUrl})`);
        return out;
      } catch (err) {
        attempts.push(`${label} @ ${sbUrl}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Loud, explicit failure — never a silent pass.
  record(
    "login",
    "FAIL",
    "TODO — every login route failed. Provide a working (--sb-url, --anon-key) pair " +
      "or export them in .env.local. Attempts:\n      " +
      attempts.join("\n      "),
  );
  return null;
}

/**
 * An authenticated quiz-session fetch. Needs a session id: discovered through
 * the logged-in client's own RLS-scoped `quiz_sessions` read (a lecturer sees
 * their quizzes' sessions). No rows → SKIPPED, non-fatal — a fresh deployment
 * has no sessions until a class has actually run one.
 */
async function checkQuizSession(baseUrl, session) {
  if (!session?.client) {
    record(
      "quiz-session",
      "SKIP",
      "no authenticated Supabase client available (login used the raw fallback) — " +
        "cannot discover a session id",
    );
    return;
  }

  let rows;
  try {
    const { data, error } = await session.client
      .from("quiz_sessions")
      .select("id, quiz_id, status")
      .limit(1);
    if (error) throw new Error(error.message);
    rows = data ?? [];
  } catch (err) {
    record(
      "quiz-session",
      "SKIP",
      `could not discover a session id: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  if (rows.length === 0) {
    record(
      "quiz-session",
      "SKIP",
      "no quiz_sessions rows visible to this account — nothing has run a quiz yet",
    );
    return;
  }

  const id = rows[0].id;
  const res = await request(`${baseUrl}/api/sessions/${id}`, { cookie: session.cookieHeader });
  if (res.status === 200 && res.body && typeof res.body === "object" && res.body.id) {
    record(
      "quiz-session",
      "PASS",
      `GET /api/sessions/${id} → 200 (status=${res.body.status ?? "?"} mode=${res.body.mode ?? "?"})`,
    );
    return;
  }
  if (res.status === 404) {
    // The discovered row belongs to a quiz this account does not own, or the
    // session was deleted between the two calls — no oracle, so 404 is correct.
    record(
      "quiz-session",
      "SKIP",
      `GET /api/sessions/${id} → 404 (row not readable through the route for this account)`,
    );
    return;
  }
  record("quiz-session", "FAIL", `GET /api/sessions/${id} → HTTP ${res.status} (expected 200)`);
}

/**
 * The OCR GET probe — the shape the engine picker's `glmEngineInfo()` reads,
 * AND the liveness verdict the picker gates the option on.
 *
 * Two hard requirements:
 *  - the four contract fields must be PRESENT (a missing field makes the picker
 *    silently degrade to `available:false` and the AI Vision option vanishes);
 *  - `available` must be `true` — i.e. the engine actually WORKS. Checking only
 *    the shape reports PASS on a dead upstream (`available:false`,
 *    `reason:"unreachable"`), which is exactly the false green the O4 gate must
 *    not produce: the runbook's post-cutover checklist runs this script as the
 *    deployment gate, and a shape-only pass would certify a deployment whose
 *    OCR is entirely non-functional.
 *
 * `--allow-ocr-unavailable` is the escape hatch for a host where OCR is
 * intentionally not configured yet. It reports SKIP + a WARNING, never PASS.
 */
async function checkOcrProbe(baseUrl, session, args) {
  if (!session) {
    record("ocr-probe", "FAIL", "not run — the login check failed");
    return null;
  }
  const res = await request(`${baseUrl}/api/extract/ocr`, {
    cookie: session.cookieHeader,
    timeoutMs: 30_000,
  });
  if (res.status !== 200) {
    record(
      "ocr-probe",
      "FAIL",
      `authenticated GET /api/extract/ocr → HTTP ${res.status} (expected 200). ` +
        "A 403 means the account is not a lecturer; a 429 means the 6/min health bucket is spent.",
    );
    return null;
  }
  const body = res.body;
  if (!body || typeof body !== "object") {
    record("ocr-probe", "FAIL", "non-JSON body");
    return null;
  }
  const required = ["available", "provider", "maxPages", "reason"];
  const missing = required.filter((k) => !(k in body));
  if (missing.length > 0) {
    record(
      "ocr-probe",
      "FAIL",
      `response is missing ${missing.join(", ")} — the client contract (§4.5) requires all four. Got keys: ${Object.keys(body).join(", ")}`,
    );
    return null;
  }

  const detail =
    `available=${body.available} provider=${body.provider} reason=${body.reason} ` +
    `maxPages=${body.maxPages} maxImageBytes=${body.maxImageBytes ?? "?"} ` +
    `maxPdfBytes=${body.maxPdfBytes ?? "?"} cached=${body.cached ?? "?"}`;

  // HARD: the engine must actually be usable (see the header comment).
  if (body.available !== true) {
    const hint = ocrReasonHint(body.reason);
    if (args?.allowOcrUnavailable) {
      record(
        "ocr-probe",
        "SKIP",
        `${detail} — available is NOT true. Accepted only because ` +
          `--allow-ocr-unavailable was passed; the OCR engine is UNUSABLE on this host.${hint}`,
      );
      warn(
        "OCR IS NOT AVAILABLE on this deployment (probe reports " +
          `available=${body.available}, reason=${body.reason}, provider=${body.provider}). ` +
          "This run was allowed to continue by --allow-ocr-unavailable, so the O4 " +
          "gate did NOT prove the OCR path works." +
          hint,
      );
    } else {
      record(
        "ocr-probe",
        "FAIL",
        `available=${JSON.stringify(body.available)} (expected true) reason=${body.reason} ` +
          `provider=${body.provider} — the OCR engine is NOT usable on this deployment, ` +
          "so the AI Vision option will be hidden and extraction cannot work." +
          `${hint} Pass --allow-ocr-unavailable only if OCR is intentionally not ` +
          "configured on this host yet.",
      );
    }
    return body;
  }

  record("ocr-probe", "PASS", detail);
  return body;
}

/** Actionable next step for each `GlmHealthReason` (src/lib/ai/glm-health.ts). */
function ocrReasonHint(reason) {
  switch (reason) {
    case "unreachable":
      return (
        " [unreachable: the local vLLM/GLM-OCR container is not answering " +
        "GLM_BASE_URL — on the VPS that usually means the container was never " +
        "brought up, or GLM_PROVIDER should be `remote`.]"
      );
    case "auth":
      return (
        " [auth: the remote key was rejected (401/403) — ZAI_API_KEY is wrong, " +
        "expired, or has no entitlement. A dead key is NOT a read error.]"
      );
    case "misconfigured":
      return " [misconfigured: GLM_PROVIDER=remote but ZAI_API_KEY is empty.]";
    case "disabled":
      return " [disabled: GLM_SPEND_DISABLED=1 refuses all remote OCR by operator policy.]";
    case "rate_limited":
      return " [rate_limited: upstream capacity signal — retry later; check the Z.ai quota.]";
    case "error":
      return " [error: the upstream probe failed for a reason other than the above — check the app logs.]";
    default:
      return "";
  }
}

/**
 * cron — REPORT-ONLY unless `--expect-cron`.
 *
 * ⚠️ The health route returns `ok: true` even when `cron.degraded: true`, so the
 * assertion is on the `cron` block's own fields and NEVER on top-level `ok`.
 * The cron block is also lecturer-only (gate S6): an anonymous caller gets no
 * `cron` key at all, which is why this check needs the logged-in cookie.
 */
function checkCron(authedHealth, args) {
  const cron = authedHealth?.cron;
  const hard = args.expectCron;

  if (!cron) {
    const msg =
      "no `cron` block in the AUTHENTICATED /api/health response — either the " +
      "account is not a lecturer (gate S6) or the cron section is missing";
    if (hard) record("cron", "FAIL", msg);
    else record("cron", "SKIP", msg);
    return;
  }

  const ok = cron.ok === true;
  const neverRan = cron.neverRan ?? [];
  const missing = cron.missing ?? [];
  const detail =
    `cron.ok=${ok} missing=[${missing.join(", ")}] neverRan=[${neverRan.join(", ")}] ` +
    `jobs=${(cron.jobs ?? []).length} degraded=${cron.degraded}`;

  if (ok && neverRan.length === 0 && missing.length === 0) {
    record("cron", "PASS", detail);
    return;
  }
  if (hard) {
    record("cron", "FAIL", `${detail} — --expect-cron makes this fatal`);
  } else {
    record("cron", "SKIP", `${detail} — report-only (pass --expect-cron to make it fatal)`);
  }
}

function providerWarning(ocrBody, args) {
  if (!ocrBody) return;

  // Availability first: an unavailable engine is worth saying out loud whatever
  // the provider is. Previously this function compared ONLY `provider`, so an
  // `available:false` probe (dead upstream) produced no warning at all — the
  // silent half of the false-green defect.
  if (ocrBody.available !== true) {
    warn(
      `OCR probe reports available=${JSON.stringify(ocrBody.available)} ` +
        `(reason="${ocrBody.reason}", provider="${ocrBody.provider}") — the OCR ` +
        "engine is not usable on this deployment. The AI Vision option will be " +
        `hidden for every lecturer.${ocrReasonHint(ocrBody.reason)}`,
    );
  }

  const expect = args.expectProvider;
  if (expect !== "local" && expect !== "remote") {
    // Auto: a non-loopback base URL means a real deployment, which the plan
    // deploys with the metered remote leg. Serving `local` there is legal (an
    // operator may deliberately keep the free leg) but it is worth surfacing —
    // it usually means the container was never brought up on the VPS.
    if (ocrBody.provider === "local" && !isLoopback(args.baseUrl)) {
      warn(
        `OCR probe reports provider="local" on a non-loopback base URL (${args.baseUrl}). ` +
          "If this deployment was meant to use Z.ai, set GLM_PROVIDER=remote and " +
          "ZAI_API_KEY, then restart the app container.",
      );
    }
    return;
  }
  if (ocrBody.provider !== expect) {
    warn(
      `OCR probe reports provider="${ocrBody.provider}" but --expect-provider ${expect} was given.`,
    );
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const dotenv = loadDotEnvLocal();

  console.log("InnoVision VPS smoke (ops gate O4)");
  console.log(`  base-url : ${args.baseUrl}`);
  console.log(`  account  : ${args.email ?? "<none — authenticated checks will FAIL>"}`);
  console.log(`  cron     : ${args.expectCron ? "FATAL (--expect-cron)" : "report-only"}`);
  console.log("");

  // 1 — liveness + DB readiness (anonymous; also proves the probe is reachable).
  const health = await checkHealth(args.baseUrl);

  // 2 — the auth gate is ON for the OCR proxy.
  if (health) await checkOcrAuthGate(args.baseUrl);
  else record("ocr-auth-gate", "FAIL", "not run — the health check failed");

  // 3 — login round trip.
  const session = await checkLogin(args, dotenv);

  // 3b — the authenticated health read (cron lives behind the lecturer gate).
  let authedHealth = null;
  if (session) {
    const res = await request(`${args.baseUrl}/api/health`, { cookie: session.cookieHeader });
    if (res.status === 200 && res.body) authedHealth = res.body;
  }

  // 4 — authenticated quiz-session fetch.
  if (session) await checkQuizSession(args.baseUrl, session);
  else record("quiz-session", "FAIL", "not run — the login check failed");

  // 5 — the OCR probe shape the engine picker depends on, AND the engine's
  //     liveness (available:true is hard; see checkOcrProbe).
  const ocrBody = session
    ? await checkOcrProbe(args.baseUrl, session, args)
    : (record("ocr-probe", "FAIL", "not run — the login check failed"), null);

  // Report-only cron.
  if (session) checkCron(authedHealth, args);
  else record("cron", "SKIP", "not run — the login check failed");

  // Provider sanity warning (never fatal).
  providerWarning(ocrBody, args);

  // ── Table ──
  const nameWidth = Math.max(...results.map((r) => r.name.length), 5);
  console.log("");
  console.log("── Results ─────────────────────────────────────────────");
  console.log(`  ${"CHECK".padEnd(nameWidth)}  RESULT`);
  for (const r of results) {
    console.log(`  ${r.name.padEnd(nameWidth)}  ${r.status}`);
  }

  const failed = results.filter((r) => r.status === "FAIL");
  const passed = results.filter((r) => r.status === "PASS").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  console.log("");
  console.log(
    `${passed} passed, ${failed.length} failed, ${skipped} skipped (of ${results.length})`,
  );
  if (failed.length > 0) {
    console.log("Failed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail.split("\n")[0]}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(`\nvps-smoke crashed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
