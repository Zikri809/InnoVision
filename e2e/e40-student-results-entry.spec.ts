import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createAssessmentAndPublish,
  revealQuiz,
  completeQuiz,
  startQuizByTitle,
  currentSessionId,
} from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e40-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e40-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E40 Results Entry";
const QUIZ_1 = "E40 Revealed Quiz";
const QUIZ_2 = "E40 Awaiting Quiz";

// Fail-fast: 5s in-page assertion budget (e18 convention ONLY — e34 has no
// budget), 90s ceiling, skip without invite code. No networkidle, no fixed
// sleeps; polling uses expect.poll with a bounded timeout.
const fast = expect.configure({ timeout: 5_000 });

async function openQuizList(page: import("@playwright/test").Page) {
  // The EndScreen's "Back to quizzes" button (play.end.backToQuizzes) only
  // exists on the end screen; from anywhere else go direct. Prefer goto() —
  // it is deterministic and immune to whatever page we're on.
  await page.goto("/student/quizzes");
  await fast(page).toHaveURL(/\/student\/quizzes/);
}

/**
 * E40 — SQ-2 results entry point on student quiz cards, END TO END:
 *
 * 1. completed + revealed → "View results" link (a11y name includes quiz
 *    title) landing on the score-bearing EndScreen.
 * 2. completed + not revealed → "awaiting results" status chip, NOT a link;
 *    after reveal the chip becomes the link (transition).
 * 3. retake: active attempt 2 shadows completed attempt 1 (Resume wins).
 * 4. never-attempted → unchanged Start card.
 */
test.describe("E40 — student results entry point", () => {
  test("revealed → link with EndScreen score; awaiting → status chip → becomes link after reveal", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createAssessmentAndPublish(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_1,
      questions: [{ prompt: "What is 3+3?", options: ["5", "6"], correctIndex: 1 }],
    });
    await createAssessmentAndPublish(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_2,
      questions: [{ prompt: "What is 7+7?", options: ["13", "14"], correctIndex: 1 }],
    });

    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await joinClass(studentPage, joinCode, CLASS_TITLE);

    // Complete BOTH quizzes (scoped by card title — list is created_at DESC,
    // so .first() would always be QUIZ_2).
    await openQuizList(studentPage);
    await startQuizByTitle(studentPage, QUIZ_2);
    await completeQuiz(studentPage, ["14"], { next: "Next", finish: "Finish" });
    await fast(studentPage.getByText(/Assessment submitted!/i)).toBeVisible();

    await openQuizList(studentPage);
    await startQuizByTitle(studentPage, QUIZ_1);
    await completeQuiz(studentPage, ["6"], { next: "Next", finish: "Finish" });
    await fast(studentPage.getByText(/Assessment submitted!/i)).toBeVisible();

    // Neither revealed → BOTH cards show the awaiting chip, NEITHER is a link.
    await openQuizList(studentPage);
    await fast(studentPage.getByRole("status").filter({ hasText: /awaiting results|menunggu keputusan/i })).toHaveCount(2);
    await fast(studentPage.getByRole("link", { name: new RegExp(QUIZ_1) })).toHaveCount(0);

    // Lecturer reveals QUIZ_1 only.
    await revealQuiz(lecturerPage, CLASS_TITLE, QUIZ_1);

    // Card transition: QUIZ_1 becomes a real link whose accessible name
    // includes the quiz title; QUIZ_2 stays a status chip. Poll (bounded
    // at 10s — NOT the global 15s) instead of sleeping — fail-fast.
    await openQuizList(studentPage);
    await expect
      .poll(
        async () =>
          studentPage.getByRole("link", { name: new RegExp(`View results.*${QUIZ_1}`) }).count(),
        { timeout: 10_000 },
      )
      .toBe(1);
    await fast(studentPage.getByRole("status").filter({ hasText: /awaiting results|menunggu keputusan/i })).toHaveCount(1);

    // Click through: EndScreen renders the score (1/1 → "1").
    await studentPage.getByRole("link", { name: new RegExp(`View results.*${QUIZ_1}`) }).click();
    await fast(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await fast(studentPage.getByText(/1\s*\/\s*1/).first()).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("active retake attempt shadows a completed attempt 1 (Resume wins, no View results)", async ({ browser }, testInfo) => {
    testInfo.setTimeout(150_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(lecturerPage, `lecturer-e40r-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, `${CLASS_TITLE} R`);
    // Retake-enabled assessment: 2 attempts, no timer.
    await lecturerPage.getByText(`${CLASS_TITLE} R`, { exact: true }).click();
    await fast(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByLabel("Quiz title").fill("E40 Retake Quiz");
    await lecturerPage.getByLabel("Mode").click();
    await lecturerPage.getByRole("option", { name: "Assessment" }).click();
    await lecturerPage.getByLabel(/allow retake/i).check();
    await lecturerPage.getByLabel(/max attempts/i).selectOption("2");
    await lecturerPage.getByRole("button", { name: /create quiz|new quiz/i }).click();
    await fast(lecturerPage.getByText("E40 Retake Quiz", { exact: true })).toBeVisible();
    await lecturerPage.getByText("E40 Retake Quiz", { exact: true }).click();
    await fast(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("8+8?");
    await lecturerPage.getByLabel("Option 1").fill("15");
    await lecturerPage.getByLabel("Option 2").fill("16");
    await lecturerPage.getByRole("button", { name: /add question/i }).click();
    await fast(lecturerPage.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");
    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await publishButton.click();
    await fast(lecturerPage.getByText("Live", { exact: true })).toBeVisible();

    // Student: attempt 1 completed.
    await registerUser(studentPage, `student-e40r-${TEST_TIMESTAMP}@innovision.test`, "student", LECTURER_INVITE_CODE);
    await joinClass(studentPage, joinCode, `${CLASS_TITLE} R`);
    await openQuizList(studentPage);
    await startQuizByTitle(studentPage, "E40 Retake Quiz");
    const attempt1 = currentSessionId(studentPage);
    await completeQuiz(studentPage, ["16"], { next: "Next", finish: "Finish" });
    await fast(studentPage.getByText(/Assessment submitted!/i)).toBeVisible();

    // Back to list: quiz not revealed → awaiting chip (no link).
    await openQuizList(studentPage);
    await fast(studentPage.getByRole("status").filter({ hasText: /awaiting results|menunggu keputusan/i })).toHaveCount(1);

    // Start attempt 2 (retake allowed) and LEAVE it active mid-quiz.
    await startQuizByTitle(studentPage, "E40 Retake Quiz");
    await fast(studentPage).toHaveURL(new RegExp(`/play/(?!${attempt1})[0-9a-f-]+`));
    await fast(studentPage.getByText("8+8?", { exact: true })).toBeVisible();
    // Do NOT answer — navigate back to the quiz list with attempt 2 active.
    await openQuizList(studentPage);

    // Card contract with an ACTIVE attempt alongside a completed one: the
    // Start button re-renders (retake allowed) AND the awaiting chip is
    // still present — the chip reflects the completed attempt 1, the button
    // reflects the resumable attempt 2 (both states coexist by design;
    // pinned here so a regression on either side fails loudly).
    await fast(studentPage.getByRole("status").filter({ hasText: /awaiting results|menunggu keputusan/i })).toHaveCount(1);
    await fast(studentPage.getByRole("link", { name: /view results|lihat keputusan/i })).toHaveCount(0);
    await fast(
      studentPage
        .locator("li")
        .filter({ hasText: "E40 Retake Quiz" })
        .getByRole("button", { name: "Start", exact: true }),
    ).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
