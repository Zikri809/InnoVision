import { test, expect, type Page } from "@playwright/test";
import {
  registerUser,
  createClass,
  createQuizWithQuestions,
  joinClass,
} from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

/**
 * E60 — AI generation for gesture-off quizzes (multi_select + short_text).
 *
 * The Next.js server points AI_BASE_URL at e2e/mock-ai-server.mjs, so the
 * real generate/regenerate routes run against deterministic fixtures and the
 * real save RPC (0069 short_text arm) persists them — no real LLM, but a
 * REAL database write. Scenario selection rides stateless [MOCK:…] markers
 * in the pasted source text (parallel-safe); the regenerate rewrite is
 * sniffed from the kept type in the request itself.
 *
 * Edge cases pinned here (unit/pgTAP cover the rest):
 *  1. HAPPY: gesture-off draft + mixed payload → multi + short persist with
 *     the rubric, short regenerates with a rewritten rubric, quiz publishes,
 *     student sees it.
 *  2. GATE: gesture-ON draft + the SAME payload → 422 invalid_ai_output in
 *     the dialog, zero rows written (the placeholder survives).
 *  3. MALFORMED: gesture-off draft + short_text WITHOUT answer_key →
 *     schema retry exhausts → 422, zero rows written (atomicity proof).
 */

const CLEAN_TEXT =
  "Matter is anything with mass and volume. Ice floats because frozen water " +
  "is less dense than liquid water. Prime numbers have exactly two divisors. " +
  "Energy is conserved in closed systems.";

async function pasteAndGenerate(page: Page, text: string) {
  await page.getByRole("button", { name: /generate from file/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /paste notes or study text instead/i }).click();
  await dialog.getByLabel(/paste your material/i).fill(text);
  await dialog.getByRole("button", { name: /continue with text/i }).click();
  await dialog.getByRole("button", { name: /generate quiz/i }).click();
  return dialog;
}

async function setupDraftQuiz(
  page: Page,
  emailPrefix: string,
  classTitle: string,
  quizTitle: string,
  gesturesOff: boolean,
) {
  await registerUser(page, `${emailPrefix}-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
  await expect(page.getByRole("heading", { name: "My Classes" })).toBeVisible();
  const joinCode = await createClass(page, classTitle);
  await createQuizWithQuestions(page, {
    classTitle,
    quizTitle,
    questions: [{ prompt: "Placeholder draft question?", options: ["p1", "p2"] }],
    gesturesOff,
  });
  return joinCode;
}

test.describe("E60 — gesture-off AI generation", () => {
  test("gesture-off draft generates multi + short, rubric persists, short regenerates, publishes", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(240_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const CLASS_TITLE = `E60 Class ${TEST_TIMESTAMP}`;
    const QUIZ_TITLE = `E60 GestureOff Gen ${TEST_TIMESTAMP}`;
    const SHORT_PROMPT = "Why does ice float on water?";
    const SHORT_RUBRIC = "Ice is less dense than liquid water.";
    const MULTI_PROMPT = "Which are prime numbers?";

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const page = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    const joinCode = await setupDraftQuiz(page, "lecturer-e60", CLASS_TITLE, QUIZ_TITLE, true);

    // ── Generate with the gesture-off fixture ──
    const dialog = await pasteAndGenerate(page, `${CLEAN_TEXT} [MOCK:gesture_off]`);
    await expect(
      dialog.getByText(/questions forged|soalan dihasilkan/i),
    ).toBeVisible({ timeout: 30_000 });
    await dialog.getByTestId("generation-review-btn").click();
    await expect(dialog).toHaveCount(0);

    // Replace mode: the placeholder is gone, the generated set persisted
    // through the REAL save RPC (0069 short_text arm).
    await expect(page.getByText("Placeholder draft question?", { exact: true })).toHaveCount(0);
    await expect(page.getByText(MULTI_PROMPT, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(SHORT_PROMPT, { exact: true })).toBeVisible();

    // The rubric persisted — open Edit on the short question's own card
    // (scoped by prompt text, not by button order: the builder has other
    // Edit buttons and the mock order must not be load-bearing).
    const shortCard = page.locator("article", { hasText: SHORT_PROMPT });
    await shortCard.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("heading", { name: /edit question/i })).toBeVisible();
    await expect(page.getByLabel("Answer key / rubric")).toHaveValue(SHORT_RUBRIC);
    await page.getByRole("button", { name: /cancel/i }).click();
    await expect(page.getByRole("heading", { name: /edit question/i })).toHaveCount(0);

    // Regenerate the short question — the mock sniffs the kept type and
    // returns the rubric-carrying rewrite.
    await shortCard.getByRole("button", { name: /regenerate with ai/i }).click();
    await page.getByRole("dialog").getByRole("button", { name: /regenerate with ai/i }).click();
    await expect(
      page.getByText("REPLACED: Why does ice float?", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    // Siblings untouched.
    await expect(page.getByText(MULTI_PROMPT, { exact: true })).toBeVisible();

    // Publish + student visibility.
    const publish = page.getByRole("button", { name: /publish/i });
    await expect(publish).toBeEnabled();
    await publish.click();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();

    await registerUser(studentPage, `student-e60-${TEST_TIMESTAMP}@innovision.test`, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await expect(studentPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("gesture-ON draft rejects the same payload (422, zero rows)", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(240_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const CLASS_TITLE = `E60b Class ${TEST_TIMESTAMP}`;
    const QUIZ_TITLE = `E60b GesturesOn Gen ${TEST_TIMESTAMP}`;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await setupDraftQuiz(page, "lecturer-e60b", CLASS_TITLE, QUIZ_TITLE, false);

    // Same fixture the gesture-off quiz accepts — here the lib-level retry
    // gate must exhaust and the route must 422 with nothing saved.
    const dialog = await pasteAndGenerate(page, `${CLEAN_TEXT} [MOCK:gesture_off]`);
    await expect(
      dialog.getByText(/did not return a valid quiz|tidak memulangkan kuiz yang sah/i),
    ).toBeVisible({ timeout: 60_000 });

    // Atomicity: reload proves SERVER state — the placeholder survives,
    // none of the fixture leaked in (no dialog-dismiss locator guessing).
    await page.reload();
    await expect(page.getByText("Placeholder draft question?", { exact: true })).toBeVisible();
    await expect(page.getByText("Which are prime numbers?", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Why does ice float on water?", { exact: true })).toHaveCount(0);

    await ctx.close();
  });

  test("short_text without answer_key exhausts retry (422, zero rows)", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(240_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const CLASS_TITLE = `E60c Class ${TEST_TIMESTAMP}`;
    const QUIZ_TITLE = `E60c Bad Short ${TEST_TIMESTAMP}`;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await setupDraftQuiz(page, "lecturer-e60c", CLASS_TITLE, QUIZ_TITLE, true);

    // Gesture-off allows the TYPE, but the missing rubric still fails schema
    // validation twice → 422, nothing saved.
    const dialog = await pasteAndGenerate(page, `${CLEAN_TEXT} [MOCK:gesture_off_invalid]`);
    await expect(
      dialog.getByText(/did not return a valid quiz|tidak memulangkan kuiz yang sah/i),
    ).toBeVisible({ timeout: 60_000 });

    await page.reload();
    await expect(page.getByText("Placeholder draft question?", { exact: true })).toBeVisible();
    await expect(page.getByText("Why is the sky blue?", { exact: true })).toHaveCount(0);

    await ctx.close();
  });
});
