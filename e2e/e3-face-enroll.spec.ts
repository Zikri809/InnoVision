import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  installFakeFaceTracker,
  enrollViaFacePage,
  setFaceVerifyMode,
  passAssessmentGate,
  revealQuiz,
  setFacePose,
  triggerFaceBlink,
} from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_E3A_EMAIL = `lecturer-e3a-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_E3A_EMAIL = `student-e3a-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_E3B_EMAIL = `lecturer-e3b-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_E3B_EMAIL = `student-e3b-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_E13_EMAIL = `lecturer-e13-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_E13_EMAIL = `student-e13-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E3 Face Enroll";
const QUIZ_TITLE = "E3 Assessment";

/**
 * E3 (+ E3b) — face enrollment + assessment gate (Phase 7 demo-killer, UNTIMED).
 *
 * E3: Student A enrolls (fake) → Start → `passAssessmentGate` → answer →
 * submit → EndScreen.
 *
 * E3b: Student B WITHOUT consent → blocker + enroll API 403, no embedding.
 *
 * Timer-gate pin (E13, iteration-3 testing 2): a TIMED assessment
 * (`timeLimitSec≈3`); the student starts and lands in the gate; liveness is
 * WITHHELD (no blink, no Begin) — the gate can only be exited by timer expiry
 * because the test withholds Begin; assert EndScreen with `0 / N` score within
 * ~`timeLimitSec + grace + margin` (≈20s) with no deadlock.
 */
