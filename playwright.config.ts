import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { existsSync } from "fs";
import os from "os";

// Load .env.local (without overriding already-set process env) so E2E specs
// see LECTURER_INVITE_CODE etc. without requiring shell exports.
if (existsSync(".env.local")) {
  loadEnv({ path: ".env.local", override: false });
}

const PORT = process.env.PLAYWRIGHT_PORT ?? "3001";
const BASE_URL = `http://localhost:${PORT}`;
const MOCK_AI_PORT = process.env.MOCK_AI_PORT ?? "8787";
const MOCK_TINYFISH_PORT = process.env.MOCK_TINYFISH_PORT ?? "8788";
const NOWEBSEARCH_PORT = process.env.PLAYWRIGHT_NOWEBSEARCH_PORT ?? "3002";

/**
 * Build policy: ALWAYS rebuild fresh before every suite run.
 *
 * The old smart-check (`src/`/`public/` mtime vs `.next/BUILD_ID`, PLAYWRIGHT_BUILD=0 to skip) was removed: NEXT_PUBLIC_* env vars
 * (NEXT_PUBLIC_E2E_FAKE_SEAM, NEXT_PUBLIC_SUPABASE_URL, ...) are inlined at
 * build time, so a bundle produced by a manual `npm run build` — or any build
 * without the harness env — bakes a dead fake-tracker seam into the suite and
 * fails face/gesture specs cluster-wide while looking "warm". Rebuilding under
 * the webServer env makes the harness bundle's env self-consistent every run.
 */

/**
 * ── S1/S5 kill-switch disarm: PROD_ENV_STRICT MUST stay pinned to "" ──────────
 *
 * `PROD_ENV_STRICT=1` arms the fail-closed production env gate
 * (`src/lib/prod-guards.ts` via `src/instrumentation.ts`): with `NODE_ENV=
 * production` — which `npm run start` always is — the app REFUSES TO START when
 * any of the four kill switches is armed. That is correct for a deployment and
 * FATAL for this harness, which arms all four on purpose (`E2E_RATE_LIMIT_
 * DISABLED`, `NEXT_PUBLIC_E2E_FAKE_SEAM`, `FACE_MOCK_ENABLED`, `NEXT_PUBLIC_
 * INTEGRITY_HARDENING_OFF`). The failure mode is brutal: the server exits
 * immediately, the port is never bound, and every spec dies on Playwright's
 * 300 s webServer timeout — `reuseExistingServer` cannot help, because there is
 * no server to reuse.
 *
 * It is not a hypothetical: `docs/DEPLOY_VPS.md` §8.2 INSTRUCTS the operator to
 * put `PROD_ENV_STRICT=1` in `.env.local` (`grep -c '^PROD_ENV_STRICT=1$'
 * .env.local # must be 1`), and `:8-10` loads `.env.local` into `process.env`
 * without overriding, while both app webServer env blocks below spread
 * `...process.env`. So a developer who follows the runbook and then runs the
 * e2e suite would break the whole suite. Same for a shell that exports it.
 *
 * The pin uses the same idiom as `TINYFISH_*` / `GLM_PROVIDER` below: an
 * explicit value in the webServer env wins over `process.env` (Playwright
 * merges `{...process.env, ...webServer.env}`) and over `.env.local` (Next's
 * env loader never overwrites an already-present var). An EMPTY value, not
 * `"0"`: `prod-guards` hard-fails only on exactly `"1"`, and "" is also what a
 * fresh checkout has, so the harness env matches the no-config default.
 *
 * `assertProdEnvStrictPinned()` below fails the config load if either pin is
 * ever removed, so this cannot regress silently.
 */
const PROD_ENV_STRICT_PIN = "";

/** Regression guard for the pin above (see the block comment).
 *
 *  Checks every webServer entry that BOOTS THE NEXT APP (`npm run start` /
 *  `next start` — the mock servers are plain node processes that never read
 *  `PROD_ENV_STRICT`). Any such server must pin the gate off, because it runs
 *  with `NODE_ENV=production` and therefore honours `prod-guards.ts`. Adding a
 *  third app server without the pin fails the config load here rather than the
 *  whole suite 300 s later. */
