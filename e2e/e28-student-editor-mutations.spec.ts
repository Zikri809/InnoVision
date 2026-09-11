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
  // Rebuilt add form (lecturer parity): no fieldset wrapper and no radios —
  // options are aria-labelled inputs and the correct key defaults to Option 1.
  const promptBox = page.getByRole("textbox", { name: /prompt/i });
  await page.getByLabel("Option 1", { exact: true }).fill(optA);
  await page.getByLabel("Option 2", { exact: true }).fill(optB);
  await promptBox.fill(prompt);
  await page.getByRole("button", { name: /add this question/i }).click();
  // The form resets (emptyDraft) AFTER the POST resolves — a bare
  // getByText(prompt) matches the still-filled textarea and races the reset,
  // which wipes the NEXT call's fills. Wait for the reset first, then the row.
  await expect(promptBox).toHaveValue("");
  await expect(
    page.locator("li:has(> article)").filter({ hasText: prompt }),
  ).toBeVisible();
}

test("reorder persists after reload", async ({ page }) => {
  await registerUser(page, CREATOR, "student", "");
  await createQuiz(page, `E28 Reorder ${stamp}`);

  await addQuestion(page, "Q-one alpha?", "a1", "a2");
  await addQuestion(page, "Q-two beta?", "b1", "b2");
  await addQuestion(page, "Q-three gamma?", "c1", "c2");

  // Rebuilt desktop row = article inside li, with a quiet action gutter
  // (tooltip icon buttons aria-labelled "Move option up"/"Move option down").
  // Scope to TOP-LEVEL question rows only — each row's option list is ALSO
  // a ul > li (nested inside the question li).
  const cards = () => page.locator("li:has(> article)");
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

  // Key clamped to old option 2 (Bb) — now option A (with Check icon), options "Bb" and "Cc".
  const optionA = row.locator("li").filter({ hasText: "Bb" });
  await expect(optionA).toBeVisible();
  await expect(optionA.locator("svg")).toBeVisible();
  await expect(row.locator("li").filter({ hasText: "Cc" })).toBeVisible();
});
