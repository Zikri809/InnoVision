import { test, expect } from "@playwright/test";
import { registerUser, E2E_PASSWORD } from "./helpers";

const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

/**
 * E20 — Question images end-to-end (plan F2).
 * Test 1: student stages ONE image in the add-question dropzone (route-
 * mediated upload happens after question creation), sees the local preview,
 * and the image renders in self-play.
 * Test 2: a shared-code player's run renders the same image; unshare kills
 * new mints (covered upstream by scripts/verify-media.mjs MEDIA-D2 for the
 * assessment matrix — this spec pins the RENDERING path).
 * Test 3: staged-field interactions the happy path skips — filechooser click
 * wiring, client validation (.pdf / >5 MB), drag & drop, remove-before-submit.
 * Test 4: image POST failure AFTER question creation → question survives,
 * toast shown, staged file cleared (never leaks to the next question).
 * Test 5: committed mode in the student edit dialog — signed-URL preview,
 * immediate Replace commit + badge sync, Remove, cache-invalidation on reopen.
 * Test 6: the lecturer EditQuestionDialog (separate component) — staged add,
 * Replace, Remove, badge + remint assertions. Skipped without invite code.
 */

const stamp = Date.now();
const AUTHOR = `img-stu-${stamp}1@e2e.test`;
const PLAYER = `img-player-${stamp}2@e2e.test`;
const LECTURER = `img-lect-${stamp}3@e2e.test`;
const QUIZ_TITLE = `Image Practice ${stamp}`;
const QUESTION_PROMPT = "Which shape is the circle?";
const LECTURER_PROMPT = "Lecturer image probe question?";
const EDITED_PROMPT = "Which shape is the circle, revised?";

test.describe.configure({ mode: "serial" });

let shareCode = "";

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/Email/).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/(student|lecturer)\//, { timeout: 30_000 });
}

/** The add-question form's hidden file input, scoped by region (the edit
 * dialog mounts a SECOND identical input whenever it is open). */
function addFormImageInput(page: import("@playwright/test").Page) {
  return page
    .locator("form")
    .filter({ has: page.getByRole("textbox", { name: /prompt/i }) })
    .getByTestId("question-image-input");
}

async function createQuizWithQuestion(
  page: import("@playwright/test").Page,
  title: string,
  prompt: string,
) {
  await page.goto("/student/my-quizzes");
  await page.getByRole("link", { name: /create quiz/i }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: /create quiz/i }).click();
  await page.waitForURL(/\/student\/my-quizzes\/[^/]+\/edit/);
  const optionInputs = page.locator("fieldset input[maxlength='500']");
  await optionInputs.nth(0).fill("Square");
  await optionInputs.nth(1).fill("Circle");
  await page.getByRole("textbox", { name: /prompt/i }).fill(prompt);
  await page.getByRole("radio").nth(1).check(); // Circle correct
}

test("stage image in the add-question dropzone → renders in self-play", async ({ page }) => {
  await registerUser(page, AUTHOR, "student", "");
  await createQuizWithQuestion(page, QUIZ_TITLE, QUESTION_PROMPT);

  // Stage via the form-scoped hidden input.
  await addFormImageInput(page).setInputFiles("e2e/fixtures/tiny.png");
  // Local object-URL preview appears instantly (no network involved).
  await expect(page.locator('img[src^="blob:"]')).toBeVisible();

  const imgPost = page.waitForResponse(
    (r) =>
      /\/api\/student-quizzes\/[\w-]+\/questions\/[\w-]+\/image$/.test(r.url()) &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: /add this question/i }).click();

  // The multipart image POST must land BEFORE navigating away to play — and
  // must have succeeded (a 5xx would otherwise surface as a cryptic
  // naturalWidth timeout later).
  expect((await imgPost).status()).toBeLessThan(400);
  await expect(page.getByText(QUESTION_PROMPT)).toBeVisible();

  // Self-play renders the image above the options.
  await page.getByRole("link", { name: /preview quiz|play/i }).first().click();
  await page.waitForURL(/\/play\/student\//);
  const img = page.locator("img[decoding='async']").first();
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await img.evaluate((el: HTMLImageElement) => el.naturalWidth))).toBeGreaterThan(0);

  // Answer to reach the feedback flow without image interference.
  await page.getByRole("button", { name: "Circle" }).click();
  await expect(page.getByText(/correct!/i)).toBeVisible();
});

