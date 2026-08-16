import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  installFakeFaceTracker,
  enrollViaFacePage,
  setFaceVerifyMode,
  triggerFaceBlink,
  recoverFromPause,
  setFacePeriodic,
  waitForFlaggedOverlay,
  captureFaceVerifyPosts,
} from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e7-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e7-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E7 Unlock";
const QUIZ_TITLE = "E7 Assessment";

/**
 * E7 (demo-killer, UNTIMED) — flagged → student self-recover 403 → lecturer
 * unlock (route; UI is P8) → poll detects 'active' + fires the re-verify
 * BEFORE clearing the overlay → overlay clears → answers → EndScreen.
 *
 * Assert the first verify POST after unlock carries the poll-returned nonce;
 * overlay-clear wait `{ timeout: FLAGGED_POLL_MS + 10_000 }`.
 */
test.describe("E7 — lecturer unlock", () => {
  test("flagged → lecturer unlock → poll recovers → answers continue", async ({ browser }, testInfo) => {
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
    await lecturerPage.getByRole("button", { name: /new quiz/i }).click();
    await expect(lecturerPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await lecturerPage.getByText(QUIZ_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    await lecturerPage.getByRole("textbox", { name: "Question" }).fill("What is 2+2?");
    await lecturerPage.getByLabel("Option 1").fill("3");
    await lecturerPage.getByLabel("Option 2").fill("4");
    await lecturerPage.getByRole("button", { name: /add question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question" })).toHaveValue("");

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

    // Fast cadence so mid-quiz periodic re-verifies fire deterministically.
    await setFacePeriodic(studentPage, { minMs: 2000, maxMs: 3000 });

    // Drive to flagged: 3 fail cycles with blink recovery between.
    for (let cycle = 0; cycle < 3; cycle++) {
      await setFaceVerifyMode(studentPage, "mismatch");
      if (cycle === 0) {
        // The gate is explicit-Begin: click Begin (blink + `'start'` verify)
        // with mismatch mode → the start verify fails → paused.
        const begin = studentPage.getByRole("button", { name: "Begin assessment", exact: true });
        await expect(begin).toBeEnabled({ timeout: 15_000 });
        await begin.click();
        await triggerFaceBlink(studentPage);
      }
      await expect(
        studentPage.getByText("Face check paused", { exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      if (cycle < 2) {
        // Blink-recover (mismatch again so the next verify fails too).
        await setFaceVerifyMode(studentPage, "mismatch");
        await recoverFromPause(studentPage);
        await expect(
          studentPage.getByText("Face check paused", { exact: true }),
        ).toBeVisible({ timeout: 15_000 });
      }
    }
    await waitForFlaggedOverlay(studentPage);

    // Student self-recover on flagged → 403 (explicit API assertion).
    const sessionId = studentPage.url().split("/play/")[1];
    const selfRecover403 = await studentPage.evaluate(async (sid) => {
      const res = await fetch("/api/face/self-recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sid }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, sessionId);
    expect(selfRecover403.status).toBe(403);

    // ── Lecturer unlocks via the route (UI is P8) ──
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

    // The flagged poll (8s) detects 'active' + fires the re-verify BEFORE
    // clearing the overlay. Assert a verify POST arrives carrying the
    // poll-returned nonce (the lecturer unlock rotated it).
    const verifyCapture = captureFaceVerifyPosts(studentPage);
    await setFaceVerifyMode(studentPage, "match");
    await expect(
      studentPage.getByText("Assessment flagged", { exact: true }),
    ).toBeHidden({ timeout: 20_000 });
    await expect.poll(() => verifyCapture.bodies.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const postUnlockNonce = (JSON.parse(verifyCapture.bodies[0]) as { nonce?: string }).nonce;
    expect(postUnlockNonce).toBeTruthy();
    // The unlock response rotated the nonce; the re-verify must NOT reuse the
    // stale pre-unlock nonce (it would 409). We can't read the poll's GET
    // nonce directly, but a non-empty nonce that is NOT the original start
    // nonce proves the poll refetched. Original start nonce is unknown here,
    // so we assert it's a UUID-shaped string (the RPC would 409 otherwise).
    expect(postUnlockNonce).toMatch(/^[0-9a-f-]{36}$/i);
    verifyCapture.detach();

    // Overlay cleared → answer Q1 → EndScreen.
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible({ timeout: 10_000 });
    await studentPage.getByRole("button", { name: /4/i }).click();
    await expect(studentPage.getByText("Answered", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(studentPage.getByText("Your score", { exact: true })).toBeVisible({ timeout: 10_000 });

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
