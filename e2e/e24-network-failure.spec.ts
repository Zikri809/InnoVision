import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  joinClass,
  createQuizWithQuestions,
} from "./helpers";

/**
 * E24 — Network-failure UX (route.abort = real offline shape, not a 500).
 * Three retry contracts that no prior spec exercises:
 *  1. Answer POST aborts mid-exam → inline recordTimeout copy, phase returns
 *     to `question`, the SAME option re-click records exactly one ack and
 *     reaches feedback (play-client AbortError branch; endpoints idempotent).
 *  2. Final submit aborts on the last question → submitTimeout/submitError
 *     copy, phase back to `question`; retry goes through the RESUME path
 *     (reload seeds all-answered → boots in `feedback`) and lands on
 *     Practice complete.
 *  3. AI generate aborts → inline role=alert failure in the dialog (only
 *     success toasts), dialog stays interactive (Generate re-enabled) so
 *     the student can simply retry.
 */

const stamp = Date.now();
const LECTURER_EMAIL = `lecturer-e24-${stamp}@innovision.test`;
const STUDENT_EMAIL = `student-e24-${stamp}@innovision.test`;
const SELF_EMAIL = `self-e24-${stamp}@innovision.test`;
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";

test.describe.configure({ mode: "serial" });

test.describe("E24 — network failure UX", () => {
  test("aborted answer POST → timeout notice → same-option retry records once", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!INVITE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", INVITE);
    const joinCode = await createClass(lecturerPage, "E24 Offline");
    // PRACTICE quiz (no face gate) with an explanation for feedback proof.
    await createQuizWithQuestions(lecturerPage, {
      classTitle: "E24 Offline",
      quizTitle: "E24 Retry Answer",
      questions: [
        { prompt: "Offline probe?", options: ["Paris", "London"], correctIndex: 0 },
      ],
      publish: true,
    });

    await registerUser(studentPage, STUDENT_EMAIL, "student", INVITE);
    await joinClass(studentPage, joinCode, "E24 Offline");
    await studentPage.goto("/student/quizzes");
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await expect(studentPage.getByText("Offline probe?", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // Drop the connection EXACTLY while recording the answer.
    const abortAnswer = studentPage.waitForEvent("requestfailed");
    await studentPage.route("**/api/sessions/*/answer", (r) => r.abort("internetdisconnected"));
    await studentPage.getByRole("button", { name: /Paris/i }).click();

    // Inline retry copy appears (toast.recordTimeout OR toast.recordError —
    // route.abort surfaces as TypeError→recordError, AbortController as
    // recordTimeout), phase returns to question.
    await expect(
      studentPage.getByText(/(timed out|network error).*tap .*again to retry/i),
    ).toBeVisible({ timeout: 15_000 });
    await expect(abortAnswer).toBeTruthy(); // the request really died offline

    // Connectivity returns → the SAME option click records and reaches feedback.
    await studentPage.unroute("**/api/sessions/*/answer");
    await studentPage.getByRole("button", { name: /Paris/i }).click();
    await expect(studentPage.getByText(/correct/i)).toBeVisible({ timeout: 10_000 });
    // No duplicate-question corruption: exactly one probe row remains in play.
    await expect(studentPage.getByText("Offline probe?", { exact: true })).toHaveCount(1);

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("aborted final submit → submitTimeout → Next retries to completion", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!INVITE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(lecturerPage, `${LECTURER_EMAIL}x`, "lecturer", INVITE);
    const joinCode = await createClass(lecturerPage, "E24 Offline Submit");
    await createQuizWithQuestions(lecturerPage, {
      classTitle: "E24 Offline Submit",
      quizTitle: "E24 Retry Submit",
      questions: [{ prompt: "Single shot?", options: ["yes", "no"], correctIndex: 0 }],
      publish: true,
    });

    await registerUser(studentPage, STUDENT_EMAIL, "student", INVITE);
    // Inline join (NOT helpers.joinClass): this spec reuses STUDENT_EMAIL from
    // test 1, so /student/classes already lists "E24 Offline" and ALSO renders
    // the dashed "Join a class" card — the helper's loose /join/i locator then
    // strict-mode-violates. "Join class" exact is unambiguous.
    await studentPage.getByLabel("Join code").fill(joinCode);
    await studentPage.getByRole("button", { name: "Join class", exact: true }).click();
    await expect(studentPage.getByText("E24 Offline Submit", { exact: true })).toBeVisible();
    await studentPage.goto("/student/quizzes");
    // Scope Start to THIS test's card: STUDENT_EMAIL already holds "E24 Retry
    // Answer" from test 1, so a bare Start click would strict-mode-violate.
    await studentPage
      .getByRole("listitem")
      .filter({ hasText: "E24 Retry Submit" })
      .getByRole("button", { name: "Start", exact: true })
      .click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);
    await expect(studentPage.getByText("Single shot?", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // Exactly one question: the FIRST Next/Finish must fire the final submit.
    await expect(studentPage.getByText("Q 1/1")).toBeVisible();

    // Answer the only question → feedback → Next fires the FINAL submit.
    await studentPage.route("**/api/sessions/*/submit", (r) => r.abort("internetdisconnected"));
    await studentPage.getByRole("button", { name: /yes/i }).click();
    await expect(studentPage.getByText(/correct/i)).toBeVisible({ timeout: 10_000 });
    const failedSubmit = studentPage.waitForEvent("requestfailed");
    // One question → the feedback button label is Finish, not Next. Anchor
    // strictly: the unanchored /next/i ALSO matches the Next.js dev-tools
    // overlay button ("Open Next.js Dev Tools") and silently steals the click.
    await studentPage.getByRole("button", { name: /^(finish|next)$/i }).click();

    // submitTimeout OR submitError surfaces; phase returned to question —
    // nothing is lost.
    await expect(
      studentPage.getByText(/timed out.*submit again|network error submitting/i),
    ).toBeVisible({ timeout: 15_000 });
    await failedSubmit;

    // Retry once connectivity returns → end screen. In-question Next is
    // unreachable after a failed submit (phase=question renders no Next and
    // the answered option is inert), so recovery goes through the app's
    // RESUME path: a reload seeds all-answered → firstUnansweredIndex=-1 →
    // the client boots straight into `feedback`, where Finish re-submits.
    await studentPage.unroute("**/api/sessions/*/submit");
    await studentPage.reload();
    await expect(studentPage.getByText("Single shot?", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await studentPage.getByRole("button", { name: /^(finish|next)$/i }).click();
    await expect(studentPage.getByText(/practice complete|see results/i)).toBeVisible({
      timeout: 20_000,
    });

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("aborted AI generate → failure toast, Generate stays enabled for retry", async ({ page }) => {
    await registerUser(page, SELF_EMAIL, "student", "");

    await page.goto("/student/my-quizzes");
    await page.getByRole("link", { name: /create quiz/i }).click();
    await page.getByLabel("Title").fill(`E24 AI Offline ${stamp}`);
    await page.getByRole("button", { name: /create quiz/i }).click();
    await page.waitForURL(/\/student\/my-quizzes\/[^/]+\/edit/);

    // Open the paste leg (E19 pattern) up to the Generate click.
    await page.getByRole("button", { name: /generate with ai/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel(/paste your material/i)
      .fill(
        "Photosynthesis converts light energy into chemical energy. " +
          "Chlorophyll absorbs sunlight. The Calvin cycle fixes carbon dioxide.",
      );
    await dialog.getByRole("button", { name: /use pasted text/i }).click();
    await expect(dialog.getByText(/difficulty level/i)).toBeVisible();

    // Hard-offline the generate endpoint (abort ≠ e19's happy mock).
    await page.route(/\/api\/student-quizzes\/[\w-]+\/generate$/, (r) =>
      r.abort("internetdisconnected"),
    );
    await dialog.getByRole("button", { name: /generate quiz/i }).click();

    // Inline failure alert (role=alert INSIDE the dialog — generate failures
    // never toast; only success does) + NO rows landed + retry possible.
    await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("ol > li")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /generate quiz/i })).toBeEnabled({
      timeout: 10_000,
    });

    // Recovery: unroute → the same click succeeds against the mock AI.
    await page.unroute(/\/api\/student-quizzes\/[\w-]+\/generate$/);
    await dialog.getByRole("button", { name: /generate quiz/i }).click();
    await expect(
      page.locator("li", { hasText: /velocity/i }).first(),
    ).toBeVisible({ timeout: 45_000 });
  });
});