test("staged field interactions: validation, drag & drop, remove before submit", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, AUTHOR);
  await createQuizWithQuestion(
    page,
    `Interactions ${stamp}`,
    "Interaction probe question?",
  );
  const zone = page.getByRole("button", { name: /question image \(optional\)/i });
  await expect(zone).toBeVisible();

  // (a) CLICK path — the wiring setInputFiles bypasses. A rejected type must
  // surface inline and stage NOTHING.
  const fc = page.waitForEvent("filechooser");
  await zone.click();
  await (await fc).setFiles({
    name: "doc.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 test"),
  });
  // NOTE: page.getByRole("alert") is ambiguous here — Next.js mounts a
  // global route announcer with role="alert". Assert on the field's copy.
  await expect(page.getByText(/only png, jpeg or webp/i)).toBeVisible();
  await expect(page.locator('img[src^="blob:"]')).toHaveCount(0);

  // (b) Over-cap size rejected too.
  const fc2 = page.waitForEvent("filechooser");
  await zone.click();
  await (await fc2).setFiles({
    name: "big.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  await expect(page.getByText(/exceeds the 5 mb limit/i)).toBeVisible();

  // (c) Drag & drop stages the file (preview rides a blob URL).
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    // Minimal PNG signature is enough — nothing is uploaded here.
    d.items.add(
      new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", {
        type: "image/png",
      }),
    );
    return d;
  });
  await zone.dispatchEvent("drop", { dataTransfer: dt });
  await expect(page.locator('img[src^="blob:"]')).toBeVisible();

  // (d) Remove staged BEFORE submit → dropzone back, no blob left behind
  // (nothing can leak onto the NEXT question).
  await page.getByRole("button", { name: /remove question image/i }).click();
  await expect(zone).toBeVisible();
  await expect(page.locator('img[src^="blob:"]')).toHaveCount(0);
  await ctx.close();
});

test("image POST failure after create: question kept, toast shown, stage cleared", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, AUTHOR);
  await createQuizWithQuestion(
    page,
    `Failure path ${stamp}`,
    "Survives a failed upload?",
  );
  await page.route(/\/api\/student-quizzes\/[\w-]+\/questions\/[\w-]+\/image$/, (r) =>
    r.fulfill({ status: 500, body: "{}" }),
  );
  await addFormImageInput(page).setInputFiles("e2e/fixtures/tiny.png");
  await expect(page.locator('img[src^="blob:"]')).toBeVisible();

  await page.getByRole("button", { name: /add this question/i }).click();
  await expect(page.getByText(/question added, but the image could not be uploaded/i)).toBeVisible();
  await expect(page.getByText("Survives a failed upload?")).toBeVisible(); // question KEPT
  // Stage CLEARED — the dropzone is back so the file cannot silently attach
  // to the next question created in this form.
  await expect(page.getByRole("button", { name: /question image \(optional\)/i })).toBeVisible();
  await expect(page.locator('img[src^="blob:"]')).toHaveCount(0);
  await ctx.close();
});

