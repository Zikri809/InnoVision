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
  waitForFlaggedOverlay,
  resolveServiceClient,
} from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e41b-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e41b-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E41b Unlock Notif";
const QUIZ_TITLE = "E41b Assessment";

/**
 * E41b — IO-1 flagged→unlock notification journey.
 *
 * 1. Drive a real flagged state (3 fail cycles, E6 choreography) with the
 *    fake face tracker.
 * 2. Lecturer unlocks via the route (E7 precedent) → the RPC now enqueues a
 *    `session_unlocked` notification for the student.
 * 3. Student sees the pinned "You can continue" item in the bell panel and
 *    deep-links back into /play/<sessionId>.
 * 4. Flagged overlay shows the wait ticker (data-testid, minutes label).
 *
 * DB-level assertions ride the service-role seam (e14 precedent) because
 * notification delivery timing vs realtime/polling is not deterministic.
 */
test.describe("E41b — unlock notification", () => {
  test("flagged → lecturer unlock → notification → deep link back", async ({ browser }, testInfo) => {
    testInfo.setTimeout(150_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    const admin = resolveServiceClient();
    test.skip(!admin, "service-role seam unavailable — required for notification assertions");
    const service = admin as NonNullable<typeof admin>;

    const lecturerCtx = await browser.newContext();
    // Fast notification polling (e30 seam) so the bell row lands fast.
    const studentCtx = await browser.newContext();
    await studentCtx.addInitScript(() => {
      (window as unknown as { __INNOVISION_NOTIF_CONTROL__?: { pollMs: number } }).__INNOVISION_NOTIF_CONTROL__ =
        { pollMs: 500 };
    });
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // Lecturer: class + UNTIMED assessment + publish.
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await lecturerPage.getByText(CLASS_TITLE, { exact: true }).click();
    await lecturerPage.getByLabel("Quiz title").fill(QUIZ_TITLE);
    await lecturerPage.getByLabel("Mode").click();
    await lecturerPage.getByRole("option", { name: "Assessment" }).click();
    await lecturerPage.getByRole("button", { name: /create quiz|new quiz/i }).click();
    await lecturerPage.getByText(QUIZ_TITLE, { exact: true }).click();
    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("What is 3+3?");
    await lecturerPage.getByLabel("Option 1").fill("5");
    await lecturerPage.getByLabel("Option 2").fill("6");
    await lecturerPage.getByRole("button", { name: /add this question/i }).click();
    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();

    // Student: register + join + enroll + start.
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await installFakeFaceTracker(studentPage);
    await enrollViaFacePage(studentPage);
    await expect(studentPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    const sessionId = studentPage.url().split("/play/")[1];

    // Fast periodic cadence → deterministic flag cycle (E6 choreography).
    await setFacePeriodic(studentPage, { minMs: 2000, maxMs: 3000 });
    for (let cycle = 0; cycle < 3; cycle++) {
      await setFaceVerifyMode(studentPage, "mismatch");
      await clickBeginAndBlink(studentPage);
      if (cycle < 2) {
        await expect(
          studentPage.getByText("Face check paused", { exact: true }),
        ).toBeVisible({ timeout: 15_000 });
        await recoverFromPause(studentPage);
      } else {
        await waitForFlaggedOverlay(studentPage);
      }
    }

    // The flagged overlay carries the wait ticker.
    await expect(studentPage.getByTestId("flagged-wait-ticker")).toBeVisible();
    await expect(studentPage.getByTestId("flagged-wait-ticker")).toContainText(
      /Waiting for review/,
    );

    // Lecturer unlocks via the route — 200 + the RPC enqueues the notification.
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

    // DB: exactly one session_unlocked row for this student/session.
    const { data: notifRows, error: notifErr } = await service
      .from("notifications")
      .select("id, type, payload, dedupe_key")
      .eq("type", "session_unlocked")
      .eq("payload->>session_id", sessionId);
    expect(notifErr).toBeNull();
    expect(notifRows?.length).toBe(1);
    expect(notifRows?.[0]?.payload).toMatchObject({ quiz_title: QUIZ_TITLE });

    // The student's poll recovers the session (E7 contract) — the flagged
    // overlay clears once the re-verify passes.
    await setFaceVerifyMode(studentPage, "match");
    await expect(
      studentPage.getByText("Assessment flagged", { exact: true }),
    ).toBeHidden({ timeout: 30_000 });

    // Deep-link journey — the IO-1 persona is the student who navigated AWAY
    // during the flag (the in-play poll covers the ones who stayed). Leave
    // /play, then let the bell carry them back in (e30-proven surface).
    await studentPage.goto("/student/quizzes");
    await expect(async () => {
      await studentPage
        .getByRole("button", { name: /Notifications(, \d+ unread)?/, exact: true })
        .click();
      await expect(
        studentPage.getByRole("button", { name: /You can continue/ }).first(),
      ).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    await studentPage.getByRole("button", { name: /You can continue/ }).first().click();
    await expect(studentPage).toHaveURL(new RegExp(`/play/${sessionId}`));
    await expect(studentPage.getByText("What is 3+3?", { exact: true })).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
