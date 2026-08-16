import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  installFakeHandTracker,
  assertFakeHandTrackerInstalled,
  completeCalibration,
  playGestureSequence,
  captureAnswerPosts,
  installFakeFaceTracker,
  enrollViaFacePage,
  setFaceVerifyMode,
  triggerFaceBlink,
  passAssessmentGate,
} from "./helpers";
import { HOLD_MS } from "../src/lib/gestures/constants";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e9b-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e9b-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E9b Hand Loss";
const QUIZ_TITLE = "E9b Assessment";

/**
 * E9b (Phase 7 rework) — hand lost → SERVER-side pause (P7), UNTIMED,
 * `testInfo.setTimeout(120_000)`.
 *
 *  1. Install fake-face → `enrollViaFacePage` → `passAssessmentGate` → hand-loss
 *     sequence → `onPause` → pause route → await pause response, then GET
 *     `paused` → answers blocked: zero gesture answer POSTs while paused + a
 *     direct `page.request` answer → 409.
 *  2. Hand returns mid-pause → a held gesture must NOT fire (`sessionPaused`).
 *  3. Blink → self-recover → active → fresh hold → answer 200.
 *
 * NOTE: the hand-loss pause (P6 client overlay) is now the server-side
 * `paused` status via `POST /api/sessions/[id]/pause`; recovery is via the
 * face blink → `self_recover_session`, not the P6 client-only 200 path.
 */
test.describe("E9b — hand lost → server pause → blink recovery → answer", () => {
  test("answers are blocked while server-paused and recover via blink", async ({ browser }, testInfo) => {
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

    // ── Student: register + join + fake face + fake hand + enroll + start ──
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);

    // Install BOTH seams BEFORE Start (face for the pipeline, hand for gestures).
    await installFakeFaceTracker(studentPage);
    await installFakeHandTracker(studentPage);
    await enrollViaFacePage(studentPage);

    // enrollViaFacePage redirects to /student/quizzes — verify the quiz is live.
    await expect(studentPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await assertFakeHandTrackerInstalled(studentPage);

    // Pass the assessment gate (face match).
    await setFaceVerifyMode(studentPage, "match");
    await passAssessmentGate(studentPage);

    // Calibrate the hand tracker.
    await completeCalibration(studentPage);
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();

    const sessionId = studentPage.url().split("/play/")[1];

    // ── 1. Brief hold, then hand lost for 10.5s → server pause ──
    const blockedCapture = captureAnswerPosts(studentPage);
    await playGestureSequence(studentPage, [
      { fingers: 2, holdMs: 300 },
      { present: false, fingers: 0, holdMs: 10_500 },
    ]);

    // Warn chip ~3.3s after loss.
    await expect(
      studentPage.getByText("Keep your hand visible to answer", { exact: true }),
    ).toBeVisible({ timeout: 8_000 });

    // The hand-loss pause route fires → server status becomes 'paused'.
    // Await the pause response (the pipeline POSTs /pause on hand loss).
    const pauseRes = studentPage.waitForResponse(
      (res) => res.url().includes("/pause") && res.request().method() === "POST",
    );
    const pauseResponse = await pauseRes;
    expect(pauseResponse.status()).toBe(200);

    // Then GET paused (server-truth).
    await expect
      .poll(
        async () => {
          const res = await studentPage.evaluate(async (sid) => {
            const r = await fetch(`/api/sessions/${sid}`, { method: "GET" });
            return (await r.json()).status;
          }, sessionId);
          return res;
        },
        { timeout: 10_000 },
      )
      .toBe("paused");

    // ── 2. While paused, a full hold must NOT answer (`sessionPaused`) ──
    await playGestureSequence(studentPage, [{ fingers: 2, holdMs: HOLD_MS + 150 }]);
    await studentPage.waitForTimeout(1_500);
    const blockedBodies = blockedCapture.bodies.filter((b) => b.includes("selectedIndex"));
    expect(blockedBodies.length).toBe(0);

    // Direct server answer → 409 session_not_active (blocked proof).
    const directAnswer = await studentPage.request.post(`/api/sessions/${sessionId}/answer`, {
      data: { questionId: "00000000-0000-4000-8000-000000000000", selectedIndex: 0 },
    });
    expect(directAnswer.status()).toBe(409);
    blockedCapture.detach();

    // ── 3. Blink → self-recover → active → fresh hold → answer 200 ──
    await setFaceVerifyMode(studentPage, "match");
    await triggerFaceBlink(studentPage);

    // The pipeline self-recovers (blink → self_recover_session → active).
    await expect
      .poll(
        async () => {
          const res = await studentPage.evaluate(async (sid) => {
            const r = await fetch(`/api/sessions/${sid}`, { method: "GET" });
            return (await r.json()).status;
          }, sessionId);
          return res;
        },
        { timeout: 10_000 },
      )
      .toBe("active");

    // Fresh hold → answer POST resolves 200.
    const recoveryRes = studentPage.waitForResponse(
      (res) => res.url().includes("/answer") && res.request().method() === "POST",
    );
    await playGestureSequence(studentPage, [{ fingers: 2, holdMs: HOLD_MS + 150 }]);
    const res = await recoveryRes;
    expect(res.status()).toBe(200);

    await expect(studentPage.getByText("Answered", { exact: true })).toBeVisible({ timeout: 10_000 });

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
