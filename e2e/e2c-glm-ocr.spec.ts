import { test, expect } from "@playwright/test";
import { registerUser } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-glm-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

/**
 * E2-GLM — Lecturer: GLM-OCR (local Docker/vLLM) extraction → AI generation.
 *
 * Unlike E2 (which uses a text-layer PDF), this test uploads a SCANNED image
 * (no native text layer), so the extraction pipeline falls through to the
 * selected OCR engine. It selects GLM-OCR, which runs CLIENT-SIDE in the
 * browser and talks directly to the lecturer's local GLM-OCR container
 * (http://localhost:11434/v1/chat/completions). The subsequent quiz
 * generation still hits the mock AI server (AI_BASE_URL), so no real LLM is
 * contacted for question generation.
 *
 * Gated on GLM_BASE_URL being reachable (the GLM engine only appears in
 * the picker when the availability probe succeeds). Skipped otherwise.
 *
 * CI note: GitHub Actions runners do NOT run the GLM-OCR Docker container, so
 * this spec is skipped when `CI` is set (the E2E suite's Playwright config
 * already runs `workers: 1` + `retries: 2` in CI). The GLM-OCR path remains a
 * manual pre-demo checklist item (TESTING §7 #3) and is covered locally by
 * running `docker compose up -d glm-ocr` on the dev machine.
 */
test.describe("E2-GLM — GLM-OCR extraction from a scanned image", () => {
  test("lecturer extracts a scanned image with GLM-OCR, then generates", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    test.skip(!!process.env.CI, "GLM-OCR requires the local Docker container, not provisioned in CI");

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // ── 1. Lecturer registers + creates a class + draft quiz ────
    await registerUser(page, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(page.getByRole("heading", { name: "My Classes" })).toBeVisible();

    await page.getByLabel("Class title").fill("GLM Physics");
    await page.getByRole("button", { name: /create/i }).click();
    await expect(page.getByText("GLM Physics", { exact: true })).toBeVisible();

    await page.getByText("GLM Physics", { exact: true }).click();
    await expect(page).toHaveURL(/\/lecturer\/classes\/[^/]+$/);

    await page.getByLabel("Quiz title").fill("Chapter 1: Motion");
    await page.getByRole("button", { name: /new quiz/i }).click();
    await page.getByText("Chapter 1: Motion", { exact: true }).click();
    await expect(page).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    // ── 2. Open Generate-from-file, upload the scanned image ────
    await page.getByRole("button", { name: /generate from file/i }).click();
    await expect(
      page.getByRole("heading", { name: "Generate quiz from file" }),
    ).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles(
      "e2e/fixtures/scanned-chapter.png",
    );

    // ── 3. Select GLM-OCR (only present when the Docker container is reachable) ──
    // The probe succeeded ("GLM-OCR detected on this machine"); open the
    // dropdown, then pick the GLM option.
    await page.getByRole("combobox", { name: "OCR engine" }).click();
    const glmOption = page.getByRole("option", { name: /GLM-OCR/ });
    await expect(glmOption).toBeVisible({ timeout: 10_000 });
    await glmOption.click();

    // ── 4. Extract → GLM-OCR transcribes the image in-browser ──
    await page.getByRole("button", { name: /extract text/i }).click();
    await expect(
      page.getByText(/Velocity is the rate of change of displacement/),
    ).toBeVisible({ timeout: 120_000 });

    // ── 5. Generate (mock AI) → questions persisted + visible ──
    await page.getByRole("button", { name: /generate quiz/i }).click();
    await expect(
      page.getByText("What is velocity?", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    await ctx.close();
  });
});