test("share-code player also sees the image; unshare kills new mints", async ({ browser }) => {
  // Creator shares.
  const creatorCtx = await browser.newContext();
  const creator = await creatorCtx.newPage();
  await signIn(creator, AUTHOR);
  await creator.goto("/student/my-quizzes");
  await creator.getByText(QUIZ_TITLE, { exact: true }).waitFor();
  // Scope to THIS quiz's row — earlier tests in this serial suite create
  // additional quizzes that also render Share buttons.
  const creatorRow = creator.locator("li").filter({ hasText: QUIZ_TITLE });
  await creatorRow.getByRole("button", { name: /^share/i }).click();
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

test("committed mode in edit dialog: preview → replace → remove → reopen clean", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, AUTHOR);
  await page.goto("/student/my-quizzes");
  await page.getByText(QUIZ_TITLE, { exact: true }).waitFor();

  // Open the editor for the quiz created in test 1 (its question HAS an
  // image). Register the mint listener BEFORE clicking — the GET fires the
  // moment the dialog mounts its preview.
  const row = page.locator("li").filter({ hasText: QUIZ_TITLE });
  await row.getByRole("link", { name: /^edit$/i }).click();
  await page.waitForURL(/\/student\/my-quizzes\/[^/]+\/edit/);

  const minted = page.waitForResponse(
    (r) =>
      /\/api\/question-images\/[\w-]+$/.test(r.url()) &&
      r.request().method() === "GET",
  );
  const card = page.locator("li").filter({ hasText: QUESTION_PROMPT });
  await card.getByRole("button", { name: /edit question/i }).click();
  const dialog = page.getByRole("dialog");

  // Signed-URL mint + preview render inside the dialog.
  expect((await minted).status()).toBeLessThan(400);
  await expect(dialog.locator("img").first()).toBeVisible();

  // Replace commits IMMEDIATELY (independent of the text Save button), then
  // the hook refetches a FRESH signed URL — proving cache invalidation works
  // (a stale cache would keep rendering the old image).
  const replacePost = page.waitForResponse(
    (r) =>
      /\/api\/student-quizzes\/[\w-]+\/questions\/[\w-]+\/image$/.test(r.url()) &&
      r.request().method() === "POST",
  );
  const remint = page.waitForResponse(
    (r) =>
      /\/api\/question-images\/[\w-]+$/.test(r.url()) &&
      r.request().method() === "GET",
  );
  await dialog.getByTestId("question-image-input").setInputFiles("e2e/fixtures/scanned-chapter.png");
  expect((await replacePost).status()).toBeLessThan(400);
  expect((await remint).status()).toBeLessThan(400); // invalidation refetch
  await expect(card.getByText("Image", { exact: true })).toBeVisible(); // badge synced

  // Remove clears badge AND the dialog preview.
  const del = page.waitForResponse(
    (r) =>
      /\/api\/student-quizzes\/[\w-]+\/questions\/[\w-]+\/image$/.test(r.url()) &&
      r.request().method() === "DELETE",
  );
  await dialog.getByRole("button", { name: /remove question image/i }).click();
  expect((await del).status()).toBeLessThan(400);
  await expect(card.getByText("Image", { exact: true })).toHaveCount(0);

  // Reopen: seeds from the LIVE flag — dropzone shows, NO stale preview.
  await dialog.getByRole("button", { name: /cancel/i }).click();
  await card.getByRole("button", { name: /edit question/i }).click();
  await expect(page.getByRole("dialog").locator("img")).toHaveCount(0);
  await expect(
    page.getByRole("dialog").getByTestId("question-image-input"),
  ).toBeAttached();
  await ctx.close();
});

test("student edit-question dialog: cancel discards, save persists", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, AUTHOR);

  // Open the editor for the quiz from test 1 (prompt intact — test 5 only
  // touched its image).
  await page.goto("/student/my-quizzes");
  const row = page.locator("li").filter({ hasText: QUIZ_TITLE });
  await row.getByRole("link", { name: /^edit$/i }).click();
  await page.waitForURL(/\/student\/my-quizzes\/[^/]+\/edit/);
  const card = page.locator("li").filter({ hasText: QUESTION_PROMPT });

  // (a) CANCEL discards: type a new prompt, cancel, original stays.
  await card.getByRole("button", { name: /edit question/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Prompt").fill("This edit must be discarded?");
  await dialog.getByRole("button", { name: /cancel/i }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(QUESTION_PROMPT)).toBeVisible();

  // (b) SAVE persists: reopen, change the prompt, save.
  await card.getByRole("button", { name: /edit question/i }).click();
  await dialog.getByLabel("Prompt").fill(EDITED_PROMPT);
  await dialog.getByRole("button", { name: /save question/i }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(EDITED_PROMPT)).toBeVisible();

  // Persistence: the PATCH wrote through to the server.
  await page.reload();
  await expect(page.getByText(EDITED_PROMPT)).toBeVisible();
  await expect(page.getByText(QUESTION_PROMPT)).toHaveCount(0);
  await ctx.close();
});

