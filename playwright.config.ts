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

export default defineConfig({
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
        // chatStream's inter-chunk idle abort: the harness uses 3s so the
        // mock's [MOCK:stall] scenario (silent upstream) resolves in-test
        // instead of holding the route for the production 90s.
        AI_STREAM_IDLE_TIMEOUT_MS: "3000",
        OCR_VISION_MODEL: "gpt-4o-mini",
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
      },
    },
  ],
});
