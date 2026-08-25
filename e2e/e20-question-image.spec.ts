import { test, expect } from "@playwright/test";
import { registerUser, E2E_PASSWORD } from "./helpers";

/**
 * E20 — Question images end-to-end (plan F2).
 * Student attaches ONE image to a practice question (route-mediated upload),
 * then sees it render in self-play AND in a shared-code player's run. The
 * assessment-side visibility matrix is covered authoritatively by
 * scripts/verify-media.mjs MEDIA-D2; this spec pins the RENDERING path.
 */

const stamp = Date.now();
const AUTHOR = `img-stu-${stamp}1@e2e.test`;
const PLAYER = `img-player-${stamp}2@e2e.test`;
const QUIZ_TITLE = `Image Practice ${stamp}`;
const QUESTION_PROMPT = "Which shape is the circle?";

test.describe.configure({ mode: "serial" });

let shareCode = "";

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/Email/).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/(student|lecturer)\//, { timeout: 30_000 });
}

test("attach image → renders in self-play", async ({ page }) => {
  await registerUser(page, AUTHOR, "student", "");

  await page.goto("/student/my-quizzes");
  await page.getByRole("link", { name: /create quiz/i }).click();
  await page.getByLabel("Title").fill(QUIZ_TITLE);
  await page.getByRole("button", { name: /create quiz/i }).click();
  await page.waitForURL(/\/student\/my-quizzes\/[^/]+\/edit/);

  // Add one question.
  const optionInputs = page.locator("fieldset input[maxlength='500']");
  await optionInputs.nth(0).fill("Square");
  await optionInputs.nth(1).fill("Circle");
  await page.getByRole("textbox", { name: /prompt/i }).fill(QUESTION_PROMPT);
  await page.getByRole("radio").nth(1).check(); // Circle correct
  await page.getByRole("button", { name: /add question/i }).click();
  await expect(page.getByText(QUESTION_PROMPT)).toBeVisible();

  // Attach the tiny PNG via the card's hidden file input.
  const attachButton = page.getByRole("button", { name: /^attach image/i });
  await expect(attachButton).toBeVisible({ timeout: 15_000 });
  const fileChooserPromise = page.waitForEvent("filechooser");
  await attachButton.click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles("e2e/fixtures/tiny.png");

  // The label flips to Replace + "Image attached" once the POST resolves.
  await expect(page.getByRole("button", { name: /^replace image/i })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/image attached/i)).toBeVisible();

  // Self-play renders the image above the options.
  await page.getByRole("link", { name: /open builder|play/i }).first().click();
  await page.waitForURL(/\/play\/student\//);
  const img = page.locator("img[decoding='async']").first();
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await img.evaluate((el: HTMLImageElement) => el.naturalWidth))).toBeGreaterThan(0);

  // Answer to reach the feedback flow without image interference.
  await page.getByRole("button", { name: "Circle" }).click();
  await expect(page.getByText(/correct!/i)).toBeVisible();
});

test("share-code player also sees the image; unshare kills new mints", async ({ browser }) => {
  // Creator shares.
  const creatorCtx = await browser.newContext();
  const creator = await creatorCtx.newPage();
  await signIn(creator, AUTHOR);
  await creator.goto("/student/my-quizzes");
  await creator.getByText(QUIZ_TITLE, { exact: true }).waitFor();
  await creator.getByRole("button", { name: /^share/i }).click();
  const linkInput = creator.locator("input[readonly]");
  await expect(linkInput).toBeVisible({ timeout: 15_000 });
  shareCode = (await linkInput.inputValue()).split("/s/")[1] ?? "";
  expect(shareCode).toBeTruthy();
  await creatorCtx.close();

  // Player registers, then plays via the link and sees the same image.
  const playerCtx = await browser.newContext();
  const player = await playerCtx.newPage();
  await registerUser(player, PLAYER, "student", "");
  await player.goto(`/s/${shareCode}`);
  await player.getByRole("button", { name: /start practice/i }).click();
  const img = player.locator("img[decoding='async']").first();
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await img.evaluate((el: HTMLImageElement) => el.naturalWidth))).toBeGreaterThan(0);
  await playerCtx.close();
});
