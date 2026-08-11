import { test, expect } from "@playwright/test";
import { registerUser } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e2b-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

/**
 * E2b (Phase 4 scope) — Lecturer: AI regenerate one question (draft only)
 *
 * The Next.js dev server points AI_BASE_URL at e2e/mock-ai-server.mjs, so
 * /api/ai/regenerate-question hits the mock and returns a deterministic
 * replacement question.
 *
 * IMPORTANT: E2b builds its OWN draft quiz (independent of E2). E2 publishes at
 * the end; regenerate is draft-only, so reusing E2's published quiz would 409.
 * Playwright isolates contexts and runs files in parallel, so independence is
 * required for determinism.
 */

/** Create a class + a draft quiz with 2 questions. */
async function createDraftQuizWithQuestions(page: Page, classTitle: string, quizTitle: string) {
  await expect(page.getByRole("heading", { name: "My Classes" })).toBeVisible();
  await page.getByLabel("Class title").fill(classTitle);
  await page.getByRole("button", { name: /create/i }).click();
  await page.getByText(classTitle, { exact: true }).click();
  await expect(page).toHaveURL(/\/lecturer\/classes\/[^/]+$/);

  await page.getByLabel("Quiz title").fill(quizTitle);
  await page.getByRole("button", { name: /new quiz/i }).click();
  await page.getByText(quizTitle, { exact: true }).click();
  await expect(page).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

  // Q1
  await page.getByRole("textbox", { name: "Question" }).fill("What is velocity?");
  await page.getByLabel("Option 1").fill("Speed in a direction");
  await page.getByLabel("Option 2").fill("Total distance");
  await page.getByRole("button", { name: /add question/i }).click();
  await expect(page.getByRole("textbox", { name: "Question" })).toHaveValue("");
  await expect(page.getByText("What is velocity?", { exact: true })).toBeVisible();

  // Q2
  await page.getByRole("textbox", { name: "Question" }).fill("Which unit is force measured in?");
  await page.getByLabel("Option 1").fill("Joule");
  await page.getByLabel("Option 2").fill("Newton");
  await page.getByRole("button", { name: /add question/i }).click();
  await expect(page.getByRole("textbox", { name: "Question" })).toHaveValue("");
  await expect(page.getByText("Which unit is force measured in?", { exact: true })).toBeVisible();
}

test.describe("E2b — Regenerate a single question (draft only)", () => {
  test("lecturer regenerates Q1; sibling untouched", async ({ browser }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const page = await lecturerCtx.newPage();

    await registerUser(page, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await createDraftQuizWithQuestions(page, "E2b Physics", "Chapter 2: Motion");

    // Register the confirm-dialog handler BEFORE clicking Regenerate.
    page.on("dialog", (d) => d.accept());
    const regenButtons = page.getByRole("button", { name: "Regenerate question" });
    await regenButtons.first().click();

    // The mock AI server returns "REPLACED: What is acceleration?".
    await expect(
      page.getByText("REPLACED: What is acceleration?", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    // The sibling is untouched.
    await expect(
      page.getByText("Which unit is force measured in?", { exact: true }),
    ).toBeVisible();

    await lecturerCtx.close();
  });
});
