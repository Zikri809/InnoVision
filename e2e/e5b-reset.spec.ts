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
const LECTURER_EMAIL = `lecturer-e5b-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e5b-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E5b Reset";
const QUIZ_TITLE = "E5b Assessment";

/**
 * E5b (Phase 8 gate) — lecturer resets an attempt → the one-attempt slot is
 * released → the student re-takes; mid-flight reset surfaces the D13 dead
 * screen; every reset is audited.
 *
 * NOTE (deferred): SKIPPED until the planned UI rework is completed. This file
 * is the CONTRACT the rewrite must keep (selectors assert roles/text, not
 * class names). Flow through reset + re-take + mid-flight dead screen + audit,
 * then remove the skip and run it. See PLAN_PHASE8 §3 Step 5.
 *
 * Flow:
 * 1. Student completes attempt 1 (E5 locked state).
 * 2. Lecturer: results → Reset (destructive confirm dialog) → the row
 *    disappears (Completed count 0).
 * 3. Student: Start again → SUCCEEDS (slot released — the E5b gate) → answers
 *    Q1 (the re-take is functionally live).
 * 4. Lecturer: resets the in-progress re-take row mid-flight.
 * 5. Student: answers Q2 → the next answer POST surfaces the TERMINAL dead
 *    screen "This attempt was reset by your lecturer" (D13 — NOT a 404 loop,
 *    NOT "Answered", NOT a redirect back to the question). An EndScreen-parked
 *    tab cannot exercise this (overlays/POSTs are suppressed there) — the
 *    assertion is mid-quiz.
 * 6. Audit: via the service-role client, `audit_events` has `session_reset`
 *    rows carrying `metadata.session_id`/`quiz_id` (D13 route-level).
 */
test.describe("E5b — lecturer resets attempt", () => {
  test("reset releases the slot; mid-flight reset surfaces the D13 dead screen", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    // Deferred: run once the UI rework lands (see file header).
    test.skip(true, "Deferred until UI rework completes (PLAN_PHASE8 §3 Step 5)");
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const admin = resolveServiceClient();

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // ── 0. Lecturer: class + UNTIMED assessment + publish ────────────
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createAssessmentAndPublish(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      questions: [
        { prompt: "What is 2+2?", options: ["3", "4"], correctIndex: 1 },
        { prompt: "Capital of France?", options: ["Paris", "London"], correctIndex: 0 },
      ],
    });

    // ── 1. Student: complete attempt 1 (E5 locked state) ────────────
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /available quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    const session1Id = studentPage.url().split("/play/")[1];
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /4/i }).click();
    await expect(studentPage.getByText("Answered", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentPage.getByText("Capital of France?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /Paris/i }).click();
    await expect(studentPage.getByText("Answered", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(studentPage.getByText("Your score", { exact: true })).toBeVisible({ timeout: 10_000 });

    // ── 2. Lecturer: results → Reset (confirm dialog) → row gone ─────
    await openResults(lecturerPage, CLASS_TITLE, QUIZ_TITLE);
    await expect(lecturerPage.getByText("Completed", { exact: true })).toHaveCount(1);
    // The Reset button is rendered on the completed row.
    await lecturerPage.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(
      lecturerPage.getByRole("heading", { name: "Reset this attempt?" }),
    ).toBeVisible();
    await lecturerPage.getByRole("button", { name: "Reset attempt", exact: true }).click();
    // The row disappears after refresh.
    await expect(lecturerPage.getByText("Completed", { exact: true })).toHaveCount(0);

    // ── 3. Student: Start again → SUCCEEDS (slot released) ──────────
    await studentPage.getByRole("button", { name: "Back to quizzes" }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /4/i }).click();
    await expect(studentPage.getByText("Answered", { exact: true })).toBeVisible();

    // ── 4. Lecturer: reset the re-take row mid-flight ────────────────
    await openResults(lecturerPage, CLASS_TITLE, QUIZ_TITLE);
    await expect(lecturerPage.getByText("In progress", { exact: true })).toHaveCount(1);
    await lecturerPage.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(
      lecturerPage.getByRole("heading", { name: "Reset this attempt?" }),
    ).toBeVisible();
    await lecturerPage.getByRole("button", { name: "Reset attempt", exact: true }).click();
    await expect(lecturerPage.getByText("In progress", { exact: true })).toHaveCount(0);

    // ── 5. Student: next answer POST → D13 dead screen (NOT a 404 loop) ──
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentPage.getByText("Capital of France?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /Paris/i }).click();
    // The answer POST returns 404 (session gone) → the client surfaces the
    // terminal dead screen.
    await expect(
      studentPage.getByText(
        "This attempt was reset by your lecturer — ask them to restart you.",
        { exact: false },
      ),
    ).toBeVisible({ timeout: 10_000 });
    // NOT stuck in a recoverable state: no "Answered", no Finish submit.
    await expect(studentPage.getByText("Your score", { exact: true })).toHaveCount(0);

    // ── 6. Audit: session_reset rows with attributable metadata ──────
    if (admin) {
      const { data: resets, error } = await admin
        .from("audit_events")
        .select("action, metadata")
        .eq("action", "session_reset")
        .order("created_at", { ascending: false })
        .limit(5);
      expect(error).toBeNull();
      expect((resets ?? []).length).toBeGreaterThanOrEqual(2);
      for (const r of resets ?? []) {
        expect(r.metadata?.session_id).toBeTruthy();
        expect(r.metadata?.quiz_id).toBeTruthy();
      }
    } else {
      test.info().annotations.push({
        type: "skip",
        description: "service-role seam unavailable — audit assertion skipped",
      });
    }

    void session1Id;
    await lecturerCtx.close();
    await studentCtx.close();
  });
});