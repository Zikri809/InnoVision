import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  installFakeFaceTracker,
  installFakeHandTracker,
  assertFakeHandTrackerInstalled,
  enrollViaFacePage,
  setFaceVerifyMode,
  passAssessmentGate,
  clickBeginAndBlink,
  recoverFromPause,
  setFacePeriodic,
  waitForPauseOverlay,
  waitForFlaggedOverlay,
  completeCalibration,
  playGestureSequence,
  currentSessionId,
  createQuizWithQuestions,
} from "./helpers";

/**
 * E50 — Mid-State Session Reload Interruptions.
 * Runs in the `chromium` desktop project.
 *
 * Covers:
 *  1. Reload while paused (face mismatch):
 *     - Preserves pause overlay immediately on reload.
 *     - Countdown timer remains halted across reload.
 *     - Direct answer POST returns 409 session_not_active before and after reload.
 *     - Blink recovery restores active play, timer countdown resumes.
 *  2. Reload while paused (hand loss):
 *     - Hand loss server pause (POST /api/sessions/[id]/pause).
 *     - Preserves pause overlay immediately on reload.
 *     - Direct answer POST returns 409 before and after reload.
 *     - Blink recovery restores active play.
 *  3. Reload while flagged (3rd strike):
 *     - Preserves flagged overlay with FlaggedWaitTicker immediately on reload.
 *     - Polling resumes automatically; student cannot self-recover via blink.
 *     - Direct answer POST returns 409 before and after reload.
 *     - Lecturer unlock + student re-verify clears overlay and allows completing the quiz.
 */

const UNIQUE = `e50-${Date.now()}`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

