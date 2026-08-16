import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  installFakeFaceTracker,
  enrollViaFacePage,
  setFaceVerifyMode,
  passAssessmentGate,
} from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e3-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_A_EMAIL = `student-e3a-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_B_EMAIL = `student-e3b-${TEST_TIMESTAMP}@innovision.test`;
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

    // Student A: register + join + fake face + enroll + start.
    await registerUser(studentPage, STUDENT_A_EMAIL, "student", LECTURER_INVITE_CODE);
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

    // Answer Q1 + Q2, submit.
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /4/i }).click();
    await expect(studentPage.getByText("Answered", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentPage.getByText("Capital of France?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /Paris/i }).click();
    await expect(studentPage.getByText("Answered", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(studentPage.getByText("Your score", { exact: true })).toBeVisible({ timeout: 10_000 });

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

    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await createClass(lecturerPage, CLASS_TITLE);

    await lecturerPage.getByText(CLASS_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByLabel("Quiz title").fill(QUIZ_TITLE);
    await lecturerPage.getByLabel("Mode").click();
    await lecturerPage.getByRole("option", { name: "Assessment" }).click();
    await lecturerPage.getByRole("button", { name: /new quiz/i }).click();
    await expect(lecturerPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await lecturerPage.getByText(QUIZ_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
    await lecturerPage.getByRole("textbox", { name: "Question" }).fill("Q1");
    await lecturerPage.getByLabel("Option 1").fill("a");
    await lecturerPage.getByLabel("Option 2").fill("b");
    await lecturerPage.getByRole("button", { name: /add question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question" })).toHaveValue("");
    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/published/i)).toBeVisible();

    // Student B: register WITHOUT biometric consent (uncheck the box).
    await studentPage.goto("/register");
    await studentPage.getByLabel("Full name (optional)").fill(`student-${TEST_TIMESTAMP}`);
    await studentPage.getByLabel("Email").fill(STUDENT_B_EMAIL);
    await studentPage.getByLabel("Password", { exact: true }).fill("testpass123");
    await studentPage.getByRole("radio", { name: "Student" }).check();
    // Do NOT check the consent box — register should still work but without consent.
    await studentPage.getByRole("button", { name: /register/i }).click();
    await studentPage.waitForURL(/\/student\/classes/, { timeout: 15_000 });

    // Direct enroll API → 403 consent_required.
    await installFakeFaceTracker(studentPage);
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
    expect(enrollRes.status).toBe(403);
    expect(enrollRes.body.error).toBe("consent_required");

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
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);

    await lecturerPage.getByText(CLASS_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByLabel("Quiz title").fill("E13 Timed");
    await lecturerPage.getByLabel("Mode").click();
    await lecturerPage.getByRole("option", { name: "Assessment" }).click();
    await lecturerPage.getByRole("button", { name: /new quiz/i }).click();
    await expect(lecturerPage.getByText("E13 Timed", { exact: true })).toBeVisible();
    await lecturerPage.getByText("E13 Timed", { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    await lecturerPage.getByRole("textbox", { name: "Question" }).fill("Q1");
    await lecturerPage.getByLabel("Option 1").fill("a");
    await lecturerPage.getByLabel("Option 2").fill("b");
    await lecturerPage.getByRole("button", { name: /add question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question" })).toHaveValue("");

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
    await expect(lecturerPage.getByText(/published/i)).toBeVisible();

    // Student: register + join + enroll + start (fake face).
    await registerUser(studentPage, STUDENT_A_EMAIL, "student", LECTURER_INVITE_CODE);
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
    await expect(studentPage.getByText("Your score", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(studentPage.getByText("0", { exact: true }).first()).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
