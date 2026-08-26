import { test, expect } from "@playwright/test";
import { registerUser, E2E_PASSWORD } from "./helpers";

/**
 * E32 — Share-code rotation + mid-play unshare (MEDIUM d+e).
 * Serial tests over one creator + quiz:
 *   1. Regenerate: "New code" → armed "Confirm" → the dialog swaps to a fresh
 *      code; a THIRD-PARTY recipient who loaded the OLD link now gets the same
 *      neutral invalid screen as unknown codes (revoked codes never kill an
 *      already-open player — here the recipient revisits).
 *   2. Unshare mid-run: a recipient starts a 2-question quiz; the creator
 *      "Stop sharing"; the next answer POST → uniform 404 "unavailable" → the
 *      question is marked unavailable (no per-question reveal) and advances;
 *      answering the last question trips the fatal unavailable screen; a
 *      reload of /s/<code> shows the same neutral screen.
 */

const stamp = Date.now();
const CREATOR = `e32-creator-${stamp}@e2e.test`;
const PLAYER_A = `e32-playerA-${stamp}@e2e.test`;
const PLAYER_B = `e32-playerB-${stamp}@e2e.test`;
const QUIZ_TITLE = `E32 Share ${stamp}`;
const CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/;

let codeA = "";

test.describe.configure({ mode: "serial" });

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/Email/).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/(student|lecturer)\//, { timeout: 30_000 });
}

async function createTwoQuestionQuiz(page: import("@playwright/test").Page) {
  await page.goto("/student/my-quizzes");
  await page.getByRole("link", { name: /create quiz/i }).click();
  await page.getByLabel("Title").fill(QUIZ_TITLE);
  await page.getByRole("button", { name: /create quiz/i }).click();
  await page.waitForURL(/\/student\/my-quizzes\/[^/]+\/edit/);

  for (const [prompt, optA, optB] of [
    ["Q1 — pick the right one?", "Paris", "London"],
    ["Q2 — pick the other right one?", "Mars", "Venus"],
  ]) {
    const optionInputs = page.locator("fieldset input[maxlength='500']");
    await optionInputs.nth(0).fill(optA);
    await optionInputs.nth(1).fill(optB);
    await page.getByRole("textbox", { name: /prompt/i }).fill(prompt);
    await page.getByRole("radio").first().check();
    await page.getByRole("button", { name: /add question/i }).click();
    await expect(page.getByText(prompt, { exact: true })).toBeVisible();
  }
}

async function openShareDialog(page: import("@playwright/test").Page): Promise<string> {
  await page.goto("/student/my-quizzes");
  await page.getByText(QUIZ_TITLE, { exact: true }).waitFor();
  await page.getByRole("button", { name: /^share$/i }).click();
  const linkInput = page.locator("input[readonly]");
  await expect(linkInput).toBeVisible({ timeout: 15_000 });
  const code = (await linkInput.inputValue()).split("/s/")[1] ?? "";
  expect(code).toMatch(CODE_REGEX);
  return code;
}

test("regenerate rotates the code; the old link renders the neutral screen", async ({
  browser,
}) => {
  const creatorCtx = await browser.newContext();
  const creator = await creatorCtx.newPage();
  await registerUser(creator, CREATOR, "student", "");
  await createTwoQuestionQuiz(creator);
  codeA = await openShareDialog(creator);

  // A third party is ALREADY playing the old link when the code is rotated.
  const playerCtx = await browser.newContext();
  const player = await playerCtx.newPage();
  await registerUser(player, PLAYER_A, "student", "");
  await player.goto(`/s/${codeA}`);
  await expect(player.getByText(/community-made practice content/i)).toBeVisible();

  // Rotate: "New code" arms → "Confirm" swaps in a fresh code. Poll the
  // readonly input until it genuinely differs from the old link (the PATCH
  // resolves async; a bare not-toHaveValue can read the transient empty state).
  const dialog = creator.getByRole("dialog");
  await dialog.getByRole("button", { name: /new code/i }).click();
  await dialog.getByRole("button", { name: /^confirm$/i }).click();
  const freshInput = creator.locator("input[readonly]");
  await expect
    .poll(async () => (await freshInput.inputValue()).split("/s/")[1] ?? "")
    .not.toBe(codeA);
  let currentCode = (await freshInput.inputValue()).split("/s/")[1] ?? "";
  expect(currentCode).toMatch(CODE_REGEX);
  expect(currentCode).not.toBe(codeA);

  // The OLD link is now indistinguishable from an unknown code.
  await player.goto(`/s/${codeA}`);
  await expect(player.getByText(/invalid or no longer available/i)).toBeVisible();

  await creatorCtx.close();
  await playerCtx.close();
});

test("unshare mid-play: next answer 404 → unavailable → fatal screen", async ({
  browser,
}) => {
  const creatorCtx = await browser.newContext();
  const creator = await creatorCtx.newPage();
  await signIn(creator, CREATOR);
  const currentCode = await openShareDialog(creator);

  const playerCtx = await browser.newContext();
  const player = await playerCtx.newPage();
  await registerUser(player, PLAYER_B, "student", "");
  await player.goto(`/s/${currentCode}`);
  await expect(player.getByText(/community-made practice content/i)).toBeVisible();
  await player.getByRole("button", { name: /start practice/i }).click();
  await expect(player.getByText("Question 1 of 2")).toBeVisible();

  // Creator stops sharing while the recipient is mid-quiz.
  await creator.getByRole("button", { name: /^stop sharing$/i }).click();
  await expect(creator.getByText(/sharing stopped/i)).toBeVisible();

  // Answer Q1 → 404 unavailable → question marked unavailable, NO reveal
  // feedback, and the quiz advances to Q2.
  await player.getByRole("button", { name: "Paris" }).click();
  await expect(player.getByRole("status").filter({ hasText: /correct!|not quite/i })).toHaveCount(0);
  await expect(player.getByText("Question 2 of 2")).toBeVisible();

  // Answer Q2 → all questions unavailable → fatal screen.
  await player.getByRole("button", { name: "Mars" }).click();
  await expect(player.getByText("This practice quiz is no longer available.")).toBeVisible();

  // Reloading the link renders the same neutral invalid screen.
  await player.goto(`/s/${currentCode}`);
  await expect(player.getByText(/invalid or no longer available/i)).toBeVisible();

  await creatorCtx.close();
  await playerCtx.close();
});
