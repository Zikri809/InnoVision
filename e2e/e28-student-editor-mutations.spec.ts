import { test, expect } from "@playwright/test";
import { registerUser, createClass, createQuizWithQuestions, E2E_PASSWORD } from "./helpers";

/**
 * E28 — Student quiz editor mutations (HIGH #6 remainder).
 * Serial tests; each operation is an IMMEDIATE API call (no save-all diffing)
 * that must survive a full reload:
 *   1. Reorder: "Move option up/down" swaps card order and persists.
 *   2. Delete: native confirm "Delete this question?" removes the card
 *      persistently.
 *   3. Option surgery in the edit dialog: set correct=opt2, add opt3, remove
 *      opt1 → the key CLAMPS to the old opt2 (shared applyOptionDraftOp).
 *   4. Lecturer parity smoke: the shared reducer refactor's OTHER caller
 *      (EditQuestionDialog) still clamps the key the same way.
 */

const stamp = Date.now();
const CREATOR = `e28-creator-${stamp}@e2e.test`;
const LECTURER = `e28-lec-${stamp}@e2e.test`;
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";

test.describe.configure({ mode: "serial" });

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/Email/).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/(student|lecturer)\//, { timeout: 30_000 });
}

async function createQuiz(page: import("@playwright/test").Page, title: string) {
  await page.goto("/student/my-quizzes");
  await page.getByRole("link", { name: /create quiz/i }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: /create quiz/i }).click();
  await page.waitForURL(/\/student\/my-quizzes\/[^/]+\/edit/);
}

async function addQuestion(
  page: import("@playwright/test").Page,
  prompt: string,
  optA: string,
  optB: string,
) {
  const optionInputs = page.locator("fieldset input[maxlength='500']");
  await optionInputs.nth(0).fill(optA);
  await optionInputs.nth(1).fill(optB);
  await page.getByRole("textbox", { name: /prompt/i }).fill(prompt);
  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: /add this question/i }).click();
  await expect(page.getByText(prompt, { exact: true })).toBeVisible();
}

test("reorder persists after reload", async ({ page }) => {
  await registerUser(page, CREATOR, "student", "");
  await createQuiz(page, `E28 Reorder ${stamp}`);

  await addQuestion(page, "Q-one alpha?", "a1", "a2");
  await addQuestion(page, "Q-two beta?", "b1", "b2");
  await addQuestion(page, "Q-three gamma?", "c1", "c2");

  const cards = () => page.locator("ol > li");
  await expect(cards().first()).toContainText("Q-one alpha?");

  // Move Q-two up → [beta, alpha, gamma].
  const qTwo = page.locator("li").filter({ hasText: "Q-two beta?" });
  await qTwo.getByRole("button", { name: "Move option up", exact: true }).click();
  await expect(cards().first()).toContainText("Q-two beta?");
  await expect(cards().nth(1)).toContainText("Q-one alpha?");

  // Persisted across a reload.
  await page.reload();
  await expect(cards().first()).toContainText("Q-two beta?");

  // End-guards: first card cannot move up, last cannot move down.
  await expect(cards().first().getByRole("button", { name: "Move option up", exact: true })).toBeDisabled();
  await expect(cards().last().getByRole("button", { name: "Move option down", exact: true })).toBeDisabled();
});

test("delete confirms natively and persists", async ({ page }) => {
  await signIn(page, CREATOR);
  await createQuiz(page, `E28 Delete ${stamp}`);
  await addQuestion(page, "Delete me?", "x1", "x2");

  await page
    .locator("li")
    .filter({ hasText: "Delete me?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Confirm", exact: true }).click();

  await expect(page.getByText("Delete me?", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Delete me?", { exact: true })).toHaveCount(0);
});

test("edit-dialog option surgery clamps the key to the surviving option", async ({
  page,
}) => {
  await signIn(page, CREATOR);
  await createQuiz(page, `E28 Options ${stamp}`);
  await addQuestion(page, "Pick one?", "Aa", "Bb");

  const row = page.locator("li").filter({ hasText: "Pick one?" });
  await row.getByRole("button", { name: "Edit question", exact: true }).click();
  const dialog = page.getByRole("dialog");

  // Mark option 2 correct → add a third → delete option 1. The key must clamp
  // to old option 2 (Bb) — it can never point at a missing option.
  await dialog.getByRole("radio", { name: "Mark the correct answer: Bb" }).check();
  await dialog.getByRole("button", { name: "Add option", exact: true }).click();
  const optionsFieldset = dialog.locator("fieldset");
  await optionsFieldset.getByRole("textbox").nth(2).fill("Cc");
  await dialog.getByRole("button", { name: "Remove option 1", exact: true }).click();

  await dialog.getByRole("button", { name: "Save question", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  // Options are now [Bb, Cc]; the marked answer is Bb.
  const savedRow = page.locator("li").filter({ hasText: "Pick one?" });
  await expect(savedRow.getByText("Bb", { exact: true })).toBeVisible();
  await expect(savedRow.getByText("Aa", { exact: true })).toHaveCount(0);

  await page.reload();
  const reloadedRow = page.locator("li").filter({ hasText: "Pick one?" });
  await expect(reloadedRow.getByText("Bb", { exact: true })).toBeVisible();
  await expect(reloadedRow.getByText("Aa", { exact: true })).toHaveCount(0);
});

test("lecturer EditQuestionDialog parity — shared reducer clamps identically", async ({
  page,
}) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");
  await registerUser(page, LECTURER, "lecturer", INVITE);
  await createClass(page, `E28 Parity ${stamp}`);
  await createQuizWithQuestions(page, {
    classTitle: `E28 Parity ${stamp}`,
    quizTitle: `E28 Parity Quiz ${stamp}`,
    questions: [{ prompt: "Parity pick?", options: ["Aa", "Bb"] }],
  });

  const row = page.locator("li").filter({ hasText: "Parity pick?" });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");

  await dialog.getByRole("combobox", { name: "Correct answer" }).click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "Add option", exact: true }).click();
  await dialog.getByLabel("Option 3").fill("Cc");
  await dialog.getByRole("button", { name: "Delete 1", exact: true }).click();
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  // Key clamped to old option 2 (Bb) — now "Option 1", options "Bb · Cc".
  await expect(row.getByText(/Correct answer: Option 1/)).toBeVisible();
  await expect(row.getByText(/Bb · Cc/)).toBeVisible();
});
