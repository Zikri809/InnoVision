import { test, expect } from "@playwright/test";
import { registerUser, createClass, joinClass, createQuizWithQuestions } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e4-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e4-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E4 Physics";
const QUIZ_TITLE = "E4 Practice Motion";

/**
 * E4 (Phase 5 scope) — Practice quiz, click-first, with resume + replay.
 *
 * Verifies:
 *  1. Lecturer creates a class + untimed PRACTICE quiz (3 questions) + publishes
 *  2. Student registers, joins, starts the quiz
 *  3. Answers all 3 via clicks — practice shows feedback + correctIndex
 *  4. RESUME sub-case: asserts Q1's feedback chip is visible BEFORE
 *     page.reload() (proving the answer POST completed and the client
 *     advanced), then reloads â†’ engine resumes at Q2 (not stuck on Q1
 *     already_answered); finishes.
 *  5. REPLAY sub-case: navigates directly to the completed session URL â†’
 *     EndScreen renders (not the quiz).
 */

test.describe("E4 — practice quiz click-first with resume + replay", () => {
  test("student answers a practice quiz, resumes after refresh, replays the end screen", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // â”€â”€ 1. Lecturer: class + practice quiz + publish â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();

    const joinCode = await createClass(lecturerPage, CLASS_TITLE);

    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      publish: true,
      questions: [
        { type: "mcq", prompt: "What is velocity?", options: ["Speed in a direction", "Total distance"], correctIndex: 0, explanation: "Velocity is speed with direction." },
        { type: "mcq", prompt: "Which unit is force measured in?", options: ["Joule", "Newton", "Watt"], correctIndex: 1 },
        { type: "true_false", prompt: "Light travels faster than sound.", options: ["True", "False"], correctIndex: 0 },
      ],
    });

    // â”€â”€ 2. Student: register + join + start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);

    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    // The hero band renders "Available quizzes" as a chip (plain text) with
    // "Pick a quiz and wave your answer" as the h1 — match the actual layout.
    await expect(studentPage.getByText("Available quizzes", { exact: true })).toBeVisible();
    await expect(studentPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();

    // Start the quiz â†’ play page.
    await studentPage.getByRole("button", { name: "Start" }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);

    // Q1 visible.
    await expect(studentPage.getByText("What is velocity?", { exact: true })).toBeVisible();

    // â”€â”€ 3. Answer Q1 correctly â†’ practice feedback + correctIndex â”€â”€
    await studentPage.getByRole("button", { name: /Speed in a direction/i }).click();
    // Feedback chip shows "Correct".
    await expect(studentPage.getByText(/^Correct/)).toBeVisible();
    // Explanation text is shown (practice disclosure).
    await expect(studentPage.getByText(/Explanation:/)).toBeVisible();
    // The correct option is highlighted (correctIndex = 0 = "A").
    await expect(studentPage.getByRole("button", { name: /Speed in a direction/i })).toHaveAttribute("aria-pressed", "true");

    // â”€â”€ 4. RESUME sub-case â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Assert the feedback chip is visible BEFORE reload (proving the answer
    // POST completed and the client advanced).
    await expect(studentPage.getByText(/^Correct/)).toBeVisible();

    // Reload â†’ engine must resume at Q2 (NOT stuck on Q1 already_answered).
    await studentPage.reload();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await expect(studentPage.getByText("Which unit is force measured in?", { exact: true })).toBeVisible();
    // Q1 now shows a neutral "answered" chip (resume seed has no key).
    await expect(studentPage.getByText("Q 2/3", { exact: true })).toBeVisible();

    // Answer Q2 correctly (Newton = option B = index 1).
    await studentPage.getByRole("button", { name: /Newton/i }).click();
    await expect(studentPage.getByText(/^Correct/)).toBeVisible();

    // Next â†’ Q3.
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentPage.getByText("Light travels faster than sound.", { exact: true })).toBeVisible();

    // Answer Q3 correctly (True).
    await studentPage.getByRole("button", { name: /True/i }).click();
    await expect(studentPage.getByText(/^Correct/)).toBeVisible();

    // Finish → submit → end screen with score 3/3.
    await studentPage.getByRole("button", { name: "Finish", exact: true }).click();
    // The score is rendered as "3 / 3" in one element — match it robustly.
    await expect(studentPage.getByText(/^3\s*\/\s*3$/)).toBeVisible({ timeout: 10_000 });
    await expect(studentPage.getByText("100% correct", { exact: true })).toBeVisible();

    // ── 5. REPLAY sub-case: direct navigation to the completed session ──
    const sessionUrl = studentPage.url();
    await studentPage.goto(sessionUrl);
    await expect(studentPage).toHaveURL(sessionUrl);
    // EndScreen renders (not the quiz).
    await expect(studentPage.getByText(/^3\s*\/\s*3$/)).toBeVisible();
    await expect(studentPage.getByText("100% correct", { exact: true })).toBeVisible();

    // ── 6. SQ-3: EndScreen "Try again" starts a REAL fresh attempt ──
    // (routes into a NEW /play/<uuid> session at Q1 — never the quiz list).
    await studentPage.getByRole("button", { name: "Try again", exact: true }).click();
    // We are ALREADY on a /play/<uuid> URL, so toHaveURL passes trivially —
    // poll until the URL CHANGES (bounded; the POST + push completes in <1s
    // when healthy, and any handler path navigates somewhere).
    await expect
      .poll(() => studentPage.url(), { timeout: 10_000 })
      .not.toBe(sessionUrl);
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await expect(studentPage.getByText("What is velocity?", { exact: true })).toBeVisible();
    await expect(studentPage.getByText("Q 1/3", { exact: true })).toBeVisible();
    // The fresh question starts unanswered (no seeded highlight).
    await expect(studentPage.getByRole("button", { name: /Speed in a direction/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