function assertProdEnvStrictPinned(
  servers: readonly { command?: string; env?: Record<string, string> }[],
): void {
  const appServers = servers.filter((s) => /(npm run start|next start)/.test(s.command ?? ""));
  if (appServers.length === 0) {
    throw new Error(
      "playwright.config.ts: assertProdEnvStrictPinned found no app webServer " +
        "(expected the `npm run start` entries). The guard's detection regex has " +
        "rotted — fix it, do not delete the check.",
    );
  }
  appServers.forEach((server, i) => {
    const label = `app webServer #${i + 1} (${(server.command ?? "").slice(0, 60)}…)`;
    const env = server.env ?? {};
    if (!("PROD_ENV_STRICT" in env)) {
      throw new Error(
        `playwright.config.ts: ${label} has no PROD_ENV_STRICT pin. Add ` +
          "`PROD_ENV_STRICT: PROD_ENV_STRICT_PIN` — without it a " +
          ".env.local/shell carrying PROD_ENV_STRICT=1 makes the prod gate " +
          "refuse to start the server and EVERY spec fails on the webServer " +
          "timeout. See the pin comment at the top of this file.",
      );
    }
    if (env.PROD_ENV_STRICT !== "") {
      throw new Error(
        `playwright.config.ts: ${label} pins PROD_ENV_STRICT=` +
          `${JSON.stringify(env.PROD_ENV_STRICT)}; it MUST be "" — the harness ` +
          "deliberately arms all four kill switches, so the prod gate must not " +
          "be armed. See the pin comment at the top of this file.",
      );
    }
  });
}

