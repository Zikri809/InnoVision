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
 * E36 — QC-1 mid-session close (grace semantics) + QC-2 closed-before-reveal
 * recovery journey. The two E2E gaps route/SQL tests cannot cover:
 *
 *  1. Mid-session close (submit-only grace, client journey):
 *     student starts a PRACTICE quiz, lecturer closes it mid-session, then:
 *       - the next answer POST → 409 quiz_not_live (RPC gate, 0012:199-208),
 *       - the client SUBMITS the earned evidence instead of dead-ending
 *         (audit-3 D-F1: submit_session is deliberately status-free for
 *         active/paused, so the stranded assessment is rescued — the
 *         EndScreen renders the partial score),
 *       - the results page of the completed session STILL renders (practice
 *         is policy-revealed) via the closed+revealed metadata fallback,
 *       - a play-page RELOAD of the now-unstartable quiz card is moot — the
 *         session URL itself stays reachable.
 *
 *     NOTE: this test previously pinned the OPPOSITE posture ("the dead phase
 *     has no submit control by design" + an API-driven submit). That posture
 *     is exactly what audit-3 D-F1 confirmed as the High-severity strand: a
 *     closed quiz left the session active, unsubmitted and unscoreable, with
 *     the one-active index blocking any retake. The client now submits, so
 *     the API-driven submit in the old step 2 is replaced by an idempotent
 *     re-submit assertion.
 *
 *  2. Reveal-first-then-close journey (QC-2):
 *     lecturer closes an ASSESSMENT quiz whose student already submitted;
 *     the close dialog must offer the reveal-first CTA; clicking it reveals
 *     AND closes; the student's bell-free entry (direct session URL) then
 *     shows score + breakdown through the closed+revealed fallback view.
 *     (The bell itself is Realtime/poll — E2E asserts the page-level truth,
 *     not the bell timing.)
 *
 * Both journeys need the service-role seam (localhost-gated, e13b/e26
 * precedent) only where the app cannot drive the state (starting the
 * student's session id for direct-URL assertions is read from the URL bar).
 */

const stamp = Date.now();
const LECTURER_EMAIL = `e36-lec-${stamp}@e2e.test`;
const STUDENT_EMAIL = `e36-stu-${stamp}@e2e.test`;
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = `E36 Grace ${stamp}`;
const QUIZ_TITLE = `E36 Grace Quiz ${stamp}`;

test.describe.configure({ mode: "serial" });

test("mid-session close: client auto-submits, submit grace succeeds, results reachable", async ({
  browser,
}) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");
  test.setTimeout(180_000);

  // ── Setup: lecturer + published practice quiz; enrolled student.
  const lecCtx = await browser.newContext();
  const lecturer = await lecCtx.newPage();
  await registerUser(lecturer, LECTURER_EMAIL, "lecturer", INVITE);
  const joinCode = await createClass(lecturer, CLASS_TITLE);
  await createQuizWithQuestions(lecturer, {
    classTitle: CLASS_TITLE,
    quizTitle: QUIZ_TITLE,
    publish: true,
    questions: [
      { prompt: "E36 Q1?", options: ["A1", "B1"], correctIndex: 0 },
      { prompt: "E36 Q2?", options: ["A2", "B2"], correctIndex: 1 },
    ],
  });
  const quizId = new URL(lecturer.url()).pathname.match(
    /\/lecturer\/quizzes\/([0-9a-f-]{36})/,
  )?.[1] ?? "";
  expect(quizId).toMatch(/^[0-9a-f-]{36}$/);

  const stuCtx = await browser.newContext();
  const student = await stuCtx.newPage();
  await registerUser(student, STUDENT_EMAIL, "student", "");
  await joinClass(student, joinCode, CLASS_TITLE);

  // ── Student starts the quiz.
  await student.goto("/student/quizzes");
  await expect(student.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
  await student.getByRole("button", { name: "Start" }).click();
  await expect(student).toHaveURL(/\/play\/[0-9a-f-]+/);
  const sessionUrl = student.url();
  const sessionId = sessionUrl.split("/play/")[1] ?? "";
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

  // ── Answer Q1 (pre-close) — practice feedback confirms the write.
  await expect(student.getByText("E36 Q1?", { exact: true })).toBeVisible();
  await student.getByRole("button", { name: /A1/i }).click();
  await expect(student.getByText(/^Correct/)).toBeVisible();
  // Advance to Q2 (unanswered) so the close lands mid-question.
  await student.getByRole("button", { name: "Next", exact: true }).click();
  await expect(student.getByText("E36 Q2?", { exact: true })).toBeVisible();

  // ── Lecturer closes mid-session (app-driven via the results dashboard).
  await lecturer.goto("/lecturer/classes");
  await lecturer.getByText(CLASS_TITLE, { exact: true }).click();
  await lecturer.getByText(QUIZ_TITLE, { exact: true }).click();
  await expect(lecturer).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
  const closeBtn = lecturer.getByRole("button", { name: /close quiz/i });
  await expect(closeBtn).toBeVisible();
  await closeBtn.click();
  const dialog = lecturer.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: /close quiz/i })).toBeEnabled();
  await dialog.getByRole("button", { name: /close quiz/i }).click();
  // Builder flips to Closed (the close button unmounts for non-live).
  await expect(lecturer.getByRole("button", { name: /close quiz/i })).toBeHidden({
    timeout: 10_000,
  });
  // Settle: confirm the close committed server-side before the student acts
  // (the UI unmount can outrun the state flip under load — read the
  // authoritative status via the service-role DB, NOT a republish poll:
  // 500ms POSTs exhaust the 30/hr publish rate budget across repeats).
  const admin0 = resolveServiceClient();
  if (admin0) {
    await expect
      .poll(async () => {
        const { data } = await admin0
          .from("quizzes")
          .select("status")
          .eq("id", quizId)
          .single();
        return data?.status;
      })
      .toBe("closed");
  }

  // ── 1. Next answer → 409 quiz_not_live → the client SUBMITS (D-F1).
  // submit_session is deliberately status-free for active/paused sessions, so
  // the in-flight student's earned evidence must not be stranded. The client
  // enters timeUp and hands off to submitNow() — the EndScreen with the
  // partial score is the persistent user-visible consequence.
  await student.getByRole("button", { name: /A2/i }).click();
  // The EndScreen mounts BOTH compositions (mobile + wide) — scope to the
  // visible one or the text match resolves to 2 elements.
  await expect(
    student.locator("p:visible", { hasText: /Practice complete/i }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    student.locator(":visible", { hasText: /^1\s*\/\s*2$/ }).first(),
  ).toBeVisible({ timeout: 10_000 });

  // ── 2. Submit-grace contract double-check via the API: the client's
  // close-driven submit already completed the session (submit_session is
  // status-free by design), so a re-submit is idempotent → 409
  // already_submitted carrying the stored score.
  const submitRes = await student.request.post(`/api/sessions/${sessionId}/submit`, {
    data: {},
  });
  expect(submitRes.status()).toBe(409);
  const submitBody = await submitRes.json();
  expect(submitBody.error).toBe("already_submitted");
  expect(submitBody.session.status).toBe("completed");
  expect(submitBody.score).toBe(1);

  // ── 3. Completed session URL stays reachable post-close (QC-2 fallback:
  // student_quiz_view misses → student_closed_revealed_quiz_view supplies
  // the metadata; practice = policy-revealed → EndScreen with score).
  await student.goto(sessionUrl);
  await expect(student).toHaveURL(sessionUrl);
  await expect(student.locator(":visible", { hasText: /^1\s*\/\s*2$/ }).first()).toBeVisible({ timeout: 10_000 });
  await expect(student.locator(":visible", { hasText: "50% correct" }).first()).toBeVisible();

  await lecCtx.close();
  await stuCtx.close();
});

