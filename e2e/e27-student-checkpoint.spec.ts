import { test, expect } from "@playwright/test";
import { registerUser } from "./helpers";

/**
 * E27 — Student self-play checkpoint resume + corrupt-progress fallback.
 * Serial tests over one shared creator + quiz:
 *   1. Progress checkpoint: answer Q1 → reload → resumes at Q2 (counter
 *      "Question 2 of 3", Q1 prompt not the active heading). Answer through to
 *      the end screen ("Practice complete" + "Try again"); retry → Q1 again and
 *      the checkpoint is cleared (reload still shows Q1).
 *   2. Corrupt progress JSON under `sq-progress:<quizId>` (player-client.tsx
 *      catch{} at :84-86) → silent fresh start at Q1.
 */

const stamp = Date.now();
const CREATOR = `e27-creator-${stamp}@e2e.test`;
const QUIZ_TITLE = `E27 Checkpoint ${stamp}`;

let quizId = "";

test.describe.configure({ mode: "serial" });

async function createQuizWithThreeQuestions(page: import("@playwright/test").Page) {
  await page.goto("/student/my-quizzes");
  await page.getByRole("link", { name: /create quiz/i }).click();
  await page.getByLabel("Title").fill(QUIZ_TITLE);
  await page.getByRole("button", { name: /create quiz/i }).click();
  await page.waitForURL(/\/student\/my-quizzes\/[^/]+\/edit/);

  const questions: Array<[string, string, string]> = [
    ["What is the capital of France?", "Paris", "London"],
    ["Which planet is red?", "Mars", "Venus"],
    ["What is 2 + 2?", "Four", "Three"],
  ];
  for (const [prompt, optA, optB] of questions) {
    const optionInputs = page.locator("fieldset input[maxlength='500']");
    await optionInputs.nth(0).fill(optA);
    await optionInputs.nth(1).fill(optB);
    await page.getByRole("textbox", { name: /prompt/i }).fill(prompt);
    await page.getByRole("radio").first().check();
    await page.getByRole("button", { name: /add question/i }).click();
    await expect(page.getByText(prompt, { exact: true })).toBeVisible();
  }
}

async function answerQuestion(page: import("@playwright/test").Page, optionText: string) {
  await page.getByRole("button", { name: optionText }).click();
  await expect(page.getByRole("status").filter({ hasText: /correct!|not quite/i })).toBeVisible();
}

test("checkpoint resume + retry clears progress", async ({ page }) => {
  await registerUser(page, CREATOR, "student", "");
  await createQuizWithThreeQuestions(page);

  // Open self-play from the dashboard.
  await page.goto("/student/my-quizzes");
  await page.getByRole("link", { name: /play/i }).first().click();
  await page.waitForURL(/\/play\/student\//);
  quizId = new URL(page.url()).pathname.split("/").pop() ?? "";
  await expect(page.getByText("Question 1 of 3")).toBeVisible();

  // Answer Q1, then reload mid-quiz → resume at Q2.
  await answerQuestion(page, "Paris");
  await page.reload();
  await expect(page.getByText("Question 2 of 3")).toBeVisible();
  await expect(page.getByText("What is the capital of France?", { exact: true })).toBeHidden();

  // Answer Q2, reload → Q3.
  await answerQuestion(page, "Mars");
  await page.reload();
  await expect(page.getByText("Question 3 of 3")).toBeVisible();

  // Finish → end screen.
  await answerQuestion(page, "Four");
  await page.getByRole("button", { name: /^(see results|next)$/i }).click();
  await expect(page.getByText("Practice complete")).toBeVisible();
  await expect(page.getByText("Try again")).toBeVisible();

  // Try again → back at Q1, and the checkpoint is cleared (reload stays Q1).
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("Question 1 of 3")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Question 1 of 3")).toBeVisible();
});

test("corrupt checkpoint falls back to a fresh start", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await registerUser(page, CREATOR, "student", "");
  await page.goto(`/play/student/${quizId}`);
  await expect(page.getByText("Question 1 of 3")).toBeVisible();

  await page.addInitScript(({ key, corrupt }) => {
    sessionStorage.setItem(key, corrupt);
  }, { key: `sq-progress:${quizId}`, corrupt: "{not valid json!!" });
  await page.reload();
  await expect(page.getByText("Question 1 of 3")).toBeVisible();

  await ctx.close();
});
