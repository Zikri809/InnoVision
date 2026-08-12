import { test, expect } from "@playwright/test";
import { registerUser, createClass, joinClass } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e5-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_A_EMAIL = `student-e5a-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_B_EMAIL = `student-e5b-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E5 Assessment";
const QUIZ_TITLE = "E5 One Attempt";

/**
 * E5 (Phase 5 scope) — Assessment one-attempt lock.
 *
 * Verifies:
 *  1. Lecturer creates an UNTIMED assessment quiz (so it can't race the client
 *     auto-submit), publishes.
 *  2. Student A starts, answers, submits.
 *  3. Student A clicks Start again â†’ clean "already taken" message, no 500.
 *  4. Student B (same class) can still start — one-attempt is per student.
 */

test.describe("E5 — assessment one-attempt lock", () => {
  test("a completed assessment cannot be restarted; another student can start", async ({
    browser,
  }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentACtx = await browser.newContext();
    const studentBCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentAPage = await studentACtx.newPage();
    const studentBPage = await studentBCtx.newPage();

    // â”€â”€ 1. Lecturer: class + UNTIMED assessment + publish â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();

    const joinCode = await createClass(lecturerPage, CLASS_TITLE);

    // Create the quiz as ASSESSMENT. The class-detail create form has a Mode
    // select — switch it to Assessment.
    await lecturerPage.getByText(CLASS_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByLabel("Quiz title").fill(QUIZ_TITLE);
    await lecturerPage.getByLabel("Mode").click();
    await lecturerPage.getByRole("option", { name: "Assessment" }).click();
    await lecturerPage.getByRole("button", { name: /new quiz/i }).click();
    await expect(lecturerPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await lecturerPage.getByText(QUIZ_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    // Add 2 questions.
    await lecturerPage.getByRole("textbox", { name: "Question" }).fill("What is 2+2?");
    await lecturerPage.getByLabel("Option 1").fill("3");
    await lecturerPage.getByLabel("Option 2").fill("4");
    await lecturerPage.getByRole("button", { name: /add question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question" })).toHaveValue("");

    await lecturerPage.getByRole("textbox", { name: "Question" }).fill("Capital of France?");
    await lecturerPage.getByLabel("Option 1").fill("Paris");
    await lecturerPage.getByLabel("Option 2").fill("London");
    await lecturerPage.getByRole("button", { name: /add question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question" })).toHaveValue("");

    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/published/i)).toBeVisible();

    // â”€â”€ 2. Student A: register + join + start + answer + submit â”€â”€
    await registerUser(studentAPage, STUDENT_A_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentAPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentAPage, joinCode, CLASS_TITLE);
    await studentAPage.getByRole("link", { name: /available quizzes/i }).click();
    await expect(studentAPage).toHaveURL(/\/student\/quizzes/);
    await studentAPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentAPage).toHaveURL(/\/play\/[0-9a-f-]+/);

    await expect(studentAPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await studentAPage.getByRole("button", { name: /4/i }).click();
    await expect(studentAPage.getByText("Answered", { exact: true })).toBeVisible();
    await studentAPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentAPage.getByText("Capital of France?", { exact: true })).toBeVisible();
    await studentAPage.getByRole("button", { name: /Paris/i }).click();
    await expect(studentAPage.getByText("Answered", { exact: true })).toBeVisible();
    await studentAPage.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(studentAPage.getByText("Your score", { exact: true })).toBeVisible({ timeout: 10_000 });

    // â”€â”€ 3. Student A clicks Start again â†’ clean already-taken â”€â”€â”€â”€â”€
    await studentAPage.getByRole("button", { name: "Back to quizzes" }).click();
    await expect(studentAPage).toHaveURL(/\/student\/quizzes/);
    await studentAPage.getByRole("button", { name: "Start", exact: true }).click();
    // The play page for the completed session renders the EndScreen's clean
    // "already taken" message (no 500).
    await expect(studentAPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await expect(studentAPage.getByText("Your score", { exact: true })).toBeVisible();
    await expect(
      studentAPage.getByText("It can only be taken once", { exact: false }),
    ).toBeVisible();

    // â”€â”€ 4. Student B can still start (one-attempt is per student) â”€
    await registerUser(studentBPage, STUDENT_B_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentBPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentBPage, joinCode, CLASS_TITLE);
    await studentBPage.getByRole("link", { name: /available quizzes/i }).click();
    await expect(studentBPage).toHaveURL(/\/student\/quizzes/);
    await studentBPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentBPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await expect(studentBPage.getByText("What is 2+2?", { exact: true })).toBeVisible();

    await lecturerCtx.close();
    await studentACtx.close();
    await studentBCtx.close();
  });
});
