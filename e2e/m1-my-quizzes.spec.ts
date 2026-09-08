import { test, expect } from "@playwright/test";
import { fastRegisterUser } from "./helpers";

/**
 * m1-my-quizzes — mobile-only spec for the redesigned My Practice Quizzes
 * surface (card-as-play, ⋯ action drawer, floating create button). Runs ONLY
 * in the `mobile` project (iPhone X descriptor, 375×812); the desktop
 * chromium project ignores m1-* specs.
 *
 * Contracts kept alive from the previous mobile rendering:
 *  - "Create quiz" accessible name (create flow, e17 parity)
 *  - share flow entry (⋯ → Share) with real PATCH share_code minting
 *  - Play/Edit still reachable in one tap (card tap / drawer)
 */

const UNIQUE = `m1mq-${Date.now()}`;
const QUIZ_TITLE = `MQ Practice ${UNIQUE}`;

test.describe("m1 — My Quizzes mobile redesign", () => {
  test("large title, card-as-play, FAB create; zero-question card routes to editor", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    const email = `${UNIQUE}-a@student.innovision.test`;
    await fastRegisterUser(page, email, "student", process.env.LECTURER_INVITE_CODE!);

    // Zero state first: dashed empty card owns the create CTA.
    await page.goto("/student/my-quizzes");
    await expect(page.getByRole("heading", { name: "My Quizzes" })).toBeVisible();
    await expect(page.getByText(/no quizzes yet/i)).toBeVisible();

    // Create via the empty-state CTA (keeps the "Create quiz" contract name).
    await page.getByRole("link", { name: /create quiz/i }).click();
    await page.getByLabel("Title").fill(QUIZ_TITLE);
    await page.getByRole("button", { name: /create quiz/i }).click();
    await page.waitForURL(/\/student\/my-quizzes\/[^/]+\/edit/);

    // No questions yet → back on the hub the card must say so and route to
    // the EDITOR when tapped (not the player).
    await page.goto("/student/my-quizzes");
    const zeroCard = page.getByRole("link", { name: new RegExp(`edit ${QUIZ_TITLE}`, "i") });
    await expect(zeroCard).toBeVisible();
    await expect(page.getByText(/no questions yet/i)).toBeVisible();

    // FAB is present on the hub with the create contract name.
    await expect(page.getByRole("link", { name: /^create quiz$/i })).toBeVisible();

    await zeroCard.click();
    await page.waitForURL(/\/student\/my-quizzes\/[^/]+\/edit/);
  });

  test("playable card plays in one tap; ⋯ drawer shares with a real minted link", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only");
    const email = `${UNIQUE}-b@student.innovision.test`;
    await fastRegisterUser(page, email, "student", process.env.LECTURER_INVITE_CODE!);

    // Create the shell through the UI (same flow as e17 desktop parity).
    await page.goto("/student/my-quizzes");
    await page.getByRole("link", { name: /create quiz/i }).click();
    await page.getByLabel("Title").fill(QUIZ_TITLE);
    await page.getByRole("button", { name: /create quiz/i }).click();
    await page.waitForURL(/\/student\/my-quizzes\/[^/]+\/edit/);

    // Add one MCQ via the editor.
    const optionInputs = page.locator("fieldset input[maxlength='500']");
    await optionInputs.nth(0).fill("Paris");
    await optionInputs.nth(1).fill("London");
    await page.getByRole("textbox", { name: /prompt/i }).fill("What is the capital of France?");
    await page.getByRole("radio").first().check();
    await page.getByRole("button", { name: /add this question/i }).click();
    await expect(page.getByText("What is the capital of France?")).toBeVisible();

    // Hub: card accessible name is now "Play …" and tapping it plays.
    await page.goto("/student/my-quizzes");
    const playCard = page.getByRole("link", { name: new RegExp(`play ${QUIZ_TITLE}`, "i") });
    await expect(playCard).toBeVisible();
    await playCard.click();
    await page.waitForURL(/\/play\/student\//);

    // Back to the hub; open the ⋯ drawer and share for real.
    await page.goto("/student/my-quizzes");
    await page.getByRole("button", { name: new RegExp(`more actions for ${QUIZ_TITLE}`, "i") }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    // Share action mints a code (PATCH) and reveals the link panel.
    // (The menu action's accessible name includes its sub-label, so the
    // regex is prefix-anchored rather than exact.)
    await drawer.getByRole("button", { name: /^share/i }).click();
    await expect(drawer.getByText(new RegExp(QUIZ_TITLE, "i"))).toBeVisible(); // shareTitle
    const linkInput = drawer.getByRole("textbox", { name: /copy link/i });
    await expect(linkInput).toBeVisible({ timeout: 10_000 });
    await expect(linkInput).toHaveValue(/\/s\/[A-Za-z0-9]+/);

    // Copy works — grant clipboard access first (mobile contexts deny it by
    // default, and writeText throws silently into our catch{}).
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    await drawer.getByRole("button", { name: /copy link/i }).last().click();
    await expect(page.getByText(/copied/i)).toBeVisible({ timeout: 10_000 });

    // Delete flow: menu → delete → confirm, with in-drawer warning.
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: new RegExp(`more actions for ${QUIZ_TITLE}`, "i") }).click();
    await drawer.getByRole("button", { name: /^delete/i }).click();
    await expect(drawer.getByText(/cannot be undone/i)).toBeVisible();
    // Cancel returns to the drawer's action menu — quiz untouched (still
    // deletable from there, proving no destructive action fired).
    await drawer.getByRole("button", { name: /^cancel$/i }).click();
    await expect(drawer.getByRole("button", { name: /^delete/i })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("link", { name: new RegExp(`play ${QUIZ_TITLE}`, "i") })).toBeVisible();
  });
});
