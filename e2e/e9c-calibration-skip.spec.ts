import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createQuizWithQuestions,
  installFakeHandTracker,
  assertFakeHandTrackerInstalled,
} from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e9c-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e9c-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E9c Skip";
const QUIZ_TITLE = "E9c Skip Calibration";

/**
 * E9c (Phase 6) — calibration Skip path → gestures off → click-first passthrough.
 *
 * The calibration panel is always skippable; skipping must stop the tracker,
 * flip the layer to `off`, show the "Gestures unavailable — click to answer"
 * chip (role="status"), and leave the quiz fully clickable.
 */
test.describe("E9c — calibration Skip → click-first fallback", () => {
  test("skipping calibration disables gestures and the quiz stays click-first", async ({
    browser,
  }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // ── Lecturer: class + practice quiz + publish ──
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);

    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      publish: true,
      questions: [
        {
          type: "mcq",
          prompt: "Q1: Click this one.",
          options: ["Alpha", "Beta", "Gamma"],
          correctIndex: 0,
        },
      ],
    });

    // ── Student: register + join + fake tracker + start ──
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);

    await studentPage.getByRole("link", { name: /available quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await expect(studentPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();

    await installFakeHandTracker(studentPage);
    await studentPage.getByRole("button", { name: "Start" }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await assertFakeHandTrackerInstalled(studentPage);

    // Calibration panel is shown with Skip always enabled.
    const skipBtn = studentPage.getByRole("button", { name: /skip/i });
    await expect(skipBtn).toBeVisible();
    await skipBtn.click();

    // Gestures off → the "unavailable" chip renders (role="status").
    await expect(
      studentPage.getByText("Gestures unavailable — click to answer", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // The quiz remains fully clickable (click-first passthrough).
    await expect(studentPage.getByText("Q1: Click this one.", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /Alpha/i }).click();
    await expect(studentPage.getByText("Correct", { exact: true })).toBeVisible();
    await expect(studentPage.getByRole("button", { name: /Alpha/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await studentPage.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(studentPage.getByText("Your score", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(studentPage.getByText(/^1\s*\/\s*1$/)).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
