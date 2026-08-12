import { type Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const E2E_PASSWORD = "testpass123";

/**
 * Register a user via the UI (role radio + consent checkbox + lecturer invite
 * code when applicable), then wait for the role-based landing page.
 */
export async function registerUser(
  page: Page,
  email: string,
  role: "lecturer" | "student",
  inviteCode: string,
) {
  await page.goto("/register");
  await page.getByLabel("Full name (optional)").fill(`${role}-${email.split("@")[0]}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);

  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  await page.getByRole("radio", { name: roleLabel }).check();

  if (role === "lecturer") {
    await page.getByLabel("Lecturer invite code").fill(inviteCode);
  }

  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /register/i }).click();

  // Wait for the role-based landing page (also settles the hydration race).
  await page.waitForURL(
    role === "lecturer" ? /\/lecturer\/classes/ : /\/student\/classes/,
    { timeout: 15_000 },
  );
}

/**
 * Lecturer: create a class and return its join code (captured from the card).
 * Assumes the lecturer is already on /lecturer/classes.
 */
export async function createClass(page: Page, title: string): Promise<string> {
  await page.getByLabel("Class title").fill(title);
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  const joinCode = await page
    .getByText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
    .first()
    .textContent();
  expect(joinCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  return joinCode!;
}

/**
 * Student: join a class by code and confirm it appears in the class list.
 * Assumes the student is already on /student/classes.
 */
export async function joinClass(page: Page, joinCode: string, classTitle: string) {
  await page.getByLabel("Join code").fill(joinCode);
  await page.getByRole("button", { name: /join/i }).click();
  await expect(page.getByText(classTitle, { exact: true })).toBeVisible();
}

type QuestionInput = {
  type?: "mcq" | "true_false";
  prompt: string;
  options: string[];
  correctIndex?: number;
  explanation?: string;
};

/**
 * Lecturer: open a class, create a quiz, open the builder, and add questions
 * by hand. Returns nothing (the builder is left open on the quiz).
 *
 * Extracted from the inlined E1b/E2 patterns so E4/E5/E10/E11 reuse it
 * (deliberate refactor to cut duplication).
 */
export async function createQuizWithQuestions(
  page: Page,
  opts: {
    classTitle: string;
    quizTitle: string;
    questions: QuestionInput[];
    publish?: boolean;
  },
) {
  // Open the class.
  await page.getByText(opts.classTitle, { exact: true }).click();
  await expect(page).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
  await expect(page.getByRole("heading", { name: opts.classTitle })).toBeVisible();

  // Create the quiz.
  await page.getByLabel("Quiz title").fill(opts.quizTitle);
  await page.getByRole("button", { name: /new quiz/i }).click();
  await expect(page.getByText(opts.quizTitle, { exact: true })).toBeVisible();
  await page.getByText(opts.quizTitle, { exact: true }).click();
  await expect(page).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
  await expect(page.getByRole("heading", { name: opts.quizTitle })).toBeVisible();

  // Add each question.
  for (const q of opts.questions) {
    if (q.type === "true_false") {
      await page.getByLabel("Type").click();
      await page.getByRole("option", { name: "True / False" }).click();
    }
    await page.getByRole("textbox", { name: "Question" }).fill(q.prompt);

    // Fill options 1..N, adding extra option inputs as needed. True/False
    // options are disabled (auto-filled True/False) — skip filling them.
    if (q.type !== "true_false") {
      await page.getByLabel("Option 1").fill(q.options[0] ?? "");
      if (q.options.length >= 2) await page.getByLabel("Option 2").fill(q.options[1] ?? "");
      for (let i = 2; i < q.options.length; i++) {
        await page.getByRole("button", { name: /add option/i }).click();
        await page.getByRole("textbox", { name: `Option ${i + 1}` }).fill(q.options[i]);
      }
    }

    // Set the correct answer (defaults to option 1).
    if (q.correctIndex !== undefined && q.correctIndex !== 0 && q.type !== "true_false") {
      await page.getByLabel("Correct answer").click();
      await page.getByRole("option", { name: String(q.correctIndex + 1) }).click();
    }

    // Optional explanation (practice disclosure assertions).
    if (q.explanation) {
      await page.getByLabel("Explanation (optional)").fill(q.explanation);
    }

    await page.getByRole("button", { name: /add question/i }).click();
    // The save completes when the form resets (Question field cleared).
    await expect(page.getByRole("textbox", { name: "Question" })).toHaveValue("");
    await expect(page.getByText(q.prompt, { exact: true })).toBeVisible();
  }

  if (opts.publish) {
    const publishButton = page.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(page.getByText(/published/i)).toBeVisible();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
  }
}
