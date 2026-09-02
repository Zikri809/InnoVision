import { test, expect } from "@playwright/test";
import { registerUser, createClass, joinClass, revealQuiz } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_API_EMAIL = `lecturer-e10api-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_UI_EMAIL = `lecturer-e10ui-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_API_EMAIL = `student-e10api-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_UI_EMAIL = `student-e10ui-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E10 Timer";
const QUIZ_API_TITLE = "E10 API Timer";
const QUIZ_UI_TITLE = "E10 UI Timer";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * E10 (Phase 5 scope) — Timer expiry, split into two halves that cannot race
 * (separate students + separate sessions):
 *
 *  (a) API contract half (deterministic): student starts an assessment with
 *      time_limit_sec=5 via page.request (captures the session + started_at
 *      from the START-SESSION RESPONSE); waits until started_at + 10s + 2s
 *      (deadline = limit + grace = 10s, plus â‰¥2s to absorb now()â†’
 *      clock_timestamp() skew and transport — NEVER measured from page load);
 *      POSTs an answer â†’ 403 time_expired; then POSTs submit â†’ 200
 *      { session, score: 0, total } (late-submit acceptance + late-answer
 *      rejection both pinned).
 *
 *  (b) UI half: a separate short assessment; the client countdown (deadline =
 *      timeLimitSec only) hits 0 â†’ auto-submit â†’ lands on the EndScreen.
 *      time_limit_sec=10 and the student answers â‰¥1 question before expiry
 *      (EndScreen shows the ANSWERED score — stronger coverage of the
 *      answerâ†’auto-submit path than a zero-answer auto-submit).
 */

