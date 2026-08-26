import { test, expect } from "@playwright/test";
import { registerUser, E2E_PASSWORD } from "./helpers";

/**
 * E17 — Student-created practice quizzes (shareable).
 * Split into three serial tests over shared setup (PLAN §6.4):
 *   1. Creator lifecycle: create → add questions → self-play → end screen.
 *   2. Share flow: second account plays via /s/[code]; logged-out recipient
 *      survives the login wall and lands back on the link.
 *   3. Revocation: unshare kills the link uniformly; delete cascades.
 */

const stamp = Date.now();
const CREATOR = `sq-creator-${stamp}@e2e.test`;
const PLAYER = `sq-player-${stamp}@e2e.test`;
const QUIZ_TITLE = `SQ Practice ${stamp}`;
const CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/;

let shareCode = "";

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/Email/).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/(student|lecturer)\//, { timeout: 30_000 });
}

test.describe.configure({ mode: "serial" });

test("creator lifecycle — create, build, play own quiz", async ({ page }) => {
  await registerUser(page, CREATOR, "student", "");

  // Create the quiz shell.
  await page.goto("/student/my-quizzes");
  await page.getByRole("link", { name: /create quiz/i }).click();
  await page.getByLabel("Title").fill(QUIZ_TITLE);
  await page.getByRole("button", { name: /create quiz/i }).click();

  // Builder opens for the new quiz.
  await page.waitForURL(/\/student\/my-quizzes\/[^/]+\/edit/);

  // Add one MCQ.
  const optionInputs = page.locator("fieldset input[maxlength='500']");
  await optionInputs.nth(0).fill("Paris");
  await optionInputs.nth(1).fill("London");
  await page
    .getByRole("textbox", { name: /prompt/i })
    .fill("What is the capital of France?");
  await page.getByRole("radio").first().check(); // mark Paris correct
  await page.getByRole("button", { name: /add question/i }).click();
  await expect(page.getByText("What is the capital of France?")).toBeVisible();

  // Self-play from the editor's play link.
  await page.getByRole("link", { name: /open builder|play/i }).first().click();
  await page.waitForURL(/\/play\/student\//);
  await page.getByRole("button", { name: "London" }).click(); // wrong on purpose
  await expect(page.getByText(/not quite/i)).toBeVisible();
  await page.getByRole("button", { name: /^(next|see results)$/i }).click();
  await expect(page.getByText(/practice complete/i)).toBeVisible();
});

test("share flow — friend plays via link; login wall preserves it", async ({
  browser,
}) => {
  // Mint a code as the creator.
  const creatorCtx = await browser.newContext();
  const creator = await creatorCtx.newPage();
  await signIn(creator, CREATOR);
  await creator.goto("/student/my-quizzes");
  await creator.getByText(QUIZ_TITLE, { exact: true }).waitFor();
  await creator.getByRole("button", { name: /^share/i }).click();
  // The dialog shows the minted link once the PATCH resolves (stale-snapshot
  // regression would leave the "Preparing your link…" spinner up forever).
  const linkInput = creator.locator("input[readonly]");
  await expect(linkInput).toBeVisible({ timeout: 15_000 });
  const codeFromInput = await linkInput.inputValue();
  shareCode = codeFromInput.split("/s/")[1] ?? "";
  expect(shareCode).toMatch(CODE_REGEX);
  await creatorCtx.close();

  // Register the recipient FIRST (registration has no redirect-param support
  // and always lands on /student/classes), so the login-wall return path can
  // be exercised with real credentials below.
  const playerHomeCtx = await browser.newContext();
  const playerHome = await playerHomeCtx.newPage();
  await registerUser(playerHome, PLAYER, "student", "");
  await playerHomeCtx.close();

  // Logged-out recipient hits the login wall, signs in, and lands BACK on
  // the shared link (login page honors the sanitized redirect param).
  const anonCtx = await browser.newContext();
  const anon = await anonCtx.newPage();
  await anon.goto(`/s/${shareCode}`);
  await anon.waitForURL(/\/login\?redirect=/, { timeout: 15_000 });
  await anon.getByLabel(/Email/).fill(PLAYER);
  await anon.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await anon.getByRole("button", { name: /sign in/i }).click();
  await anon.waitForURL(new RegExp(`/s/${shareCode}`), { timeout: 30_000 });

  // Landing shows banner + metadata, then play through to the end screen.
  await expect(anon.getByText(/community-made practice content/i)).toBeVisible();
  await anon.getByRole("button", { name: /start practice/i }).click();
  await anon.getByRole("button", { name: "Paris" }).click(); // correct
  await expect(anon.getByText(/correct!/i)).toBeVisible();
  await anon.getByRole("button", { name: /^(next|see results)$/i }).click();
  await expect(anon.getByText(/practice complete/i)).toBeVisible();
  await anonCtx.close();
});

test("revocation — unshare kills the link; delete cascades", async ({ browser }) => {
  const ctx = await browser.newContext();
  const player = await ctx.newPage();
  await signIn(player, PLAYER);

  const creatorCtx = await browser.newContext();
  const creator = await creatorCtx.newPage();
  await signIn(creator, CREATOR);
  await creator.goto("/student/my-quizzes");
  await creator.getByText(QUIZ_TITLE, { exact: true }).waitFor();

  // Open the share dialog and stop sharing.
  await creator.getByRole("button", { name: /^share/i }).click();
  await creator.getByRole("button", { name: /stop sharing/i }).click();
  await expect(creator.getByText(/sharing stopped/i)).toBeVisible();

  // The player now gets the SAME neutral screen as an unknown code.
  await player.goto(`/s/${shareCode}`);
  await expect(
    player.getByText(/invalid or no longer available/i),
  ).toBeVisible({ timeout: 10_000 });

  // A syntactically invalid code renders the same neutral screen (literal
  // normalizeShareCode miss, no-oracle contract).
  await player.goto("/s/!!!");
  await expect(
    player.getByText(/invalid or no longer available/i),
  ).toBeVisible({ timeout: 10_000 });

  // Delete cascades — the quiz disappears from the dashboard.
  await creator.getByRole("dialog").getByRole("button", { name: /close|cancel|×/i }).click();
  const quizCard = creator.locator("li").filter({ hasText: QUIZ_TITLE });
  await quizCard.getByRole("button", { name: /^delete/i }).click();
  await creator.getByRole("dialog").getByRole("button", { name: /delete/i }).last().click();
  await expect(creator.getByText(QUIZ_TITLE, { exact: true })).toBeHidden({
    timeout: 10_000,
  });

  await creatorCtx.close();
  await ctx.close();
});
