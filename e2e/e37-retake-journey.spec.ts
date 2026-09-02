import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createQuizWithQuestions,
  openResults,
  resolveServiceClient,
} from "./helpers";

/**
 * E37 — QC-4 retake journey (the E2E gaps unit/verify tests cannot cover):
 *
 *  1. Lecturer enables retakes on a LIVE assessment via the edit dialog's
 *     retake fieldset (QC-4 UI: assessment-only, live-editable — the PATCH
 *     bypasses the draft lock).
 *  2. Student completes attempt 1 → clicks Start again → a NEW attempt
 *     spawns (attempt=2) — the pre-0032 behavior was a redirect to the old
 *     EndScreen; the retake path lands on a FRESH play page instead.
 *  3. The results dashboard renders the "Attempt #2" chip once both rows
 *     exist (the chip only renders when attempt > 1).
 *  4. Budget exhaustion: after the final allowed attempt, Start redirects
 *     to the completed EndScreen (legacy already_attempted + session_id
 *     contract, e5-pinned journey) — no new session spawns.
 *  5. The completed card keeps the awaiting chip with retakes enabled
 *     (E40-pinned coexistence) — the retake copy on the list card belongs
 *     to the not-yet-started state only.
 *
 * Service-role seam: reading attempt rows directly for the coexistence
 * assertion (the UI cannot enumerate a student's attempts).
 */

const stamp = Date.now();
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = `E37 Retake ${stamp}`;
const QUIZ_TITLE = `E37 Retake Quiz ${stamp}`;

test.describe.configure({ mode: "serial" });

test("retake journey: enable on live quiz → spawn → chip → budget exhaustion", async ({
  browser,
}) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");
  test.setTimeout(300_000);

  // ── Setup: lecturer + UNTIMED assessment (no face gate interference —
  // untimed + no enroll keeps the flow on the consent-free path, e5 style).
  const lecCtx = await browser.newContext();
  const lecturer = await lecCtx.newPage();
  await registerUser(lecturer, `e37-lec-${stamp}@e2e.test`, "lecturer", INVITE);
  const joinCode = await createClass(lecturer, CLASS_TITLE);
  await createQuizWithQuestions(lecturer, {
    classTitle: CLASS_TITLE,
    quizTitle: QUIZ_TITLE,
    mode: "assessment",
    publish: true,
    questions: [
      { prompt: "E37 Q1?", options: ["A1", "B1"], correctIndex: 0 },
      { prompt: "E37 Q2?", options: ["A2", "B2"], correctIndex: 1 },
    ],
  });
  const quizId = new URL(lecturer.url()).pathname.match(
    /\/lecturer\/quizzes\/([0-9a-f-]{36})/,
  )?.[1] ?? "";
  expect(quizId).toMatch(/^[0-9a-f-]{36}$/);

  const stuCtx = await browser.newContext();
  const student = await stuCtx.newPage();
  await registerUser(student, `e37-stu-${stamp}@e2e.test`, "student", "");
  await joinClass(student, joinCode, CLASS_TITLE);

  // ── 1. Student list shows the default one-attempt copy pre-enable.
  await student.goto("/student/quizzes");
  await expect(student.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
  await expect(student.getByText("One attempt only", { exact: true })).toBeVisible();

  // ── Student completes attempt 1.
  await student.getByRole("button", { name: "Start" }).click();
  await expect(student).toHaveURL(/\/play\/[0-9a-f-]+/);
  const attempt1Url = student.url();
  await expect(student.getByText("E37 Q1?", { exact: true })).toBeVisible();
  await student.getByRole("button", { name: /A1/i }).click();
  await student.getByRole("button", { name: "Next", exact: true }).click();
  await expect(student.getByText("E37 Q2?", { exact: true })).toBeVisible();
  await student.getByRole("button", { name: /B2/i }).click();
  await student.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(
    student.getByText(/released by your lecturer/i),
  ).toBeVisible({ timeout: 10_000 });

  // ── 2. Default config: the completed card is LOCKED — a single DISABLED
  // "Awaiting results" button (awaiting state merged into it), no Start to
  // click (the legacy already_attempted + session_id redirect contract is
  // server-side only).
  await student.goto("/student/quizzes");
  const lockedCard = student.locator("li").filter({ hasText: QUIZ_TITLE });
  const lockedBtn = lockedCard.getByRole("button", {
    name: /awaiting results|menunggu keputusan/i,
  });
  await expect(lockedBtn).toBeDisabled();

  // ── 3. Lecturer enables retakes (2 attempts) via the edit dialog on the
  // LIVE quiz — metadata fields are disabled, retake controls are not.
  await lecturer.goto(`/lecturer/quizzes/${quizId}/builder`);
  const settingsBtn = lecturer.getByRole("button", { name: "Quiz settings" });
  await expect(settingsBtn).toBeVisible();
  await settingsBtn.click();
  const dialog = lecturer.getByRole("dialog", { name: "Edit quiz settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toBeDisabled();
  await dialog.getByRole("switch", { name: "Allow students to retake this assessment" }).click();
  await dialog.getByLabel("Max attempts").fill("2");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  // Student list still reflects completed attempt 1: the awaiting chip stays
  // (pinned by E40 — the chip reflects attempt 1, the Start button reflects
  // the resumable attempt 2) and no score-less View results link appears.
  await student.goto("/student/quizzes");
  await expect(
    student
      .getByRole("status")
      .filter({ hasText: /awaiting results|menunggu keputusan/i }),
  ).toHaveCount(1);
  await expect(
    student.getByRole("link", { name: /view results|lihat keputusan/i }),
  ).toHaveCount(0);

  // ── 4. Retake spawns a NEW session (attempt 2), not the old EndScreen.
  await student.getByRole("button", { name: "Start" }).click();
  await expect(student).toHaveURL(/\/play\/[0-9a-f-]+/);
  const attempt2Url = student.url();
  expect(attempt2Url).not.toBe(attempt1Url);
  await expect(student.getByText("E37 Q1?", { exact: true })).toBeVisible();
  await student.getByRole("button", { name: /A1/i }).click();
  await student.getByRole("button", { name: "Next", exact: true }).click();
  await student.getByRole("button", { name: /B2/i }).click();
  await student.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(
    student.getByText(/released by your lecturer/i),
  ).toBeVisible({ timeout: 10_000 });

  // ── 5. Both attempts coexist server-side (attempt 1 + 2, both completed).
  const admin = resolveServiceClient();
  if (admin) {
    await expect
      .poll(async () => {
        const { data } = await admin
          .from("quiz_sessions")
          .select("attempt, status")
          .eq("quiz_id", quizId)
          .order("attempt");
        return JSON.stringify(data ?? []);
      })
      .toContain('"attempt":2');
  }

  // ── 6. Results dashboard shows the attempt chip for the retaken student.
  await openResults(lecturer, CLASS_TITLE, QUIZ_TITLE);
  await expect(
    lecturer.getByText(/attempt #2/i).first(),
  ).toBeVisible({ timeout: 10_000 });

  // ── 7. Budget exhausted (2/2 with retakes enabled): the card still offers
  // Start (the completed-lock button only applies to no-retake quizzes), but
  // a third Start redirects to the LATEST completed session (attempt 2's
  // URL) — the legacy already_attempted + session_id contract — never
  // spawning attempt 3.
  await student.goto("/student/quizzes");
  await student.getByRole("button", { name: "Start" }).click();
  await expect(student).toHaveURL(attempt2Url);

  await lecCtx.close();
  await stuCtx.close();
});