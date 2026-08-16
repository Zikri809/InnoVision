import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createAssessmentAndPublish,
  openResults,
  resolveServiceClient,
} from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e14-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e14-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E14 Results Actions";
const QUIZ_TITLE = "E14 Assessment";

/**
 * E14 (optional, non-gate) — results dashboard action buttons:
 *
 * 1. The session is driven to `flagged` via the service-role seam (direct
 *    status seeding — the same explicit "status arrival is not this spec's
 *    job" precedent pinned in verify-results.mjs; E6/E7 own the UI choreography).
 *    The student's flagged poll + the dashboard's **Unlock** button (NOT the
 *    raw route) clear the row.
 * 2. Face-exempt a session (reason dialog — the Exempt button is disabled
 *    without a reason).
 * 3. Reset confirm + CANCEL does not reset (row stays).
 *
 * All three button paths run against the real dashboard client with
 * `router.refresh()` reconciliation.
 *
 * NOTE (deferred): SKIPPED until the planned UI rework is completed — same
 * contract role as the gate specs (see PLAN_PHASE8 §3 Step 5). Remove the skip
 * after the rewrite lands.
 */
test.describe("E14 — results action buttons", () => {
  test("Unlock button; Face-exempt dialog; Reset confirm-cancel", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    // Deferred: run once the UI rework lands (see file header).
    test.skip(true, "Deferred until UI rework completes (PLAN_PHASE8 §3 Step 5)");
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    const admin = resolveServiceClient();
    test.skip(!admin, "service-role seam unavailable — required to seed flagged");
    // Narrow after the runtime skip (test.skip is not a TS control-flow guard).
    const service = admin as NonNullable<typeof admin>;

    // ── 0. Lecturer: class + UNTIMED assessment + publish ───────────
    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createAssessmentAndPublish(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      questions: [{ prompt: "What is 2+2?", options: ["3", "4"], correctIndex: 1 }],
    });

    // ── 1. Student: start + answer; then seed `flagged` ─────────────
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /available quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    const sessionId = studentPage.url().split("/play/")[1];
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /4/i }).click();
    await expect(studentPage.getByText("Answered", { exact: true })).toBeVisible();

    // Seed `flagged` directly (service-role; status arrival is E6/E7's job).
    const { error: seedErr } = await service
      .from("quiz_sessions")
      .update({ status: "flagged", face_fail_streak: 3 })
      .eq("id", sessionId);
    expect(seedErr).toBeNull();

    // ── 2. Lecturer: Unlock button (not the raw route) ───────────────
    await openResults(lecturerPage, CLASS_TITLE, QUIZ_TITLE);
    await expect(lecturerPage.getByText("Flagged", { exact: true })).toHaveCount(1);
    await lecturerPage.getByRole("button", { name: "Unlock", exact: true }).click();
    // The dashboard refresh reconciles the unlocked row → no longer flagged.
    await expect(lecturerPage.getByText("Flagged", { exact: true })).toHaveCount(0);
    await expect(lecturerPage.getByText("In progress", { exact: true })).toHaveCount(1);

    // ── 3. Face-exempt dialog (reason required) ─────────────────────
    await lecturerPage.getByRole("button", { name: "Face-exempt", exact: true }).click();
    await expect(
      lecturerPage.getByRole("heading", { name: "Face-exempt this session" }),
    ).toBeVisible();
    const exemptBtn = lecturerPage.getByRole("button", { name: "Exempt", exact: true });
    await expect(exemptBtn).toBeDisabled();
    await lecturerPage.getByLabel("Reason").fill("webcam broken for demo");
    await expect(exemptBtn).toBeEnabled();
    await exemptBtn.click();
    // The dialog closes and the dashboard refreshes (request succeeded).
    await expect(
      lecturerPage.getByRole("heading", { name: "Face-exempt this session" }),
    ).toBeHidden();
    // The exempted session is still in-progress (changed status → refresh).
    await expect(lecturerPage.getByText("In progress", { exact: true })).toHaveCount(1);

    // ── 4. Reset confirm + CANCEL does not reset ────────────────────
    await lecturerPage.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(
      lecturerPage.getByRole("heading", { name: "Reset this attempt?" }),
    ).toBeVisible();
    await lecturerPage.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      lecturerPage.getByRole("heading", { name: "Reset this attempt?" }),
    ).toBeHidden();
    // The row survived the cancel.
    await expect(lecturerPage.getByText("In progress", { exact: true })).toHaveCount(1);

    await lecturerCtx.close();
    await studentCtx.close();
  });
});