test.describe("E50 — Mid-state Session Reload Interruptions", () => {
  test("reload while paused (face mismatch): preserves pause overlay, halts countdown, blocks input, and recovers via blink", async ({
    browser,
  }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    test.setTimeout(120_000);

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    const lecEmail = `${UNIQUE}-lec1@innovision.test`;
    const stuEmail = `${UNIQUE}-stu1@innovision.test`;
    const classTitle = `E50 Mismatch Class ${UNIQUE}`;
    const quizTitle = `E50 Mismatch Quiz ${UNIQUE}`;

    // 1. Lecturer creates timed assessment quiz (300s limit) with 2 questions
    await registerUser(lecturerPage, lecEmail, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, classTitle);

    await createQuizWithQuestions(lecturerPage, {
      classTitle,
      quizTitle,
      mode: "assessment",
      publish: false,
      questions: [
        {
          type: "mcq",
          prompt: "What is 2+2?",
          options: ["3", "4"],
          correctIndex: 1,
        },
        {
          type: "mcq",
          prompt: "Capital of France?",
          options: ["Paris", "Rome"],
          correctIndex: 0,
        },
      ],
    });

    // Set 300s timer limit via PATCH on draft quiz, then publish
    const builderUrl = lecturerPage.url();
    const quizId = builderUrl.split("/builder")[0].split("/").pop()!;
    await lecturerPage.evaluate(async ({ qid }) => {
      const res = await fetch(`/api/quizzes/${qid}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeLimitSec: 300 }),
      });
      if (!res.ok) throw new Error(`PATCH timeLimitSec failed: ${res.status}`);
    }, { qid: quizId });

    const publishBtn = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishBtn).toBeEnabled();
    await publishBtn.click();
    await expect(lecturerPage.getByText(/^Live/)).toBeVisible();

    // 2. Student registers, joins, enrolls face
    await registerUser(studentPage, stuEmail, "student", LECTURER_INVITE_CODE);
    await joinClass(studentPage, joinCode, classTitle);
    await installFakeFaceTracker(studentPage);
    await enrollViaFacePage(studentPage);

    // 3. Start quiz, pass assessment gate
    await expect(studentPage.getByText(quizTitle, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);

    await setFaceVerifyMode(studentPage, "match");
    await passAssessmentGate(studentPage);
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();

    const sessionId = currentSessionId(studentPage);

    // Verify timer chip exists and read initial time
    const timerChip = studentPage.locator("span[role='timer']");
    await expect(timerChip).toBeVisible();

    // 4. Trigger mismatch pause
    await setFacePeriodic(studentPage, { minMs: 1000, maxMs: 1500 });
    await setFaceVerifyMode(studentPage, "mismatch");
    await waitForPauseOverlay(studentPage);

    // Assert server status is paused
    await expect.poll(async () => {
      return await studentPage.evaluate(async (sid) => {
        const res = await fetch(`/api/sessions/${sid}`, { method: "GET" });
        return (await res.json()).status;
      }, sessionId);
    }, { timeout: 10_000 }).toBe("paused");

    // Direct answer returns 409 session_not_active
    const directAnswerBefore = await studentPage.request.post(`/api/sessions/${sessionId}/answer`, {
      data: { questionId: "00000000-0000-4000-8000-000000000000", selectedIndex: 0 },
    });
    expect(directAnswerBefore.status()).toBe(409);

    // Timer is halted while paused
    const pausedTime = await timerChip.textContent();
    await studentPage.waitForTimeout(2000);
    expect(await timerChip.textContent()).toBe(pausedTime);

    // 5. INTERRUPTION: Reload page
    await studentPage.reload();

    // 6. Assert pause overlay restores immediately upon reload
    await waitForPauseOverlay(studentPage);
    await expect(studentPage.getByText("Face check paused", { exact: true })).toBeVisible();
    await expect(studentPage.getByRole("button", { name: "Blink to recover", exact: true })).toBeVisible();

    // Direct answer POST still returns 409
    const directAnswerAfter = await studentPage.request.post(`/api/sessions/${sessionId}/answer`, {
      data: { questionId: "00000000-0000-4000-8000-000000000000", selectedIndex: 0 },
    });
    expect(directAnswerAfter.status()).toBe(409);

    // Timer remains halted after reload
    const postReloadTime = await studentPage.locator("span[role='timer']").textContent();
    await studentPage.waitForTimeout(2000);
    expect(await studentPage.locator("span[role='timer']").textContent()).toBe(postReloadTime);

    // 7. Recover from pause via blink
    await setFaceVerifyMode(studentPage, "match");
    const recoverRes = studentPage.waitForResponse(
      (res) => res.url().includes("/api/face/self-recover") && res.status() === 200,
    );
    await recoverFromPause(studentPage);
    await recoverRes;

    const begin = studentPage.getByRole("button", { name: "Begin assessment", exact: true });
    if (await begin.isVisible({ timeout: 5000 }).catch(() => false)) {
      await clickBeginAndBlink(studentPage);
    }

    // Overlay cleared, gate cleared, question back in focus
    await expect(studentPage.getByText("Face check paused", { exact: true })).toBeHidden();
    await expect(begin).toBeHidden({ timeout: 10_000 });
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();

    // Timer countdown resumes
    const timerEl = studentPage.locator("span[role='timer']");
    await expect(timerEl).toBeVisible({ timeout: 10_000 });
    const resumedTime = await timerEl.textContent();
    await expect.poll(async () => {
      return await timerEl.textContent();
    }, { timeout: 10_000 }).not.toBe(resumedTime);

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("reload while paused (hand loss): preserves pause overlay, blocks input, and recovers via blink", async ({
    browser,
  }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    test.setTimeout(120_000);

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    const lecEmail = `${UNIQUE}-lec2@innovision.test`;
    const stuEmail = `${UNIQUE}-stu2@innovision.test`;
    const classTitle = `E50 HandLoss Class ${UNIQUE}`;
    const quizTitle = `E50 HandLoss Quiz ${UNIQUE}`;

    // 1. Setup Assessment Quiz
    await registerUser(lecturerPage, lecEmail, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, classTitle);

    await createQuizWithQuestions(lecturerPage, {
      classTitle,
      quizTitle,
      mode: "assessment",
      publish: true,
      questions: [
        {
          type: "mcq",
          prompt: "What is 2+2?",
          options: ["3", "4"],
          correctIndex: 1,
        },
        {
          type: "mcq",
          prompt: "Capital of France?",
          options: ["Paris", "Rome"],
          correctIndex: 0,
        },
      ],
    });

    // 2. Student registers, installs fake face & fake hand trackers, enrolls
    await registerUser(studentPage, stuEmail, "student", LECTURER_INVITE_CODE);
    await joinClass(studentPage, joinCode, classTitle);

    await installFakeFaceTracker(studentPage);
    await installFakeHandTracker(studentPage);
    await enrollViaFacePage(studentPage);

    // 3. Start quiz, pass gate, complete calibration
    await expect(studentPage.getByText(quizTitle, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await assertFakeHandTrackerInstalled(studentPage);

    await setFaceVerifyMode(studentPage, "match");
    await passAssessmentGate(studentPage);
    await completeCalibration(studentPage);
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();

    const sessionId = currentSessionId(studentPage);

    // 4. Trigger hand loss pause
    const pauseRes = studentPage.waitForResponse(
      (res) => res.url().includes("/pause") && res.request().method() === "POST",
    );
    await playGestureSequence(studentPage, [
      { fingers: 2, holdMs: 300 },
      { present: false, fingers: 0, holdMs: 10_500 },
    ]);
    await pauseRes;
    await waitForPauseOverlay(studentPage);

    // Direct answer returns 409
    const directAnswerBefore = await studentPage.request.post(`/api/sessions/${sessionId}/answer`, {
      data: { questionId: "00000000-0000-4000-8000-000000000000", selectedIndex: 0 },
    });
    expect(directAnswerBefore.status()).toBe(409);

    // 5. INTERRUPTION: Reload page
    await studentPage.reload();

    // 6. Assert pause overlay restores immediately
    await waitForPauseOverlay(studentPage);
    await expect(studentPage.getByText("Face check paused", { exact: true })).toBeVisible();
    await expect(studentPage.getByRole("button", { name: "Blink to recover", exact: true })).toBeVisible();

    // Direct answer returns 409
    const directAnswerAfter = await studentPage.request.post(`/api/sessions/${sessionId}/answer`, {
      data: { questionId: "00000000-0000-4000-8000-000000000000", selectedIndex: 0 },
    });
    expect(directAnswerAfter.status()).toBe(409);

    // 7. Recover via blink
    await setFaceVerifyMode(studentPage, "match");
    const recoverRes2 = studentPage.waitForResponse(
      (res) => res.url().includes("/api/face/self-recover") && res.status() === 200,
    );
    await recoverFromPause(studentPage);
    await recoverRes2;

    const begin = studentPage.getByRole("button", { name: "Begin assessment", exact: true });
    if (await begin.isVisible({ timeout: 5000 }).catch(() => false)) {
      await clickBeginAndBlink(studentPage);
    }

    const continueBtn = studentPage.getByRole("button", { name: "Continue", exact: true });
    if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await completeCalibration(studentPage);
    }

    await expect(studentPage.getByText("Face check paused", { exact: true })).toBeHidden();
    await expect(begin).toBeHidden({ timeout: 10_000 });
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("reload while flagged (3rd strike): preserves flagged overlay, resumes polling, blocks bypass, and recovers upon lecturer unlock", async ({
    browser,
  }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    test.setTimeout(120_000);

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    const lecEmail = `${UNIQUE}-lec3@innovision.test`;
    const stuEmail = `${UNIQUE}-stu3@innovision.test`;
    const classTitle = `E50 Flagged Class ${UNIQUE}`;
    const quizTitle = `E50 Flagged Quiz ${UNIQUE}`;

    // 1. Setup Assessment Quiz
    await registerUser(lecturerPage, lecEmail, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, classTitle);

    await createQuizWithQuestions(lecturerPage, {
      classTitle,
      quizTitle,
      mode: "assessment",
      publish: true,
      questions: [
        {
          type: "mcq",
          prompt: "What is 2+2?",
          options: ["3", "4"],
          correctIndex: 1,
        },
        {
          type: "mcq",
          prompt: "Capital of France?",
          options: ["Paris", "Rome"],
          correctIndex: 0,
        },
      ],
    });

    // 2. Student registers, installs fake face tracker, enrolls
    await registerUser(studentPage, stuEmail, "student", LECTURER_INVITE_CODE);
    await joinClass(studentPage, joinCode, classTitle);

    await installFakeFaceTracker(studentPage);
    await enrollViaFacePage(studentPage);

    // 3. Start quiz
    await expect(studentPage.getByText(quizTitle, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);

    const sessionId = currentSessionId(studentPage);

    // Fast periodic cadence
    await setFacePeriodic(studentPage, { minMs: 2000, maxMs: 3000 });

    // 4. Drive 3 fail cycles: mismatch -> paused -> recover (cycles 1-2) -> flagged (cycle 3)
    for (let cycle = 0; cycle < 3; cycle++) {
      await setFaceVerifyMode(studentPage, "mismatch");
      await clickBeginAndBlink(studentPage);
      if (cycle < 2) {
        await waitForPauseOverlay(studentPage);
        await recoverFromPause(studentPage);
      } else {
        await waitForFlaggedOverlay(studentPage);
      }
    }

    // 5. Assert flagged overlay properties
    await waitForFlaggedOverlay(studentPage);
    await expect(studentPage.getByText("Assessment flagged", { exact: true })).toBeVisible();
    await expect(studentPage.getByTestId("flagged-wait-ticker")).toBeVisible();
    await expect(studentPage.getByRole("button", { name: "Check again", exact: true })).toBeVisible();
    await expect(studentPage.getByRole("button", { name: "Blink to recover" })).toHaveCount(0);

    // Direct answer returns 409
    const directAnswerBefore = await studentPage.request.post(`/api/sessions/${sessionId}/answer`, {
      data: { questionId: "00000000-0000-4000-8000-000000000000", selectedIndex: 0 },
    });
    expect(directAnswerBefore.status()).toBe(409);

    // 6. INTERRUPTION: Reload page
    await studentPage.reload();

    // 7. Assert flagged overlay restores immediately upon reload
    await waitForFlaggedOverlay(studentPage);
    await expect(studentPage.getByText("Assessment flagged", { exact: true })).toBeVisible();
    await expect(studentPage.getByTestId("flagged-wait-ticker")).toBeVisible();
    await expect(studentPage.getByRole("button", { name: "Check again", exact: true })).toBeVisible();
    await expect(studentPage.getByRole("button", { name: "Blink to recover" })).toHaveCount(0);

    // Direct answer still returns 409
    const directAnswerAfter = await studentPage.request.post(`/api/sessions/${sessionId}/answer`, {
      data: { questionId: "00000000-0000-4000-8000-000000000000", selectedIndex: 0 },
    });
    expect(directAnswerAfter.status()).toBe(409);

    // 8. Lecturer unlocks session
    const unlockRes = await lecturerPage.evaluate(async (sid) => {
      const res = await fetch("/api/face/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sid }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, sessionId);
    expect(unlockRes.status).toBe(200);
    expect(unlockRes.body.sessionStatus).toBe("active");

    // 9. Re-verify with match clears overlay
    await setFaceVerifyMode(studentPage, "match");
    await studentPage.getByRole("button", { name: "Check again", exact: true }).click();

    await expect(studentPage.getByText("Assessment flagged", { exact: true })).toBeHidden({ timeout: 20_000 });
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();

    // Finish quiz
    await studentPage.getByRole("button", { name: /4/i }).click();
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await studentPage.getByRole("button", { name: /Paris/i }).click();
    await studentPage.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(studentPage.getByText(/Assessment submitted!|Assessment complete/i)).toBeVisible({ timeout: 15_000 });

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