test("reveal-first-then-close: unrevealed submissions warn, CTA reveals, student sees score", async ({
  browser,
}) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");
  test.setTimeout(240_000);

  // ── Setup: lecturer + ASSESSMENT quiz; student submits pre-close.
  const lecCtx = await browser.newContext();
  const lecturer = await lecCtx.newPage();
  await registerUser(lecturer, `e36-lec2-${stamp}@e2e.test`, "lecturer", INVITE);
  const joinCode = await createClass(lecturer, `${CLASS_TITLE} B`);
  await createQuizWithQuestions(lecturer, {
    classTitle: `${CLASS_TITLE} B`,
    quizTitle: `${QUIZ_TITLE} B`,
    mode: "assessment",
    publish: true,
    questions: [
      { prompt: "E36b Q1?", options: ["A1", "B1"], correctIndex: 0 },
    ],
  });
  const quizId = new URL(lecturer.url()).pathname.match(
    /\/lecturer\/quizzes\/([0-9a-f-]{35,36})/,
  )?.[1] ?? "";
  expect(quizId).toMatch(/^[0-9a-f-]{36}$/);

  const stuCtx = await browser.newContext();
  const student = await stuCtx.newPage();
  await registerUser(student, `e36-stu2-${stamp}@e2e.test`, "student", "");
  await joinClass(student, joinCode, `${CLASS_TITLE} B`);

  // ── Student completes the assessment (single question → submit).
  await student.goto("/student/quizzes");
  await expect(student.getByText(`${QUIZ_TITLE} B`, { exact: true })).toBeVisible();
  await student.getByRole("button", { name: "Start" }).click();
  await expect(student).toHaveURL(/\/play\/[0-9a-f-]+/);
  const sessionUrl = student.url();
  // Practice-style answer flow doesn't apply: assessment answers are keyless
  // acks (no Correct chip). Click option A1 → feedback → Finish (single
  // question → goNext submits).
  await expect(student.getByText("E36b Q1?", { exact: true })).toBeVisible();
  await student.getByRole("button", { name: /A1/i }).click();
  await student.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(
    student.locator("p:visible", { hasText: /released by your lecturer/i }),
  ).toBeVisible({ timeout: 10_000 });

  // ── Lecturer opens the close dialog on the results dashboard: the
  // unrevealed warning + reveal-first CTA must appear (QC-2 prevention UI).
  await lecturer.goto("/lecturer/classes");
  await lecturer.getByText(`${CLASS_TITLE} B`, { exact: true }).click();
  await lecturer.getByText(`${QUIZ_TITLE} B`, { exact: true }).click();
  await expect(lecturer).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
  const resultsLink = lecturer.getByRole("link", { name: /results/i }).first();
  await resultsLink.click();
  await expect(lecturer).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/results/);

  const menuBtn = lecturer.getByRole("button", { name: /quiz actions/i });
  if (await menuBtn.isVisible()) {
    await menuBtn.click();
  }
  const closeBtn = lecturer.getByRole("menuitem", { name: /close quiz/i }).or(
    lecturer.getByRole("button", { name: /close quiz/i })
  );
  await expect(closeBtn).toBeVisible();
  await closeBtn.click();
  const dialog = lecturer.getByRole("dialog");
  await expect(
    dialog.getByText(/1 student has submitted but results are not revealed/i),
  ).toBeVisible();
  const revealFirstBtn = dialog.getByRole("button", { name: /reveal first, then close/i });
  await expect(revealFirstBtn).toBeEnabled();
  await revealFirstBtn.click();

  // Both flips land: Close control unmounts (status=closed) and the reveal
  // card swaps to the revealed chip.
  await expect(lecturer.getByRole("button", { name: /quiz actions|close quiz/i })).toBeHidden({
    timeout: 10_000,
  });
  await expect(
    lecturer.getByText("Results revealed", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // ── Student journey: direct session URL now shows score + breakdown via
  // the closed+revealed metadata fallback (bell-free path; the bell would
  // deliver the same link via results_revealed notification).
  await student.goto(sessionUrl);
  await expect(student).toHaveURL(sessionUrl);
  // EndScreen renders score 1/1 for the revealed assessment.
  await expect(student.locator(":visible", { hasText: /^1\s*\/\s*1$/ }).first()).toBeVisible({ timeout: 10_000 });
  await expect(student.locator(":visible", { hasText: "100% correct" }).first()).toBeVisible();

  // The API contract double-check: quiz is closed AND revealed.
  const pubRes = await lecturer.request.post(`/api/quizzes/${quizId}/publish`);
  expect(pubRes.status()).toBe(409);

  await lecCtx.close();
  await stuCtx.close();
});

