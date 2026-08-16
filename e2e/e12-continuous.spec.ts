import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  installFakeFaceTracker,
  enrollViaFacePage,
  setFaceVerifyMode,
  passAssessmentGate,
  setFacePeriodic,
  captureFaceVerifyPosts,
  expectNoAnswerPost,
  waitForPauseOverlay,
} from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e12-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e12-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E12 Continuous";
const QUIZ_TITLE = "E12 Assessment";

/**
 * E12 (demo-killer, UNTIMED) — continuous verify:
 *  - match → gate → RELOAD-BEFORE-BEGIN sub-case (gate re-renders) → Q1
 *  - Q-transition verify → Q2
 *  - `setFacePeriodic({minMs:2000,maxMs:3000})` → `expect.poll` a
 *    `trigger:'periodic'` within `{ timeout: 5_000 }`
 *  - mismatch anchored after the Q2 feedback chip → Q3 transition fails →
 *    pause overlay AND GET `paused` → blocked-answer proof: PRIMARY = direct
 *    server `page.request` answer → 409 `session_not_active`, PLUS
 *    `captureAnswerPosts`/`expectNoAnswerPost` zero-POST.
 */
test.describe("E12 — continuous verify", () => {
  test("reload-safe gate, Q-transition + periodic verifies, paused blocks answers", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // Lecturer: class + UNTIMED assessment (3 questions) + publish.
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);

    await lecturerPage.getByText(CLASS_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByLabel("Quiz title").fill(QUIZ_TITLE);
    await lecturerPage.getByLabel("Mode").click();
    await lecturerPage.getByRole("option", { name: "Assessment" }).click();
    await lecturerPage.getByRole("button", { name: /new quiz/i }).click();
    await expect(lecturerPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await lecturerPage.getByText(QUIZ_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    for (let i = 0; i < 3; i++) {
      await lecturerPage.getByRole("textbox", { name: "Question" }).fill(`Q${i + 1}`);
      await lecturerPage.getByLabel("Option 1").fill("a");
      await lecturerPage.getByLabel("Option 2").fill("b");
      await lecturerPage.getByRole("button", { name: /add question/i }).click();
      await expect(lecturerPage.getByRole("textbox", { name: "Question" })).toHaveValue("");
    }

    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/published/i)).toBeVisible();

    // Student: register + join + enroll + start.
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await installFakeFaceTracker(studentPage);
    await enrollViaFacePage(studentPage);

    // enrollViaFacePage redirects to /student/quizzes — verify the quiz is live.
    await expect(studentPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);

    // ── Reload-before-Begin sub-case: the gate re-renders (not bypassable) ──
    const begin = studentPage.getByRole("button", { name: "Begin assessment", exact: true });
    await expect(begin).toBeVisible({ timeout: 15_000 });
    await studentPage.reload();
    await expect(begin).toBeVisible({ timeout: 15_000 });

    // Pass the gate (match).
    await setFaceVerifyMode(studentPage, "match");
    await passAssessmentGate(studentPage);

    // Q1: answer.
    await expect(studentPage.getByText("Q1", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /a/i }).click();
    await expect(studentPage.getByText("Answered", { exact: true })).toBeVisible();

    // Q-transition verify fires (question → next). Capture verify POSTs.
    const verifyCapture = captureFaceVerifyPosts(studentPage);
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentPage.getByText("Q2", { exact: true })).toBeVisible();

    // Periodic cadence override → observe a real `trigger:'periodic'` quickly.
    await setFacePeriodic(studentPage, { minMs: 2000, maxMs: 3000 });
    await expect
      .poll(() => verifyCapture.bodies.some((b) => b.includes('"periodic"')), { timeout: 5_000 })
      .toBe(true);

    // ── Mismatch anchored after the Q2 feedback chip → Q3 transition fails ──
    await setFaceVerifyMode(studentPage, "mismatch");
    await studentPage.getByRole("button", { name: /a/i }).click();
    await expect(studentPage.getByText("Answered", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();

    // The Q3 transition verify fails → pause overlay AND GET paused.
    await waitForPauseOverlay(studentPage);

    const sessionId = studentPage.url().split("/play/")[1];
    const pausedStatus = await studentPage.evaluate(async (sid) => {
      const res = await fetch(`/api/sessions/${sid}`, { method: "GET" });
      return (await res.json()).status;
    }, sessionId);
    expect(pausedStatus).toBe("paused");

    // ── Blocked-answer proof ──
    // PRIMARY: direct server `page.request` answer → 409 session_not_active.
    const directAnswer = await studentPage.request.post(`/api/sessions/${sessionId}/answer`, {
      data: { questionId: "00000000-0000-4000-8000-000000000000", selectedIndex: 0 },
    });
    expect(directAnswer.status()).toBe(409);

    // SECONDARY: no gesture/click answer POST while paused (zero-POST).
    await expectNoAnswerPost(studentPage, { forIndex: 0, windowMs: 1500 });

    verifyCapture.detach();
    await lecturerCtx.close();
    await studentCtx.close();
  });
});
