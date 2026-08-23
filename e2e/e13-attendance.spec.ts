import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  installFakeFaceTracker,
  enrollViaFacePage,
  passAssessmentGate,
  createAssessmentAndPublish,
  openResults,
  resolveServiceClient,
  staleActiveSession,
  revealQuiz,
} from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e13b-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_A_EMAIL = `student-e13a-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_B_EMAIL = `student-e13b-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_C_EMAIL = `student-e13c-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_D_EMAIL = `student-e13d-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E13b Attendance";
const QUIZ_TITLE = "E13b Assessment";
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

/**
 * E13b (Phase 8 gate) — Attendance = sessions.
 *
 * NOTE (deferred): SKIPPED until the planned UI rework is completed. This file
 * is the CONTRACT the rewrite must keep (selectors assert roles/text, not
 * class names). Flow through all 4 students + open the results dashboard, then
 * remove the skip and run it. See PLAN_PHASE8 §3 Step 5.
 *
 * 1. Lecturer: class + UNTIMED assessment (2 Q) + publish.
 * 2. Student A: register → join → ENROLL via the face page (fake-face seam) →
 *    start → pass the gate (real 'start' face check) → answer → submit.
 *    Produces a face-check timeline.
 * 3. Student B: register → join → start → answer → submit — UNSEAMED
 *    click-first (no fake face tracker / no enrollment) → `face_unavailable_at`
 *    marker recorded via the boot report.
 * 4. Student C: register → join → start → answer Q1 → do NOT submit
 *    (in-progress).
 * 5. Student D: register → join → start → answer Q1 → do NOT submit; then
 *    D's tab is CLOSED (so no periodic face check can re-touch
 *    `last_activity_at` — robot-touch limitation, plan §4) and only THEN
 *    `staleActiveSession` UPDATEs D's existing session to `last_activity_at =
 *    now − 3h` (deterministic abandoned — no INSERT collision with the
 *    one_assessment_attempt unique index).
 * 6. Lecturer opens results: EXACTLY 4 rows — A completed (score), B completed
 *    (score), C in_progress, D abandoned. A's row shows a face-check summary;
 *    B's row shows the camera-unavailable marker; scores asserted;
 *    `verify_nonce`/`correct_index` ABSENT on the rendered DOM (the reads are
 *    RSC projections, so there is no lecturer fetch to filter — E11's network
 *    filter is reworded accordingly).
 */