test("close-anyway: stranded pending state, later dashboard reveal recovers the score", async ({
  browser,
}) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");
  test.setTimeout(240_000);

  // ── Setup: lecturer + ASSESSMENT quiz; student submits pre-close (the
  // QC-2 second branch: the lecturer ignores the reveal-first CTA).
  const lecCtx = await browser.newContext();
  const lecturer = await lecCtx.newPage();
  await registerUser(lecturer, `e36-lec3-${stamp}@e2e.test`, "lecturer", INVITE);
  const joinCode = await createClass(lecturer, `${CLASS_TITLE} C`);
  await createQuizWithQuestions(lecturer, {
    classTitle: `${CLASS_TITLE} C`,
    quizTitle: `${QUIZ_TITLE} C`,
    mode: "assessment",
    publish: true,
    questions: [
      { prompt: "E36c Q1?", options: ["A1", "B1"], correctIndex: 0 },
    ],
  });
  const quizId = new URL(lecturer.url()).pathname.match(
    /\/lecturer\/quizzes\/([0-9a-f-]{35,36})/,
  )?.[1] ?? "";
  expect(quizId).toMatch(/^[0-9a-f-]{36}$/);

  const stuCtx = await browser.newContext();
  const student = await stuCtx.newPage();
  await registerUser(student, `e36-stu3-${stamp}@e2e.test`, "student", "");
  await joinClass(student, joinCode, `${CLASS_TITLE} C`);

  // ── Student completes the assessment; the EndScreen is reveal-gated.
  await student.goto("/student/quizzes");
  await expect(student.getByText(`${QUIZ_TITLE} C`, { exact: true })).toBeVisible();
  await student.getByRole("button", { name: "Start" }).click();
  await expect(student).toHaveURL(/\/play\/[0-9a-f-]+/);
  const sessionUrl = student.url();
  await expect(student.getByText("E36c Q1?", { exact: true })).toBeVisible();
  await student.getByRole("button", { name: /A1/i }).click();
  await student.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(
    student.locator("p:visible", { hasText: /released by your lecturer/i }),
  ).toBeVisible({ timeout: 10_000 });

  // ── Lecturer closes anyway (dialog warns; the destructive secondary is
  // clicked, NOT the reveal-first CTA).
  await openResults(lecturer, `${CLASS_TITLE} C`, `${QUIZ_TITLE} C`);
  const menuBtn = lecturer.getByRole("button", { name: /quiz actions/i });
  if (await menuBtn.isVisible()) {
    await menuBtn.click();
  }
  const closeBtn = lecturer.getByRole("menuitem", { name: /close quiz/i }).or(
    lecturer.getByRole("button", { name: /close quiz/i })
  );
  await expect(closeBtn).toBeVisible();
  await closeBtn.click();
  const dialog = lecturer.getByRole("dialog");
  await expect(
    dialog.getByText(/1 student has submitted but results are not revealed/i),
  ).toBeVisible();
  await dialog.getByRole("button", { name: /close anyway/i }).click();
  await expect(lecturer.getByRole("button", { name: /quiz actions|close quiz/i })).toBeHidden({
    timeout: 10_000,
  });

  // ── Stranded-pending (QC-1 decision 4): the student's session URL on a
  // CLOSED+UNREVEALED quiz renders the truthful 404 — both metadata views
  // exclude it (student_quiz_view is live-only; the closed-revealed fallback
  // is reveal-gated), so nothing leaks and nothing strands. The pending
  // EndScreen exists only while the quiz is still live.
  await student.goto(sessionUrl);
  await expect(student.getByRole("heading", { name: "Page not found" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(student.locator("h2:visible", { hasText: /Answer breakdown/ })).toHaveCount(0);

  // ── Lecturer reveals LATER from the dashboard (one-way flip on a closed
  // quiz — QC-2 half 1 route relaxation, verify-pinned; here the UI).
  await openResults(lecturer, `${CLASS_TITLE} C`, `${QUIZ_TITLE} C`);
  const revealBtn = lecturer.getByRole("button", { name: /reveal to students/i });
  await expect(revealBtn).toBeVisible();
  await revealBtn.click();
  const confirmBtn = lecturer.getByRole("button", { name: /reveal/i }).last();
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();
  await expect(
    lecturer.getByText("Results revealed", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // ── Recovery: the SAME session URL now shows the score + breakdown.
  await student.goto(sessionUrl);
  await expect(student.locator(":visible", { hasText: /^1\s*\/\s*1$/ }).first()).toBeVisible({ timeout: 10_000 });
  await expect(student.locator(":visible", { hasText: "100% correct" }).first()).toBeVisible();
  await expect(
    student.locator("h2:visible", { hasText: "Answer breakdown" }).first(),
  ).toBeVisible();

  await lecCtx.close();
  await stuCtx.close();
});
