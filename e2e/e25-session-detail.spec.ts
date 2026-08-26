import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createAssessmentAndPublish,
  installFakeFaceTracker,
  enrollViaFacePage,
  passAssessmentGate,
  openResults,
} from "./helpers";

/**
 * E25 — Session drill-in `/results/[sessionId]` — the dispute-resolution
 * screen. No spec has ever opened it: the "Actions" link, the score tile,
 * the per-question ✓/✗ pills, and the chosen-option highlighting are all
 * uncovered. Also pins the zero-session results dashboard (empty roster row,
 * export still offered) which no other flow reaches.
 */

const stamp = Date.now();
const LECTURER_EMAIL = `lecturer-e25-${stamp}@innovision.test`;
const STUDENT_EMAIL = `student-e25-${stamp}@innovision.test`;
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E25 Detail";
const QUIZ_TITLE = "E25 Dispute";

test.describe.configure({ mode: "serial" });

test.describe("E25 — session detail drill-in", () => {
  test("zero-session dashboard renders empty state before anyone attempts", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!INVITE, "LECTURER_INVITE_CODE not set");

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await registerUser(page, `${LECTURER_EMAIL}-0`, "lecturer", INVITE);
    await createClass(page, `${CLASS_TITLE} Empty`);
    await createAssessmentAndPublish(page, {
      classTitle: `${CLASS_TITLE} Empty`,
      quizTitle: `${QUIZ_TITLE} Empty`,
      questions: [{ prompt: "Nobody answered this?", options: ["a", "b"] }],
    });

    await openResults(page, `${CLASS_TITLE} Empty`, `${QUIZ_TITLE} Empty`);
    // Zero rows: the roster area shows its empty copy, not a crash, and no
    // session rows exist to drill into.
    await expect(
      page.getByText(/no (sessions|attempts|students)|hasn't|belum/i).first(),
    ).toBeVisible();
    await expect(page.locator('a[href*="/results/"][href*="-"]')).toHaveCount(0);
    await ctx.close();
  });

  test("Actions → session detail: score tile, ✓ pill on right, chosen wrong option", async ({ browser }, testInfo) => {
    testInfo.setTimeout(180_000);
    test.skip(!INVITE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // Lecturer: class + UNTIMED assessment (2 questions) + publish.
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", INVITE);
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createAssessmentAndPublish(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      questions: [
        { prompt: "What is 2+2?", options: ["3", "4"], correctIndex: 1 },
        { prompt: "Capital of France?", options: ["Paris", "London"], correctIndex: 0 },
      ],
    });

    // Student: join + enroll + complete with a KNOWN 1-right-1-wrong run.
    await registerUser(studentPage, STUDENT_EMAIL, "student", INVITE);
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await installFakeFaceTracker(studentPage);
    await enrollViaFacePage(studentPage);
    await expect(studentPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await passAssessmentGate(studentPage);

    // Q1 correct, Q2 deliberately wrong. A selection locks the question
    // ("Completed"); advancing to the next question needs its own Next press.
    await studentPage.getByRole("button", { name: /4/ }).click();
    const nextBtn = studentPage.getByRole("button", { name: /^(finish|next)$/i });
    await expect(nextBtn).toBeVisible({ timeout: 30_000 });
    await nextBtn.click();
    await expect(studentPage.getByText("Capital of France?", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await studentPage.getByRole("button", { name: /London/ }).click();
    // Final press submits ("Next" mid-run, "Finish" on the last question).
    // The button only renders once the answer POST acks (15s fetch budget),
    // so allow well beyond that for dev-mode latency.
    await expect(nextBtn).toBeVisible({ timeout: 30_000 });
    await nextBtn.click();
    await expect(
      studentPage.getByText(/results will be released|awaiting/i).first(),
    ).toBeVisible({ timeout: 30_000 });

    // Lecturer drills into THE session via the Actions link.
    await openResults(lecturerPage, CLASS_TITLE, QUIZ_TITLE);
    const actions = lecturerPage.getByRole("link", { name: /actions/i }).first();
    await expect(actions).toBeVisible({ timeout: 15_000 });
    const detail = lecturerPage.waitForURL(/\/results\/[0-9a-f-]+$/);
    await actions.click();
    await detail;

    // Score tile: exactly 1 of 2. Scoped to the hero <section> so neither the
    // banner's unread-notifications badge nor the option-number chips can win.
    const hero = lecturerPage
      .locator("main section")
      .filter({ has: lecturerPage.locator("h1") })
      .first();
    const scoreTile = hero.locator("span.font-heading.text-2xl").first();
    await expect(scoreTile).toHaveText("1");
    await expect(hero.getByText(/\/\s*2/)).toBeVisible();

    // Q1 row: ✓ present (the question-level pill AND the chosen-option badge
    // both render ✓ on a correct answer — assert either) .
    const q1 = lecturerPage.locator("li").filter({ hasText: "What is 2+2?" });
    await expect(q1).toBeVisible();
    await expect(q1.getByText("✓").first()).toBeVisible();

    // Chosen-option contract (session-detail-client.tsx:163-174): the picked
    // option row (the one containing "4") carries the emerald TINT classes and
    // its circle badge ✓, and never renders the trailing wrong-choice ✕.
    const q1Chosen = q1.locator("li").filter({ hasText: "4" });
    await expect(q1Chosen).toHaveCount(1);
    await expect(q1Chosen).toHaveClass(/bg-emerald-50/);
    await expect(q1Chosen.getByText("\u2713")).toBeVisible();
    await expect(q1Chosen.getByText("\u2715")).toHaveCount(0);

    // Q2 row: the WRONG choice is visible as the recorded selection and the
    // row is marked wrong. (The chosen option itself also renders a ✓/✕ pair
    // of badges, so absence-of-✓ is NOT the contract — the question-level ✗
    // marker is.)
    const q2 = lecturerPage.locator("li").filter({ hasText: "Capital of France?" });
    await expect(q2).toBeVisible();
    await expect(q2.getByText("London", { exact: true })).toBeVisible();
    await expect(q2.getByText("✗").first()).toBeVisible();

    // Chosen-option contract: the picked "London" row carries the red TINT
    // (bg-destructive/10 + border-destructive/30), its circle badge ✕, and the
    // trailing wrong-choice marker ✕ — scoped to the option row, not the
    // question pill.
    const q2Chosen = q2.locator("li").filter({ hasText: "London" });
    await expect(q2Chosen).toHaveCount(1);
    await expect(q2Chosen).toHaveClass(/bg-destructive\/10/);
    await expect(q2Chosen).toHaveClass(/border-destructive\/30/);
    await expect(q2Chosen.getByText("\u2715")).toBeVisible();

    // Sanity: the correct answer text appears in Q2's options list too.
    await expect(q2.getByText("Paris", { exact: true })).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
