import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { existsSync } from "fs";

// Load .env.local (without overriding already-set process env) so E2E specs
// see LECTURER_INVITE_CODE etc. without requiring shell exports.
if (existsSync(".env.local")) {
  loadEnv({ path: ".env.local", override: false });
}

const PORT = process.env.PLAYWRIGHT_PORT ?? "3001";
const BASE_URL = `http://localhost:${PORT}`;
const MOCK_AI_PORT = process.env.MOCK_AI_PORT ?? "8787";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  maxFailures: process.env.CI ? 1 : undefined,
  // Capped locally: even the production server saturates with too many
  // parallel workers on one DB (register storms hit the same auth tables).
  workers: process.env.CI ? 1 : 4,
  reporter: "html",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
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
      // PRODUCTION server, never `next dev`: dev compiles every route on
      // demand (per-navigation latency, unbounded memory, dev-only error
      // overlays) and was the shared bottleneck of this suite. `next build`
      // runs once up front; `next start` serves prebuilt routes at flat
      // latency. PLAYWRIGHT_BUILD=0 reuses a warm .next to skip the rebuild.
      command: process.env.PLAYWRIGHT_BUILD === "0"
        ? `npm run start -- -p ${PORT}`
        : `npm run build && npm run start -- -p ${PORT}`,
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
        // defaults stay 5/min per email and 10/min per IP.
        RESET_RATE_LIMIT: "1000",
        RESET_IP_RATE_LIMIT: "1000",
        RESET_CONFIRM_RATE_LIMIT: "1000",
        // AU-2 matric-gate spec (e47) fires capture attempts in one window;
        // raised for the harness only — production default stays 5/min per IP.
        MATRIC_CAPTURE_RATE_LIMIT: "1000",
        AI_BASE_URL: `http://127.0.0.1:${MOCK_AI_PORT}/v1`,
        AI_API_KEY: "test-key",
        AI_MODEL: "gpt-4o-mini",
        OCR_VISION_MODEL: "gpt-4o-mini",
        // CompreFace mock mode — E2E must NOT require a running Docker container.
        COMPREFACE_BASE_URL: "http://localhost:8000",
        COMPREFACE_API_KEY: "test-key",
        COMPREFACE_MOCK_ENABLED: "1",
        // Fake tracker seams (face + hand). The suite serves the PRODUCTION
        // build where NODE_ENV-based seam gating is dead — the seams need an
        // explicit harness-only opt-in that survives the build (src/lib/face/
        // seam-gate.ts). NEVER set this outside the Playwright harness.
        NEXT_PUBLIC_E2E_FAKE_SEAM: "1",
      },
    },
  ],
});