async function createTimedAssessment(
  page: import("@playwright/test").Page,
  opts: { classTitle: string; quizTitle: string; timeLimitSec: number; questions: { prompt: string; options: string[] }[] },
): Promise<string> {
  await page.getByText(opts.classTitle, { exact: true }).click();
  await expect(page).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
  await page.getByLabel("Quiz title").fill(opts.quizTitle);
  await page.getByLabel("Mode").click();
  await page.getByRole("option", { name: "Assessment" }).click();
  await page.getByRole("button", { name: /create quiz|new quiz/i }).click();
  await expect(page.getByText(opts.quizTitle, { exact: true })).toBeVisible();
  await page.getByText(opts.quizTitle, { exact: true }).click();
  await expect(page).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);
  const quizId = page.url().split("/builder")[0].split("/").pop()!;

  // Sub-minute test limits (e.g. 5s/10s) set via direct PATCH
  await page.evaluate(
    async ({ qid, limit }) => {
      await fetch(`/api/quizzes/${qid}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeLimitSec: limit }),
      });
    },
    { qid: quizId, limit: opts.timeLimitSec },
  );

  for (const q of opts.questions) {
    await page.getByRole("textbox", { name: "Question prompt" }).fill(q.prompt);
    await page.getByLabel("Option 1").fill(q.options[0]);
    await page.getByLabel("Option 2").fill(q.options[1]);
    await page.getByRole("button", { name: /add this question/i }).click();
    await expect(page.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");
    await expect(page.getByText(q.prompt, { exact: true })).toBeVisible();
  }

  const publishButton = page.getByRole("button", { name: /publish/i });
  await expect(publishButton).toBeEnabled();
  await publishButton.click();
  await expect(page.getByText(/^Live/)).toBeVisible();
  return quizId;
}

test.describe("E10 — timer expiry (API + UI halves)", () => {
  test("(a) API contract: late answer → 403 time_expired; late submit → 200 score 0", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // â”€â”€ Lecturer: class + 5s assessment + publish (capture quizId) â”€â”€
    await registerUser(lecturerPage, LECTURER_API_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    const quizId = await createTimedAssessment(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_API_TITLE,
      timeLimitSec: 5,
      questions: [
        { prompt: "What is 2+2?", options: ["3", "4"] },
        { prompt: "Capital of France?", options: ["Paris", "London"] },
      ],
    });

    // â”€â”€ Student: register + join (session cookie shared with page.request) â”€â”€
    await registerUser(studentPage, STUDENT_API_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);

    // Reveal results up front so the late-submit response carries the score
    // (assessment scores are otherwise hidden until release).
    await revealQuiz(lecturerPage, CLASS_TITLE, QUIZ_API_TITLE);

    // â”€â”€ Start via page.request â†’ capture started_at from the response â”€â”€
    const startRes = await studentPage.request.post("/api/sessions", {
      data: { quizId },
    });
    expect(startRes.status()).toBe(201);
    const startBody = await startRes.json();
    const session = startBody.session;
    expect(session.id).toBeTruthy();
    const startedAt = new Date(session.started_at).getTime();
    expect(Number.isFinite(startedAt)).toBe(true);

    // Wait until started_at + 10s (deadline = 5s limit + 5s grace) + 2s margin.
    const waitMs = startedAt + 12_000 - Date.now();
    if (waitMs > 0) await sleep(waitMs);

    // Late answer â†’ 403 time_expired (a random-but-valid uuid is fine: the
    // timer check precedes the question-membership check in the RPC).
    const lateAnswer = await studentPage.request.post(`/api/sessions/${session.id}/answer`, {
      data: { questionId: "00000000-0000-4000-8000-0000000000dd", selectedIndex: 0 },
    });
    expect(lateAnswer.status()).toBe(403);
    expect((await lateAnswer.json()).error).toBe("time_expired");

    // Late submit â†’ 200, score explicitly 0 (the rejected answer was not
    // recorded), total 2.
    const lateSubmit = await studentPage.request.post(`/api/sessions/${session.id}/submit`, {
      data: {},
    });
    expect(lateSubmit.status()).toBe(200);
    const submitBody = await lateSubmit.json();
    expect(submitBody.score).toBe(0);
    expect(submitBody.total).toBe(2);
    expect(submitBody.session.status).toBe("completed");

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("(b) UI: client countdown auto-submits to EndScreen with answered score", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(lecturerPage, LECTURER_UI_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createTimedAssessment(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_UI_TITLE,
      timeLimitSec: 10,
      questions: [
        { prompt: "What is 2+2?", options: ["3", "4"] },
        { prompt: "Capital of France?", options: ["Paris", "London"] },
      ],
    });

    // Reveal now so the auto-submitted EndScreen shows the score (hidden
    // assessments show the "awaiting release" state instead).
    await revealQuiz(lecturerPage, CLASS_TITLE, QUIZ_UI_TITLE);

    await registerUser(studentPage, STUDENT_UI_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await studentPage.getByRole("button", { name: "Start" }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);

    // UI half: with a 10s limit the countdown sits far under the 30s warning
    // threshold, so the HUD time chip must carry the destructive tint
    // (progress-hud.tsx:6,55-58) THE WHOLE time. Assert immediately on mount —
    // the countdown burns fast. The chip is the only tabular-nums span in the
    // top bar (not a <header> element).
    const hudTimer = studentPage.locator("span.tabular-nums").first();
    await expect(hudTimer).toBeVisible({ timeout: 15_000 });
    await expect(hudTimer).toHaveClass(/text-destructive/);
    await expect(hudTimer).toHaveClass(/bg-destructive\/15/);

    // AX-3: the countdown element exposes role="timer" (aria-live OFF — the
    // per-second value must never be announced) and a localized accessible
    // name ("Time remaining").
    await expect(hudTimer).toHaveAttribute("role", "timer");
    await expect(hudTimer).toHaveAccessibleName(/time remaining/i);

    // AX-3: a sub-30s session fires the assertive ONCE-only warning on mount
    // (the announced-set seeds on the first render under the threshold). The
    // sr-only announcer carries the "less than 30 seconds" copy.
    await expect(
      studentPage.locator('div[aria-live="assertive"]').filter({ hasText: /30 seconds|30 saat/i }),
    ).toBeVisible({ timeout: 10_000 });
    // Exactly ONE assertive node belongs to the play surface — Next's App
    // Router route announcer also renders div[aria-live="assertive"] in a
    // shadow root (Playwright CSS pierces shadow DOM), so the page-wide
    // count is 2; scope ours by its sr-only class + role=alert combo.
    await expect(
      studentPage.locator('div[aria-live="assertive"].sr-only[role="alert"]'),
    ).toHaveCount(1);

    // Answer one question correctly (correct_index defaults to option 1 = "3"
    // in createTimedAssessment) — well within 10s.
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /3/i }).click();
    await expect(studentPage.getByRole("button", { name: /^(Next|Finish)$/, exact: true })).toBeVisible();

    // The client countdown (10s) hits 0 → auto-submit → EndScreen. Wait up to
    // ~25s for the countdown + submit round trip. (Heading carries a trailing
    // emoji — match non-exact.)
    await expect(studentPage.getByText("Assessment complete", { exact: false })).toBeVisible({ timeout: 25_000 });
    // The answered score (1) is shown — stronger than a zero-answer auto-submit.
    // The score <p> renders "1 / 2" (with a nested span) — filter by text.
    await expect(
      studentPage.locator("p").filter({ hasText: /^1\s*\/\s*2\s*$/ }),
    ).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