test("lecturer EditQuestionDialog: replace → remove image (draft)", async ({ browser }) => {
  // The lecturer dialog is a SEPARATE component from the student inline
  // dialog above — its image wiring needs its own pass. Requires an invite
  // code (same prerequisite as E1b/E2).
  test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await registerUser(page, LECTURER, "lecturer", LECTURER_INVITE_CODE);

  // Class → quiz → builder.
  await page.getByLabel("Class title").fill(`Image Lecturer ${stamp}`);
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page.getByText(`Image Lecturer ${stamp}`, { exact: true })).toBeVisible();
  await page.getByText(`Image Lecturer ${stamp}`, { exact: true }).click();
  await page.getByLabel("Quiz title").fill(`Lecturer Images ${stamp}`);
  await page.getByRole("button", { name: /create quiz|new quiz/i }).click();
  await page.getByText(`Lecturer Images ${stamp}`, { exact: true }).click();
  await page.waitForURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

  // Add an imaged question (staged upload fires after the question POST).
  const lecturerForm = page.locator("form").filter({
    has: page.getByRole("textbox", { name: "Question prompt" }),
  });
  await lecturerForm.getByRole("textbox", { name: "Question prompt" }).fill(LECTURER_PROMPT);
  await lecturerForm.getByLabel("Option 1").fill("Alpha");
  await lecturerForm.getByLabel("Option 2").fill("Beta");
  const lecturerInput = lecturerForm.getByTestId("question-image-input");
  const stagePost = page.waitForResponse(
    (r) =>
      /\/api\/quizzes\/[\w-]+\/questions\/[\w-]+\/image$/.test(r.url()) &&
      r.request().method() === "POST",
  );
  await lecturerInput.setInputFiles("e2e/fixtures/tiny.png");
  await page.getByRole("button", { name: /add this question/i }).click();
  expect((await stagePost).status()).toBeLessThan(400);

  // Open the edit dialog — signed-URL mint proves committed-mode seeding.
  const mint = page.waitForResponse(
    (r) =>
      /\/api\/question-images\/[\w-]+$/.test(r.url()) &&
      r.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  expect((await mint).status()).toBeLessThan(400);
  await expect(dialog.locator("img").first()).toBeVisible();

  // Replace commits immediately + remints a fresh URL.
  const replacePost = page.waitForResponse(
    (r) =>
      /\/api\/quizzes\/[\w-]+\/questions\/[\w-]+\/image$/.test(r.url()) &&
      r.request().method() === "POST",
  );
  const remint = page.waitForResponse(
    (r) =>
      /\/api\/question-images\/[\w-]+$/.test(r.url()) &&
      r.request().method() === "GET",
  );
  await dialog.getByTestId("question-image-input").setInputFiles("e2e/fixtures/scanned-chapter.png");
  expect((await replacePost).status()).toBeLessThan(400);
  expect((await remint).status()).toBeLessThan(400);

  // Remove → badge gone; reopen shows the clean dropzone.
  const del = page.waitForResponse(
    (r) =>
      /\/api\/quizzes\/[\w-]+\/questions\/[\w-]+\/image$/.test(r.url()) &&
      r.request().method() === "DELETE",
  );
  await dialog.getByRole("button", { name: /remove question image/i }).click();
  expect((await del).status()).toBeLessThan(400);
  const row = page.locator("li").filter({ hasText: LECTURER_PROMPT });
  await expect(row.getByText("Image", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: /cancel/i }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("dialog").locator("img")).toHaveCount(0);
  await ctx.close();
});
