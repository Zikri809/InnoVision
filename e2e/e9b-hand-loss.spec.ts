import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  installFakeHandTracker,
  assertFakeHandTrackerInstalled,
  completeCalibration,
  playGestureSequence,
  fakeHandFrame,
  captureAnswerPosts,
} from "./helpers";
import { HOLD_MS, PAUSE_CLEAR_MS } from "../src/lib/gestures/constants";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e9b-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e9b-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E9b Hand Loss";
const QUIZ_TITLE = "E9b Assessment";

/**
 * E9b (Phase 6) — hand lost → auto-pause (U-G6 end-to-end), UNTIMED assessment.
 *
 *  1. Student starts + calibrates; Q1: hold finger 2 for 300ms, then hand
 *     absent for 10.5s.
 *  2. Warn chip appears ~3.3s; pause overlay appears ~10.3s.
 *  3. WHILE PAUSED: a full hold (finger 2, HOLD_MS + 150) is played → assert NO
 *     answer POST. This is the real "answers blocked" proof: the PAUSE_CLEAR_MS
 *     stabilization window (1500ms > 950ms hold) keeps the overlay up for the
 *     entire hold — a single present frame cannot unlock, and a hold started
 *     while paused cannot fire the instant input unblocks.
 *  4. Recovery: a continuous present hand held for PAUSE_CLEAR_MS clears the
 *     overlay; then a fresh full hold POSTs the answer and resolves 200 (a
 *     DB-paused session would 409 `session_not_active` — this pins "no DB
 *     status change" since no GET /api/sessions/[id] exists).
 */
test.describe("E9b — hand lost → auto-pause (client-side, recoverable)", () => {
  test("answers are blocked while paused and recover without a DB status change", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // ── Lecturer: class + UNTIMED assessment (2 questions) + publish ──
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);

    // createQuizWithQuestions creates a practice quiz by default; build the
    // assessment manually (mode select) to match E5's pattern.
    await lecturerPage.getByText(CLASS_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByLabel("Quiz title").fill(QUIZ_TITLE);
    await lecturerPage.getByLabel("Mode").click();
    await lecturerPage.getByRole("option", { name: "Assessment" }).click();
    await lecturerPage.getByRole("button", { name: /new quiz/i }).click();
    await expect(lecturerPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await lecturerPage.getByText(QUIZ_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

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

    // ── Student: register + join + fake tracker + start ──
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);

    await studentPage.getByRole("link", { name: /available quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await expect(studentPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();

    await installFakeHandTracker(studentPage);
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await assertFakeHandTrackerInstalled(studentPage);
    await completeCalibration(studentPage);

    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();

    // ── 1. Brief hold (finger 2, 300ms) then hand lost for 10.5s ──
    const blockedCapture = captureAnswerPosts(studentPage);
    await playGestureSequence(studentPage, [
      { fingers: 2, holdMs: 300 },
      { present: false, fingers: 0, holdMs: 10_500 },
    ]);

    // Warn chip ~3.3s after loss.
    await expect(
      studentPage.getByText("Keep your hand visible to answer", { exact: true }),
    ).toBeVisible({ timeout: 8_000 });
    // Pause overlay ~10.3s after loss.
    await expect(
      studentPage.getByText("Hand tracking paused", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // ── 2. While paused, a FULL hold must NOT answer (stabilization window) ──
    await playGestureSequence(studentPage, [{ fingers: 2, holdMs: HOLD_MS + 150 }]);
    await studentPage.waitForTimeout(1_500);
    // Still paused (the hold completed entirely while blocked).
    await expect(
      studentPage.getByText("Hand tracking paused", { exact: true }),
    ).toBeVisible();
    const blockedBodies = blockedCapture.bodies.filter((b) => b.includes("selectedIndex"));
    expect(blockedBodies.length).toBe(0);
    blockedCapture.detach();

    // Drop the hand so the stabilization counter resets (the while-paused hold
    // kept the hand continuously present; without this drop, the re-show below
    // would clear the overlay instantly instead of after PAUSE_CLEAR_MS).
    await playGestureSequence(studentPage, [{ present: false, fingers: 0, holdMs: 100 }]);

    // ── 3. Recovery: re-show + hold → overlay clears after PAUSE_CLEAR_MS ──
    await fakeHandFrame(studentPage, true, 2);
    await studentPage.waitForTimeout(PAUSE_CLEAR_MS + 300);
    await expect(
      studentPage.getByText("Hand tracking paused", { exact: true }),
    ).toBeHidden({ timeout: 5_000 });
    // Drop to a fist to reset the hold accumulator before the fresh recovery
    // hold (PAUSE_CLEAR_MS+300 leaves ~300ms carryover, not enough to latch,
    // but a fist makes the recovery hold deterministically fresh).
    await playGestureSequence(studentPage, [{ present: true, fingers: 0, holdMs: 100 }]);

    // ── 4. Fresh hold → answer POST resolves 200 (not 409 session_not_active) ──
    const recoveryRes = studentPage.waitForResponse(
      (res) => res.url().includes("/answer") && res.request().method() === "POST",
    );
    await playGestureSequence(studentPage, [{ fingers: 2, holdMs: HOLD_MS + 150 }]);
    const res = await recoveryRes;
    expect(res.status()).toBe(200);

    // The quiz continues (feedback chip visible — the answer was recorded).
    await expect(studentPage.getByText("Answered", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