test.describe("E3/E3b — face enrollment + assessment gate", () => {
  test("E3: enrolled student passes the gate, answers, and submits", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // Lecturer: class + UNTIMED assessment + publish.
    await registerUser(lecturerPage, LECTURER_E3A_EMAIL, "lecturer", LECTURER_INVITE_CODE);
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

    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("Capital of France?");
    await lecturerPage.getByLabel("Option 1").fill("Paris");
    await lecturerPage.getByLabel("Option 2").fill("London");
    await lecturerPage.getByRole("button", { name: /add this question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");

    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/^Live/)).toBeVisible();

    // Reveal the assessment results so the EndScreen shows the score (hidden
    // assessments show the "awaiting release" state instead).
    await revealQuiz(lecturerPage, CLASS_TITLE, QUIZ_TITLE);

    // Student A: register + join + fake face + enroll + start.
    await registerUser(studentPage, STUDENT_E3A_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);

    await installFakeFaceTracker(studentPage);
    await enrollViaFacePage(studentPage);

    // enrollViaFacePage redirects to /student/quizzes — verify the quiz is live.
    await expect(studentPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);

    // The gate appears; verify mode is 'match' → begin passes.
    await setFaceVerifyMode(studentPage, "match");
    await passAssessmentGate(studentPage);

    // Answer Q1 + Q2, submit. (The answered state = option disabled+pressed;
    // the old "Answered" chip copy no longer exists post-i18n.)
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /4/i }).click();
    await expect(studentPage.getByRole("button", { name: "B 4" })).toBeDisabled();
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentPage.getByText("Capital of France?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /Paris/i }).click();
    await expect(studentPage.getByRole("button", { name: /A Paris/ })).toBeDisabled();
    await studentPage.getByRole("button", { name: "Finish", exact: true }).click();
    // EndScreen heading carries a trailing emoji — match non-exact.
    await expect(studentPage.getByText("Assessment complete", { exact: false })).toBeVisible({ timeout: 10_000 });

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("E3b: student WITHOUT consent is blocked (enroll 403, no embedding)", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(lecturerPage, LECTURER_E3B_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await createClass(lecturerPage, CLASS_TITLE);

    await lecturerPage.getByText(CLASS_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByLabel("Quiz title").fill(QUIZ_TITLE);
    await lecturerPage.getByLabel("Mode").click();
    await lecturerPage.getByRole("option", { name: "Assessment" }).click();
    await lecturerPage.getByRole("button", { name: /create quiz|new quiz/i }).click();
    await expect(lecturerPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await lecturerPage.getByText(QUIZ_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("Q1");
    await lecturerPage.getByLabel("Option 1").fill("a");
    await lecturerPage.getByLabel("Option 2").fill("b");
    await lecturerPage.getByRole("button", { name: /add this question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");
    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/^Live/)).toBeVisible();

    // Student B: register (the platform-consent checkbox is mandatory at
    // registration) then REVOKE biometric consent via the UI button to reach
    // the unconsented state — mirrors a real student revoking from the
    // face-setup page (replaces the raw fetch call).
    await registerUser(studentPage, STUDENT_E3B_EMAIL, "student", LECTURER_INVITE_CODE);
    await installFakeFaceTracker(studentPage);
    await studentPage.goto("/student/face/enroll");
    // Enrolled=false but consent=true → the enroll panel renders with the
    // revoke button; the "Enroll your face" heading confirms consent state.
    await expect(studentPage.getByText("Enroll your face", { exact: true })).toBeVisible();
    await studentPage
      .getByRole("button", { name: "Revoke Biometric Consent", exact: true })
      .click();
    // Revoking drops consent → the consent card returns.
    await expect(
      studentPage.getByText("Your camera stays off", { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
    const revokeRes = await studentPage.evaluate(async () => {
      const res = await fetch("/api/face/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consent: false }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    });
    expect(revokeRes.status).toBe(200);

    // Direct enroll API → 403 consent_required.
    const enrollRes = await studentPage.evaluate(async () => {
      const res = await fetch("/api/face/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          frames: [
            "data:image/jpeg;base64,FAKE_FRAME_FRONT",
            "data:image/jpeg;base64,FAKE_FRAME_LEFT",
            "data:image/jpeg;base64,FAKE_FRAME_RIGHT",
          ],
        }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    });
    expect(enrollRes.status, `enroll body: ${JSON.stringify(enrollRes.body)}`).toBe(403);
    expect(enrollRes.body.error).toBe("consent_required");

    // Pin (privacy regression): WITHOUT consent the enroll page must NOT boot
    // the camera/tracker — no booting overlay, no capture panel, and the
    // camera-off hint shows instead. Checking the box records consent → the
    // boot proceeds → the capture panel settles.
    await studentPage.goto("/student/face/enroll");
    await expect(
      studentPage.getByText("Your camera stays off", { exact: false }),
    ).toBeVisible();
    const enrollConsentBox = studentPage.getByRole("checkbox");
    await expect(enrollConsentBox).toBeVisible();
    await expect(
      studentPage.getByRole("button", { name: "Start capture", exact: true }),
    ).toBeHidden();
    await expect(
      studentPage.getByText("Starting camera", { exact: false }),
    ).toBeHidden();

    // The consent state flips only after the async consent POST resolves,
    // so click (not check) and assert the post-condition instead.
    await enrollConsentBox.click();
    await expect(
      studentPage.getByRole("button", { name: "Start capture", exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      studentPage.getByText("Your camera stays off", { exact: false }),
    ).toBeHidden();

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("E13: TIMED assessment — gate cannot be bypassed; timer auto-submits score 0", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // Lecturer: TIMED assessment (timeLimitSec ≈ 3) + publish.
    await registerUser(lecturerPage, LECTURER_E13_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);

    await lecturerPage.getByText(CLASS_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByLabel("Quiz title").fill("E13 Timed");
    await lecturerPage.getByLabel("Mode").click();
    await lecturerPage.getByRole("option", { name: "Assessment" }).click();
    await lecturerPage.getByRole("button", { name: /create quiz|new quiz/i }).click();
    await expect(lecturerPage.getByText("E13 Timed", { exact: true })).toBeVisible();
    await lecturerPage.getByText("E13 Timed", { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("Q1");
    await lecturerPage.getByLabel("Option 1").fill("a");
    await lecturerPage.getByLabel("Option 2").fill("b");
    await lecturerPage.getByRole("button", { name: /add this question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");

    // Set the time limit (3s) via the PATCH route (the builder has no
    // time-limit field — E13 needs a TIMED assessment so the gate can only be
    // exited by timer expiry). Lecturer owns the draft quiz.
    const quizId = lecturerPage.url().split("/quizzes/")[1].split("/")[0];
    const patchRes = await lecturerPage.evaluate(async (qid) => {
      const res = await fetch(`/api/quizzes/${qid}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeLimitSec: 3 }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, quizId);
    expect(patchRes.status).toBe(200);

    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/^Live/)).toBeVisible();

    // Reveal results so the timer-expiry EndScreen shows the score.
    await revealQuiz(lecturerPage, CLASS_TITLE, "E13 Timed");

    // Student: register + join + enroll + start (fake face).
    await registerUser(studentPage, STUDENT_E13_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await installFakeFaceTracker(studentPage);
    await enrollViaFacePage(studentPage);

    // enrollViaFacePage redirects to /student/quizzes — verify the quiz is live.
    await expect(studentPage.getByText("E13 Timed", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);

    // The gate renders (Begin enabled since liveness passes), but we WITHHOLD
    // Begin — the timer expires → auto-submit → EndScreen with 0 / N.
    const begin = studentPage.getByRole("button", { name: "Begin assessment", exact: true });
    await expect(begin).toBeVisible({ timeout: 15_000 });

    // Timer (3s) + grace (5s) + margin → EndScreen within ~20s, no deadlock.
    // (Heading carries a trailing emoji; score renders as "0 / N" — non-exact.)
    await expect(studentPage.getByText("Assessment complete", { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(studentPage.getByText(/0 \/ 1/)).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("re-enroll: existing enrollment shows re-capture and replaces the embedding", async ({
    page,
  }) => {
    const email = `e3-recapture-${TEST_TIMESTAMP}@innovision.test`;
    await registerUser(page, email, "student", "");
    await installFakeFaceTracker(page);
    await enrollViaFacePage(page);

    // Reload the enroll page — an enrolled student sees the "Face already
    // enrolled" heading AND the Re-capture control.
    await page.goto("/student/face/enroll");
    await expect(page.getByText("Face already enrolled", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Re-capture", exact: true }),
    ).toBeVisible();

    // Re-run the capture → the gate still passes (embedding replaced).
    await page.getByRole("button", { name: "Re-capture", exact: true }).click();
    const angleScript = [
      { label: "Front", yaw: 0 },
      { label: "Left", yaw: 25 },
      { label: "Right", yaw: -25 },
    ] as const;
    for (const angle of angleScript) {
      await setFacePose(page, {
        yaw: angle.yaw,
        centered: true,
        faceDetected: true,
        facesSeen: 1,
        lighting: "good",
      });
      await expect(
        page.getByText(new RegExp(`Blink now[^\\n]*${angle.label}`, "i")),
      ).toBeVisible({ timeout: 15_000 });
      await triggerFaceBlink(page);
    }
    await expect(
      page.getByText("Enrolled successfully", { exact: false }),
    ).toBeVisible({ timeout: 30_000 });
  });
});
