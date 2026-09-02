import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  installFakeFaceTracker,
  enrollViaFacePage,
  setFaceVerifyMode,
  clickBeginAndBlink,
  recoverFromPause,
  setFacePeriodic,
  waitForPauseOverlay,
  waitForFlaggedOverlay,
} from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e6-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e6-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E6 Pause Flag";
const QUIZ_TITLE = "E6 Assessment";

/**
 * E6 (demo-killer, UNTIMED) — face mismatch → paused → blink recovery → the
 * gate/periodic re-verify fails again → exactly 3 fail cycles → flagged (FLAT
 * window; recovery inserts no window row) → self-recovery path gone; lecturer
 * GET → flagged.
 *
 * The periodic cadence is overridden to 2–3s so the mid-quiz re-verify fires
 * deterministically (mirrors E12's fake-periodic seam).
 *
 * Mid-question recoverable-after-recovery sub-case: children stay mounted (no
 * MediaPipe re-boot) — asserted after the first recovery.
 */
test.describe("E6 — pause/flag cycle", () => {
  test("3 fail cycles → flagged; lecturer sees flagged via GET", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // Lecturer: class + UNTIMED assessment + publish.
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);

    await lecturerPage.getByText(CLASS_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByLabel("Quiz title").fill(QUIZ_TITLE);
    await lecturerPage.getByLabel("Mode").click();
    await lecturerPage.getByRole("option", { name: "Assessment" }).click();
    await lecturerPage.getByRole("button", { name: /create quiz|new quiz/i }).click();
    await expect(lecturerPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await lecturerPage.getByText(QUIZ_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("What is 2+2?");
    await lecturerPage.getByLabel("Option 1").fill("3");
    await lecturerPage.getByLabel("Option 2").fill("4");
    await lecturerPage.getByRole("button", { name: /add this question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");

    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/^Live/)).toBeVisible();

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

    // Fast cadence so the mid-quiz periodic re-verify fires deterministically.
    await setFacePeriodic(studentPage, { minMs: 2000, maxMs: 3000 });

    // ── 3 fail cycles: mismatch → paused → blink-recover → (repeat) ──
    // The gate is EXPLICIT-Begin (a failed-'start' recovery lands back IN the
    // gate; it never auto re-runs 'start'), so every fail cycle is:
    // Begin(+blink) → verify fails → paused overlay → blink-recover.
    let recoveredOnce = false;
    for (let cycle = 1; cycle <= 3; cycle++) {
      await setFaceVerifyMode(studentPage, "mismatch");

      await clickBeginAndBlink(studentPage);

      if (cycle < 3) {
        // Fails 1-2 → paused; blink-recover → back to the gate.
        await waitForPauseOverlay(studentPage);

        if (cycle === 1) {
          // Sub-case: children stay mounted after recovery (no re-calibration).
          await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible({
            timeout: 10_000,
          });
        }
        await recoverFromPause(studentPage);
        recoveredOnce = true;
      } else {
        // Fail 3 (FLAT last-5 window) → flagged — lecturer decision only.
        await waitForFlaggedOverlay(studentPage);
      }
    }

    // After 3 fail cycles the FLAT window hits 3 fails → flagged.
    await waitForFlaggedOverlay(studentPage);

    // Self-recovery path gone: the flagged overlay has no "Blink to recover".
    await expect(studentPage.getByText("Blink to recover", { exact: true })).toHaveCount(0);

    // Lecturer GET sees flagged + streak 3.
    const sessionId = studentPage.url().split("/play/")[1];
    const lectStatus = await lecturerPage.evaluate(async (sid) => {
      const res = await fetch(`/api/sessions/${sid}`, { method: "GET" });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, sessionId);
    expect(lectStatus.body.status).toBe("flagged");
    expect(lectStatus.body.face_fail_streak).toBe(3);

    expect(recoveredOnce).toBe(true);
    await lecturerCtx.close();
    await studentCtx.close();
  });
});