const config = defineConfig({
  testDir: "./e2e",
  testIgnore: process.env.FACE_SMOKE ? [] : ["**/insightface-smoke.spec.ts"],
  timeout: 30_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  maxFailures: process.env.CI ? 1 : undefined,
  // Capped in CI to prevent runner CPU saturation; scaled to machine capacity locally
  workers: process.env.CI ? 1 : Math.min(6, os.cpus().length || 4),
  // HTML stays the human-facing report; `line` streams one stdout line per test
  // so agent/CI runs capture per-test results (incl. retries) without digging
  // through playwright-report/ blobs — a plain "html" reporter prints almost
  // nothing to stdout on a green run.
  reporter: [["html"], ["line"], ["./scripts/e2e-min-exec-reporter.mjs"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // m* specs exercise the mobile compositions (dock, bottom sheets, PIP
      // play stage) that only render at phone viewports — running them on the
      // 1280×720 desktop project would fail every assertion and, with CI's
      // maxFailures: 1, abort the whole step. They run in the `mobile`
      // project below.
      testIgnore: ["**/m*.spec.ts", "**/e2f-web-generate-flags.spec.ts"],
    },
    {
      // Mobile project (plan §6): phone viewport + touch + mobile UA so the
      // coarse-pointer branches (:active press physics, hit-slop, pointer:coarse
      // rules) are actually exercised. testMatch pins it to the m* allowlist
      // so CI cost stays a handful of specs, not a second full run.
      name: "mobile",
      use: {
        ...devices["iPhone X"],
        // Chromium engine with the iPhone descriptor (375×812, hasTouch,
        // isMobile, mobile UA): the device's default WebKit would force a
        // second browser install in CI (ci.yml installs chromium only).
        browserName: "chromium",
      },
      testMatch: ["**/m*.spec.ts"],
    },
    {
      // Flag-off project (grounded-search.md §9C): TINYFISH_API_KEY explicitly
      // EMPTY so isWebSearchEnabled() is false — proves the "Web topic" mode
      // is hidden and the file flow is intact without the feature. Runs one
      // tiny spec against the SAME build on a second port (TINYFISH_* is
      // server-runtime env, so no second build is needed).
      name: "chromium-nowebsearch",
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${NOWEBSEARCH_PORT}` },
      testMatch: ["**/e2f-web-generate-flags.spec.ts"],
      testIgnore: ["**/m*.spec.ts"],
    },
  ],
  webServer: [
    {
      // Mock [OI]-compatible endpoint so /api/ai/generate-quiz and
      // /api/ai/regenerate-question never hit a real model in CI (TESTING §1).
      command: `node e2e/mock-ai-server.mjs`,
      url: `http://127.0.0.1:${MOCK_AI_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // Mock TinyFish Search+Fetch (grounded-search.md §9C) — the route calls
      // TinyFish server-side, so a real local server is needed the same way.
      command: `node e2e/mock-tinyfish-server.mjs`,
      url: `http://127.0.0.1:${MOCK_TINYFISH_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { MOCK_TINYFISH_PORT: String(MOCK_TINYFISH_PORT) },
    },
    {
      // PRODUCTION server: rebuilt fresh every run (see the build-policy note
      // above — env is inlined at build time, so the bundle must be produced
      // under THIS env block).
      command: `npm run build && npm run start -- -p ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: {
        ...process.env,
        // The suite registers dozens of accounts from 127.0.0.1 inside a
        // single rate-limit window; the app's anti-abuse budget (10/min)
        // would silently reject the overflow and poison every later auth
        // step. Raised for the harness only — production default is 10.
        SIGNUP_RATE_LIMIT: "1000",
        INVITE_RATE_LIMIT: "1000",
        // Same class of flake for the reset path: e34 fires several
        // resetPasswordForEmail calls (incl. per-IP budget) within one window
        // and retries in CI. Raised for the harness only — production
        // defaults stay 5/min per email and 30/min per IP (audit-3 R2-TOP-F5
        // raised the IP budget to the classroom-NAT-tolerant login precedent),
        // with a 10/day per-email ceiling (audit-3 R2-TOP-F3) that the harness
        // also lifts.
        RESET_RATE_LIMIT: "1000",
        RESET_IP_RATE_LIMIT: "1000",
        RESET_CONFIRM_RATE_LIMIT: "1000",
        RESET_EMAIL_DAILY_LIMIT: "1000",
        // Kill-switch for the ~60 hardcoded per-route budgets (VERIFY_RATE,
        // START_RATE, the non-tunable `invite:global` 100/min signup bucket,
        // ...) which the suite's 6-worker burst overflows mid-run — the
        // 2026-09-04 mass-failure root cause (see TESTING §5.3). Inert in
        // production (flag unset); rate limiting is still proven by the
        // route-level vitest tests, which seed buckets directly.
        E2E_RATE_LIMIT_DISABLED: "1",
        // AU-2 matric-gate spec (e47) fires capture attempts in one window;
        // raised for the harness only — production default stays 5/min per IP.
        MATRIC_CAPTURE_RATE_LIMIT: "1000",
        AI_BASE_URL: `http://127.0.0.1:${MOCK_AI_PORT}/v1`,
        AI_API_KEY: "test-key",
        AI_MODEL: "gpt-4o-mini",
        // Grounded web search (grounded-search.md §9C): ALWAYS explicit —
        // never inherit a real TINYFISH_API_KEY from .env.local (the suite
        // would silently gain web mode on machines that have one).
        TINYFISH_API_KEY: "test-tinyfish-key",
        TINYFISH_SEARCH_URL: `http://127.0.0.1:${MOCK_TINYFISH_PORT}`,
        TINYFISH_FETCH_URL: `http://127.0.0.1:${MOCK_TINYFISH_PORT}`,
        // S1/S5 — pin the prod fail-closed gate OFF for the harness. This block
        // arms all four kill switches deliberately (below), and `npm run start`
        // runs with NODE_ENV=production, so an inherited `PROD_ENV_STRICT=1`
        // (a .env.local written by following docs/DEPLOY_VPS.md §8.2, or a
        // shell export) would make instrumentation.ts refuse to boot and kill
        // the entire suite on the 300 s webServer timeout. See the pin comment
        // at the top of this file.
        PROD_ENV_STRICT: PROD_ENV_STRICT_PIN,
        // chatStream's inter-chunk idle abort: the harness uses 3s so the
        // mock's [MOCK:stall] scenario (silent upstream) resolves in-test
        // instead of holding the route for the production 90s.
        AI_STREAM_IDLE_TIMEOUT_MS: "3000",
        OCR_VISION_MODEL: "gpt-4o-mini",
        // GLM-OCR provider selector (src/lib/ai/glm-provider.ts). Pinned to the
        // FREE local leg for the same reason as TINYFISH_API_KEY above: the
        // harness must NEVER be able to spend money. A developer shell (or a
        // .env.local that playwright.config.ts loads without overriding) with
        // `GLM_PROVIDER=remote` would otherwise flip this build onto the
        // METERED Z.ai leg, where e2c's OCR run — and the health GET's billed
        // 1×1-PNG probe — would bill a real key. Fail-closed in the app, and
        // explicit here so the harness env is self-consistent either way.
        GLM_PROVIDER: "local",
        // InsightFace mock mode — E2E must NOT require a running Docker container.
        INSIGHTFACE_BASE_URL: "http://localhost:8000",
        FACE_MOCK_ENABLED: "1",
        // Fake tracker seams (face + hand). The suite serves the PRODUCTION
        // build where NODE_ENV-based seam gating is dead — the seams need an
        // explicit harness-only opt-in that survives the build (src/lib/face/
        // seam-gate.ts). NEVER set this outside the Playwright harness.
        NEXT_PUBLIC_E2E_FAKE_SEAM: "1",
        // Integrity hardening OFF for the main suite (src/lib/integrity/
        // hardening-gate.ts): clipboard/fullscreen lockdown must not fight
        // headless runs (fullscreen events are flaky headless; copy guards
        // would break fixture-building copy). Build-time inlined like the
        // seam above — a run WITHOUT this var bakes the hardening IN, which
        // is exactly what the opt-in e51 spec wants: running the harness
        // with INTEGRITY_E2E=1 omits the kill switch (run e51 ONLY in that
        // mode — see TESTING §5.2; the main suite would fail against a
        // hardening-ON build).
        ...(process.env.INTEGRITY_E2E === "1"
          ? {}
          : { NEXT_PUBLIC_INTEGRITY_HARDENING_OFF: "1" }),
      },
    },
    {
      // Flag-off server instance (chromium-nowebsearch project): serves the
      // SAME .next build on a second port with TINYFISH_* explicitly cleared —
      // process.env spread happens FIRST so these overrides win. node -e is
      // used instead of a shell `while` (webServer commands run under cmd.exe
      // on Windows).
      command: `node -e "const fs=require('fs');(function w(){fs.existsSync('.next/BUILD_ID')?require('child_process').execSync('npm run start -- -p ${NOWEBSEARCH_PORT}',{stdio:'inherit'}):setTimeout(w,1000)})()"`,
      url: `http://localhost:${NOWEBSEARCH_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...process.env,
        TINYFISH_API_KEY: "",
        TINYFISH_SEARCH_URL: "",
        TINYFISH_FETCH_URL: "",
        // This instance inherits `...process.env` (unlike the main webServer,
        // which pins it), so a developer's shell — or the .env.local this
        // config loads — could leak `GLM_PROVIDER=remote` into a server that
        // still serves requests. The metered leg is BILLED per token; pin the
        // free leg explicitly. (TINYFISH_* above are cleared for the same
        // "never inherit a real credential" reason.)
        GLM_PROVIDER: "local",
        // S1/S5 — same pin as the main block, for the same reason: this block
        // spreads `...process.env`, so an inherited PROD_ENV_STRICT=1 would
        // make the prod gate refuse to boot this instance and every
        // chromium-nowebsearch spec would fail on its 120 s timeout. See the
        // pin comment at the top of this file.
        PROD_ENV_STRICT: PROD_ENV_STRICT_PIN,
      },
    },
  ],
});

// Fail the config load (not the suite, minutes later) if a future edit drops or
// changes the pin on any app webServer. Reads the config just built, so the
// webServer blocks stay the single source of truth.
assertProdEnvStrictPinned(config.webServer as { command?: string; env?: Record<string, string> }[]);

export default config;
