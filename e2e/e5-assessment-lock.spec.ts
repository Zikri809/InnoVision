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
 *  3. Student A's completed card is LOCKED: "Completed" button disabled +
 *     awaiting-results chip (one-attempt enforced in the UI).
 *  4. Student B (same class) can still start — one-attempt is per student.
 */

test.describe("E5 — assessment one-attempt lock", () => {
  test("a completed assessment cannot be restarted; another student can start", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
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
    await lecturerPage.getByRole("button", { name: /create quiz|new quiz/i }).click();
    await expect(lecturerPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await lecturerPage.getByText(QUIZ_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    // Add 2 questions.
    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("What is 2+2?");
    await lecturerPage.getByLabel("Option 1").fill("3");
    await lecturerPage.getByLabel("Option 2").fill("4");
    await lecturerPage.getByRole("button", { name: /add this question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");

    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("Capital of France?");
    await lecturerPage.getByLabel("Option 1").fill("Paris");
    await lecturerPage.getByLabel("Option 2").fill("London");
    await lecturerPage.getByRole("button", { name: /add this question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");

    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/^Live/)).toBeVisible();

    // â”€â”€ 2. Student A: register + join + start + answer + submit â”€â”€
    await registerUser(studentAPage, STUDENT_A_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentAPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentAPage, joinCode, CLASS_TITLE);
    await studentAPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentAPage).toHaveURL(/\/student\/quizzes/);
    await studentAPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentAPage).toHaveURL(/\/play\/[0-9a-f-]+/);

    await expect(studentAPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await studentAPage.getByRole("button", { name: /4/i }).click();
    await expect(studentAPage.getByRole("button", { name: /^(Next|Finish)$/, exact: true })).toBeVisible();
    await studentAPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentAPage.getByText("Capital of France?", { exact: true })).toBeVisible();
    await studentAPage.getByRole("button", { name: /Paris/i }).click();
    await expect(studentAPage.getByRole("button", { name: /^(Next|Finish)$/, exact: true })).toBeVisible();
    await studentAPage.getByRole("button", { name: "Finish", exact: true }).click();
    // Results are reveal-gated: until the lecturer reveals, the assessment end
    // screen shows the "submitted" pending state — NOT a score (E5's scope is
    // the one-attempt lock, not the reveal flow, which E14/E15 own).
    await expect(
      studentAPage.getByText("results will be released by your lecturer", { exact: false }),
    ).toBeVisible();

    // â”€â”€ 3. Completed attempt blocks restart (locked card) â”€â”€â”€â”€â”€
    await studentAPage.getByRole("button", { name: "Back to quizzes" }).click();
    await expect(studentAPage).toHaveURL(/\/student\/quizzes/);
    // The completed card renders a single DISABLED "Awaiting results" button
    // (no Start at all; the awaiting state is merged into the button) — the
    // one-attempt lock is enforced in the UI itself, so the legacy Start →
    // 409 already_attempted redirect journey is unreachable by clicking.
    // The 409 contract stays covered server-side.
    const completedCard = studentAPage.locator("li").filter({ hasText: QUIZ_TITLE });
    const completedBtn = completedCard.getByRole("button", {
      name: /awaiting results|menunggu keputusan/i,
    });
    await expect(completedBtn).toBeVisible();
    await expect(completedBtn).toBeDisabled();
    await expect(completedBtn).not.toHaveAttribute("onclick");

    // â”€â”€ 4. Student B can still start (one-attempt is per student) â”€
    await registerUser(studentBPage, STUDENT_B_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentBPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentBPage, joinCode, CLASS_TITLE);
    await studentBPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentBPage).toHaveURL(/\/student\/quizzes/);
    await studentBPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentBPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await expect(studentBPage.getByText("What is 2+2?", { exact: true })).toBeVisible();

    await lecturerCtx.close();
    await studentACtx.close();
    await studentBCtx.close();
  });
});
