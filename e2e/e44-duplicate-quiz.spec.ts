import { test, expect } from "@playwright/test";
import { registerUser, createClass, createQuizWithQuestions } from "./helpers";

/**
 * E44 — AP-2 quiz duplication & copy-to-class (PLAN_R_AUTHORING_PRODUCTIVITY).
 *  - Duplicate within the class from the builder toolbar → a " (copy)" DRAFT
 *    appears in the same class with the questions carried over.
 *  - Copy-to-class from the class-detail row action → the copy lands in the
 *    chosen destination class.
 *  - Session/linkage state never carries: copies start as drafts.
 */

const stamp = Date.now();
const LECTURER_EMAIL = `lecturer-e44-${stamp}@innovision.test`;
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";

test.describe.configure({ mode: "serial" });

test.describe("E44 — duplicate quiz", () => {
  let page: import("@playwright/test").Page;

  test.beforeAll(async ({ browser }) => {
    test.skip(!INVITE, "LECTURER_INVITE_CODE not set");
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    await registerUser(page, LECTURER_EMAIL, "lecturer", INVITE);
    await createClass(page, "E44 Home");
    await createClass(page, "E44 Other");
  });

  test("duplicate within the class from the builder toolbar", async () => {
    await createQuizWithQuestions(page, {
      classTitle: "E44 Home",
      quizTitle: "E44 Sample",
      questions: [
        { prompt: "Which option?", options: ["Alpha", "Beta"], correctIndex: 1 },
        { type: "true_false", prompt: "Sky is blue.", options: ["True", "False"] },
      ],
    });

    // Stage an image on a third question (e20 lecturer pattern): the staged
    // upload fires after the question POST, so the source has a storage
    // object for the duplicate route's storage-copy phase to replicate.
    const form = page.locator("form").filter({
      has: page.getByRole("textbox", { name: "Question prompt" }),
    });
    await form.getByRole("textbox", { name: "Question prompt" }).fill("Imaged diagram?");
    await form.getByLabel("Option 1").fill("A");
    await form.getByLabel("Option 2").fill("B");
    const stagePost = page.waitForResponse(
      (r) =>
        /\/api\/quizzes\/[\w-]+\/questions\/[\w-]+\/image$/.test(r.url()) &&
        r.request().method() === "POST",
    );
    await form.getByTestId("question-image-input").setInputFiles("e2e/fixtures/tiny.png");
    await page.getByRole("button", { name: /add this question/i }).click();
    expect((await stagePost).status()).toBeLessThan(400);
    await expect(page.getByText("Imaged diagram?")).toBeVisible();

    // The toolbar Duplicate button's accessible name is its aria-label
    // ("Duplicate quiz {title}"), NOT the visible "Duplicate" text.
    await page.getByRole("button", { name: `Duplicate quiz E44 Sample`, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText('Create an editable draft copy of "E44 Sample"')).toBeVisible();
    // Destination defaults to the source's own class.
    await expect(dialog.getByLabel("Destination class")).toContainText("E44 Home");
    await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();
    await expect(page.getByText('Draft copy of "E44 Sample" created.')).toBeVisible();

    // Back to the class list — the copy is there, still a DRAFT. The builder
    // back link renders the CLASS TITLE as its accessible name.
    await page.getByRole("link", { name: "E44 Home", exact: true }).click();
    await expect(page.getByText("E44 Sample (copy)")).toBeVisible();
  });

  test("the copy carries the questions, its imaged question renders independently", async () => {
    await page.getByText("E44 Sample (copy)").click();
    await expect(page).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
    await expect(page.getByRole("heading", { name: "E44 Sample (copy)" })).toBeVisible();
    await expect(page.getByText("Which option?")).toBeVisible();
    await expect(page.getByText("Sky is blue.")).toBeVisible();
    // Fresh draft — publish is available again, no reveal/session state.
    await expect(page.getByRole("button", { name: /publish/i })).toBeVisible();

    // Storage replication: the copy's imaged question mints a signed URL
    // for its OWN object and renders — the storage.copy phase landed. This
    // is the only layer that exercises the real in-bucket copy end-to-end.
    const row = page.locator("li").filter({ hasText: "Imaged diagram?" });
    const mint = page.waitForResponse(
      (r) =>
        /\/api\/question-images\/[\w-]+$/.test(r.url()) &&
        r.request().method() === "GET",
    );
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    expect((await mint).status()).toBeLessThan(400);
    const img = page.getByRole("dialog").locator("img").first();
    await expect(img).toBeVisible();
    await expect
      .poll(async () => await img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0);
    await page.getByRole("dialog").getByRole("button", { name: /cancel/i }).click();
  });

  test("copy-to-class from the class-detail row action lands in the other class", async () => {
    // The serial page is on the E44 Sample (copy) builder — the row action
    // lives on the class detail page.
    await page.goto("/lecturer/classes");
    await page.getByText("E44 Home", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "E44 Home" })).toBeVisible();

    // Row-level duplicate icon button (sibling of the results link).
    await page.getByRole("button", { name: "Duplicate - E44 Sample", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Destination class").click();
    await page.getByRole("option", { name: "E44 Other" }).click();
    await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();
    await expect(page.getByText('Draft copy of "E44 Sample" created.')).toBeVisible();

    // Navigate to the destination class — the copy lives there now.
    await page.goto("/lecturer/classes");
    await page.getByText("E44 Other", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "E44 Other" })).toBeVisible();
    await expect(page.getByText("E44 Sample (copy)")).toBeVisible();
  });

  test("copy-to-class adds no second copy to the source class", async () => {
    await page.goto("/lecturer/classes");
    await page.getByText("E44 Home", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "E44 Home" })).toBeVisible();
    // Home already holds the in-class copy from test 1; the cross-class
    // duplicate in test 3 must NOT have added a second one here.
    await expect(page.getByText("E44 Sample", { exact: true })).toBeVisible();
    await expect(page.getByText("E44 Sample (copy)")).toHaveCount(1);
  });
});