test.describe("E13b — attendance = sessions", () => {
  test("4 students render as attendance rows with derived statuses", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const admin = resolveServiceClient();

    const lecturerCtx = await browser.newContext();
    const studentACtx = await browser.newContext();
    const studentBCtx = await browser.newContext();
    const studentCCtx = await browser.newContext();
    const studentDCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentAPage = await studentACtx.newPage();
    const studentBPage = await studentBCtx.newPage();
    const studentCPage = await studentCCtx.newPage();
    const studentDPage = await studentDCtx.newPage();

    // ── 1. Lecturer: class + UNTIMED assessment + publish ────────────
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

    // Reveal the assessment results so the completed students' EndScreen shows
    // the score (hidden assessments show "awaiting release").
    await revealQuiz(lecturerPage, CLASS_TITLE, QUIZ_TITLE);

    // ── 2. Student A: enroll → gate (face check) → answer → submit ──
    await registerUser(studentAPage, STUDENT_A_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentAPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentAPage, joinCode, CLASS_TITLE);
    await installFakeFaceTracker(studentAPage);
    await enrollViaFacePage(studentAPage);
    await expect(studentAPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await studentAPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentAPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await passAssessmentGate(studentAPage);
    await expect(studentAPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await studentAPage.getByRole("button", { name: /4/i }).click();
    await expect(studentAPage.getByRole("button", { name: /^(Next|Finish)$/, exact: true })).toBeVisible();
    await studentAPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentAPage.getByText("Capital of France?", { exact: true })).toBeVisible();
    await studentAPage.getByRole("button", { name: /Paris/i }).click();
    await expect(studentAPage.getByRole("button", { name: /^(Next|Finish)$/, exact: true })).toBeVisible();
    await studentAPage.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(studentAPage.getByText("Assessment complete", { exact: false })).toBeVisible({ timeout: 10_000 });

    // ── 3. Student B: unseamed click-first → face_unavailable_at marker ──
    await registerUser(studentBPage, STUDENT_B_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentBPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentBPage, joinCode, CLASS_TITLE);
    await studentBPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentBPage).toHaveURL(/\/student\/quizzes/);
    await studentBPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentBPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await expect(studentBPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await studentBPage.getByRole("button", { name: /4/i }).click();
    await expect(studentBPage.getByRole("button", { name: /^(Next|Finish)$/, exact: true })).toBeVisible();
    await studentBPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentBPage.getByText("Capital of France?", { exact: true })).toBeVisible();
    await studentBPage.getByRole("button", { name: /Paris/i }).click();
    await expect(studentBPage.getByRole("button", { name: /^(Next|Finish)$/, exact: true })).toBeVisible();
    await studentBPage.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(studentBPage.getByText("Assessment complete", { exact: false })).toBeVisible({ timeout: 10_000 });

    // ── 4. Student C: start + answer Q1, do NOT submit (in-progress) ──
    await registerUser(studentCPage, STUDENT_C_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentCPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentCPage, joinCode, CLASS_TITLE);
    await studentCPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentCPage).toHaveURL(/\/student\/quizzes/);
    await studentCPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentCPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await expect(studentCPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await studentCPage.getByRole("button", { name: /4/i }).click();
    await expect(studentCPage.getByRole("button", { name: /^(Next|Finish)$/, exact: true })).toBeVisible();

    // ── 5. Student D: start + answer Q1, CLOSE the tab, then stale it ──
    await registerUser(studentDPage, STUDENT_D_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentDPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentDPage, joinCode, CLASS_TITLE);
    await studentDPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentDPage).toHaveURL(/\/student\/quizzes/);
    await studentDPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentDPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    const dSessionId = studentDPage.url().split("/play/")[1];
    await expect(studentDPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await studentDPage.getByRole("button", { name: /4/i }).click();
    await expect(studentDPage.getByRole("button", { name: /^(Next|Finish)$/, exact: true })).toBeVisible();

    // Close D's tab BEFORE the stale UPDATE — a parked-but-open tab could fire
    // a periodic face check and re-touch last_activity_at (robot-touch
    // limitation, plan §4). Closed → no check can race the UPDATE.
    await studentDCtx.close();

    if (admin) {
      const updated = await staleActiveSession(admin, {
        sessionId: dSessionId,
        lastActivityAt: new Date(Date.now() - THREE_HOURS_MS).toISOString(),
      });
      expect(updated).toBe(dSessionId);
    } else {
      // Seam unavailable (no service key / non-local host) → the abandoned
      // sub-assertion is SKIPPED (belt-and-braces; the derivation is
      // unit-covered by U-T4, so the gate isn't hollow).
      test.info().annotations.push({
        type: "skip",
        description: "service-role seam unavailable — D abandoned assertion skipped",
      });
    }

    // ── 6. Lecturer opens results ───────────────────────────────────
    await openResults(lecturerPage, CLASS_TITLE, QUIZ_TITLE);

    // Exactly 4 rows: the 4 status badges.
    const studentList = lecturerPage.getByRole("list");
    await expect(studentList.getByText("Completed", { exact: true })).toHaveCount(2);
    await expect(studentList.getByText("In progress", { exact: true })).toHaveCount(1);
    await expect(studentList.getByText("Abandoned", { exact: true })).toHaveCount(
      admin ? 1 : 0,
    );

    // Scores: A and B both answered correctly → 2 / 2.
    await expect(lecturerPage.getByText("2 / 2", { exact: true })).toHaveCount(2);

    // A's row shows a face-check summary (the gate recorded a real 'start'
    // check + any cadence checks).
    await expect(lecturerPage.getByText(/Face checks:/)).toHaveCount(1);

    // B's row shows the camera-unavailable marker (unseamed boot report).
    // C and D are ALSO unseamed, so their rows report it too — assert ≥1 (B
    // is the row the plan pins; the others are a legitimate consequence of
    // the unseamed boot path).
    await expect(lecturerPage.getByText(/Camera unavailable/).first()).toBeVisible();

    // Secrecy: verify_nonce / correct_index are structurally absent from the
    // rendered results DOM (RSC projections, D8/D10).
    await expect(lecturerPage.getByText("verify_nonce", { exact: false })).toHaveCount(0);
    await expect(lecturerPage.getByText("correct_index", { exact: false })).toHaveCount(0);

    await lecturerCtx.close();
    await studentACtx.close();
    await studentBCtx.close();
    await studentCCtx.close();
  });
});
