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

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
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
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
