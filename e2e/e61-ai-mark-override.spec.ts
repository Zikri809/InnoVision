import { test, expect, type Page } from "@playwright/test";
import {
  registerUser,
  createClass,
  createQuizWithQuestions,
  startQuizByTitle,
  joinClass,
  revealQuiz,
  openResults,
  resolveServiceClient,
} from "./helpers";

/**
 * E-61 — the lecturer's AI-mark ADJUDICATION journey through the session
 * detail UI (v4.9 / audit-4 D-30 / 0058).
 *
 * E55 drives the marking pipeline RPCs directly and never opens the UI this
 * spec covers: `/results/[sessionId]` renders every answered row with an
 * "Adjust mark" affordance, and the override dialog (frozen testid
 * `override-mark-dialog`) POSTs `/api/sessions/[id]/override`, whose RPC
 * (`override_answer_mark`, 0058) writes the mark, flips `is_correct` at the
 * 0.5 threshold, bumps the L8 override epoch, recomputes the D10 SUM, and
 * un-publishes a revealed quiz (C6/L1) so students never see a stale score.
 *
 * What it pins through the REAL UI:
 *   * a marked short_text row shows the "0.5 / 1" value chip and the AI
 *     rationale as PLAIN TEXT (S7); the "Adjust mark" affordance is offered
 *   * validation: saving with NO mark selected and a <5-char reason are
 *     refused inline ("Choose 0, 0.5 or 1." / "Give a reason of at least 5
 *     characters.") with NO POST issued (client guard before fetch)
 *   * a 0.5 → 1 adjudication lands: the value chip updates, the score
 *     recomputes (D10 SUM: 1 + 1 = 2/2), and the row flips to ✓
 *   * the C6/L1 re-publish contract: reveal first, then override → the quiz
 *     un-publishes (student's card flips from "View results" back to
 *     "Awaiting results") and the dialog warns BEFORE the save
 *
 * The exceeding-max arm (mark_exceeds_max) is unreachable through the UI —
 * the ladder tops out at 1 = max_score — and stays pinned by the route unit
 * test (override-route.test.ts); noted here so the omission is auditable.
 */

const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

/**
 * Re-stamped for EVERY attempt (beforeEach), so a Playwright RETRY mints
 * fresh titles/prompts/emails instead of colliding with the rows its first
 * attempt already created (duplicate class titles strict-mode-violate the
 * title clicks; duplicate emails would need the sign-in recovery path).
 */
let TEST_TIMESTAMP = Date.now();
test.beforeEach(() => {
  TEST_TIMESTAMP = Date.now();
});

/** Claim + finalize ONE pending ledger row (E55's helper, verbatim). */
async function markPendingAnswers(
  sessionId: string,
  questionId: string,
  mark: { score: number; confidence: number; rationale: string },
) {
  const admin = resolveServiceClient();
  if (!admin) throw new Error("service-role seam unavailable");

  const claimToken = crypto.randomUUID();
  const { data: claimed, error: claimErr } = await admin
    .from("ai_marking_ledger")
    .update({
      status: "marking",
      claim_token: claimToken,
      claimed_at: new Date().toISOString(),
    })
    .eq("session_id", sessionId)
    .eq("question_id", questionId)
    .select("id, session_id, question_id, attempt_version")
    .maybeSingle();
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  if (!claimed) throw new Error("no ledger row to claim for this session/question");

  const { data: fin, error: finErr } = await admin.rpc("finalize_ai_mark", {
    p_rows: [
      {
        ledger_id: claimed.id,
        session_id: claimed.session_id,
        question_id: claimed.question_id,
        attempt_version: claimed.attempt_version,
        claim_token: claimToken,
        ok: true,
        score: mark.score,
        confidence: mark.confidence,
        rationale: mark.rationale,
        tokens: 120,
        usd: 0.001,
      },
    ],
  });
  if (finErr) throw new Error(`finalize_ai_mark failed: ${finErr.message}`);
  return fin as { applied?: number; discarded?: number } | null;
}

/** Look up the short_text question id of the seeded quiz (service-role). */
async function shortTextQuestionId(quizTitle: string) {
  const admin = resolveServiceClient();
  if (!admin) throw new Error("service-role seam unavailable");
  const { data: quizRow } = await admin
    .from("quizzes")
    .select("id")
    .eq("title", quizTitle)
    .maybeSingle();
  if (!quizRow) throw new Error("quiz row not found");
  const { data: qRow } = await admin
    .from("questions")
    .select("id")
    .eq("quiz_id", quizRow.id)
    .eq("type", "short_text")
    .maybeSingle();
  if (!qRow) throw new Error("short_text question not found");
  return qRow.id as string;
}

/**
 * Open the session-detail drill-in for the (single) session of a quiz: the
 * dashboard row's "View Answers" link (e25 pattern).
 */
async function openSessionDetail(
  page: Page,
  classTitle: string,
  quizTitle: string,
) {
  await openResults(page, classTitle, quizTitle);
  const viewAnswers = page.getByRole("link", { name: /view answers/i }).first();
  await expect(viewAnswers).toBeVisible({ timeout: 15_000 });
  await viewAnswers.click();
  await page.waitForURL(/\/results\/[0-9a-f-]+$/);
}

/** Open the dialog for the row with `promptText` and return the dialog locator. */
function openDialog(page: Page, promptText: string) {
  const row = page.locator("li").filter({ hasText: promptText });
  return row
    .getByRole("button", { name: "Adjust mark", exact: true })
    .click()
    .then(() => page.getByTestId("override-mark-dialog"));
}

/** Select a rung on the mark ladder. Base UI radios: CLICK the role=radio. */
async function pickMark(dialog: ReturnType<Page["getByTestId"]>, mark: string) {
  await dialog.getByRole("radio", { name: mark, exact: true }).click();
}

test.describe("E-61 — AI-mark override journey", () => {
  test("marked row → dialog validation → 0.5→1 adjudication recomputes the score", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(300_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const CLASS_TITLE = `E61 Class ${TEST_TIMESTAMP}`;
    const QUIZ_TITLE = `E61 Override ${TEST_TIMESTAMP}`;
    const TEXT_PROMPT = `E61 explain ${TEST_TIMESTAMP}`;
    const MCQ_PROMPT = `E61 pick ${TEST_TIMESTAMP}`;

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(
      lecturerPage,
      `lecturer-e61-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      mode: "assessment",
      publish: true,
      gesturesOff: true,
      questions: [
        {
          type: "short_text" as const,
          prompt: TEXT_PROMPT,
          options: [],
          answerKey: "Mentions chlorophyll and light.",
        },
        { prompt: MCQ_PROMPT, options: ["Red", "Blue"], correctIndex: 0 },
      ],
    });

    await registerUser(
      studentPage,
      `student-e61-${TEST_TIMESTAMP}@innovision.test`,
      "student",
      LECTURER_INVITE_CODE,
    );
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await startQuizByTitle(studentPage, QUIZ_TITLE);
    await expect(studentPage).toHaveURL(/\/play\//);
    const sessionId = /\/play\/([0-9a-f-]{36})/.exec(studentPage.url())?.[1];
    expect(sessionId, "the play URL must carry the session id").toBeTruthy();

    // Answer BOTH questions: the short_text queues marking; the MCQ (option
    // A = correct) scores immediately. The feedback button IS Finish once
    // every question is answered (goNext submits).
    await studentPage.getByTestId("short-text-input").fill("Chlorophyll absorbs light.");
    await studentPage.getByRole("button", { name: "Submit answer" }).click();
    await studentPage.getByRole("button", { name: /next|finish/i }).first().click();
    await expect(studentPage.getByText(MCQ_PROMPT, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /^A\b/ }).first().click();
    await studentPage.getByRole("button", { name: /next|finish/i }).first().click();
    await expect(
      studentPage.locator("p:visible", { hasText: /Assessment submitted|Assessment complete/i }),
    ).toBeVisible({ timeout: 20_000 });

    // Resolve the pipeline with a 0.5 mark (claims + finalizes directly, as
    // E55 does) so the lecturer UI has a marked-but-low row to adjudicate.
    const textQuestionId = await shortTextQuestionId(QUIZ_TITLE);
    const finalize = await markPendingAnswers(sessionId!, textQuestionId, {
      score: 0.5,
      confidence: 0.9,
      rationale: "Partial credit from the AI.",
    });
    expect(finalize?.applied).toBe(1);

    await openSessionDetail(lecturerPage, CLASS_TITLE, QUIZ_TITLE);

    // The marked short_text row: the 0.5 value chip and the S7 rationale.
    const textRow = lecturerPage.locator("li").filter({ hasText: TEXT_PROMPT });
    await expect(textRow.getByText("0.5 / 1")).toBeVisible();
    await expect(textRow.getByText("Partial credit from the AI.")).toBeVisible();

    // ── Dialog validation (no POST may fire) ──────────────────────────
    // The MCQ row's answer was auto-marked by is_correct (mark_score NULL),
    // so its dialog opens with NO rung selected — the invalid-mark arm.
    let overridePosts = 0;
    const countOverride = (req: { url(): string; method(): string }) => {
      if (req.url().includes("/override") && req.method() === "POST") overridePosts += 1;
    };
    lecturerPage.on("request", countOverride);

    const mcqDialog = await openDialog(lecturerPage, MCQ_PROMPT);
    await expect(mcqDialog).toBeVisible();
    // No mark selected → inline invalid_mark; the dialog stays.
    await mcqDialog.getByLabel(/Reason/i).fill("Valid reason text");
    await mcqDialog.getByRole("button", { name: /^save$/i }).click();
    await expect(mcqDialog.getByText("Choose 0, 0.5 or 1.")).toBeVisible();
    // Reason too short → the reasonTooShort arm.
    await pickMark(mcqDialog, "1");
    await mcqDialog.getByLabel(/Reason/i).fill("no");
    await mcqDialog.getByRole("button", { name: /^save$/i }).click();
    await expect(mcqDialog.getByText("Give a reason of at least 5 characters.")).toBeVisible();
    await mcqDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(mcqDialog).toBeHidden();
    expect(overridePosts, "validation arms must stay client-side").toBe(0);
    lecturerPage.off("request", countOverride);

    // ── The 0.5 → 1 adjudication through the dialog ───────────────────
    const dialog = await openDialog(lecturerPage, TEXT_PROMPT);
    await expect(dialog).toBeVisible();
    await pickMark(dialog, "1");
    await dialog.getByLabel(/Reason/i).fill("Rubric fully met — the AI was too harsh.");
    await dialog.getByRole("button", { name: /^save$/i }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(lecturerPage.getByText("Mark updated")).toBeVisible();

    // router.refresh() re-renders the RSC: the value chip, the flipped
    // verdict, and the recomputed D10 SUM (1 mcq + 1 overridden = 2/2).
    await expect(textRow.getByText("1 / 1")).toBeVisible({ timeout: 15_000 });
    const hero = lecturerPage
      .locator("main section")
      .filter({ has: lecturerPage.locator("h1") })
      .first();
    await expect(hero.locator("span.font-heading.text-\\[26px\\]").first()).toHaveText("2");
    await expect(hero.getByText(/\/\s*2/)).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("revealed quiz: the dialog warns, the override un-publishes, student sees awaiting", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(300_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const CLASS_TITLE = `E61b Class ${TEST_TIMESTAMP}`;
    // NOTE: the title must not contain "publish" — the builder's
    // "Duplicate quiz <title>" button carries the title in its aria-label,
    // so a /publish/i match resolves to two elements (helpers.ts:455).
    const QUIZ_TITLE = `E61b Adjudicate ${TEST_TIMESTAMP}`;
    const TEXT_PROMPT = `E61b explain ${TEST_TIMESTAMP}`;
    const MCQ_PROMPT = `E61b pick ${TEST_TIMESTAMP}`;

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(
      lecturerPage,
      `lecturer-e61b-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      mode: "assessment",
      publish: true,
      gesturesOff: true,
      questions: [
        {
          type: "short_text" as const,
          prompt: TEXT_PROMPT,
          options: [],
          answerKey: "Any defensible answer.",
        },
        // The MCQ key is B — the student picks A (wrong) so the override
        // alone drives the visible score change.
        { prompt: MCQ_PROMPT, options: ["Red", "Blue"], correctIndex: 1 },
      ],
    });

    await registerUser(
      studentPage,
      `student-e61b-${TEST_TIMESTAMP}@innovision.test`,
      "student",
      LECTURER_INVITE_CODE,
    );
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await startQuizByTitle(studentPage, QUIZ_TITLE);
    await expect(studentPage).toHaveURL(/\/play\//);
    const sessionId = /\/play\/([0-9a-f-]{36})/.exec(studentPage.url())?.[1];
    expect(sessionId).toBeTruthy();
    await studentPage.getByTestId("short-text-input").fill("A solid answer.");
    await studentPage.getByRole("button", { name: "Submit answer" }).click();
    await studentPage.getByRole("button", { name: /next|finish/i }).first().click();
    await expect(studentPage.getByText(MCQ_PROMPT, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /^A\b/ }).first().click();
    await studentPage.getByRole("button", { name: /next|finish/i }).first().click();
    await expect(
      studentPage.locator("p:visible", { hasText: /Assessment submitted|Assessment complete/i }),
    ).toBeVisible({ timeout: 20_000 });

    // Mark the short_text 1 (confidence 0.9 → plain marked).
    const textQuestionId = await shortTextQuestionId(QUIZ_TITLE);
    const finalize = await markPendingAnswers(sessionId!, textQuestionId, {
      score: 1,
      confidence: 0.9,
      rationale: "Clear, correct answer.",
    });
    expect(finalize?.applied).toBe(1);

    // Reveal FIRST — the override must then un-publish (C6/L1). The
    // revealed state is observable as the "View results" card link (e40) —
    // navigate to the LIST, not reload (the student sits on the /play
    // EndScreen, which carries no list card).
    await revealQuiz(lecturerPage, CLASS_TITLE, QUIZ_TITLE);
    await studentPage.goto("/student/quizzes");
    await expect(
      studentPage.getByRole("link", { name: /view results/i }),
    ).toBeVisible({ timeout: 20_000 });

    await openSessionDetail(lecturerPage, CLASS_TITLE, QUIZ_TITLE);
    const dialog = await openDialog(lecturerPage, TEXT_PROMPT);
    // The republish warning renders BEFORE any save (results_revealed_at is
    // non-null at render time).
    await expect(
      dialog.getByText(/Results were already released|Re-publish them/i),
    ).toBeVisible();

    // Downgrade 1 → 0.5 with a reason; the save goes through.
    await pickMark(dialog, "0.5");
    await dialog.getByLabel(/Reason/i).fill("Half credit after re-reading.");
    await dialog.getByRole("button", { name: /^save$/i }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // C6/L1: the reveal was revoked — the list card flips back to the
    // disabled awaiting chip (the list is an RSC; re-navigate, no live push).
    const textRow = lecturerPage.locator("li").filter({ hasText: TEXT_PROMPT });
    await expect(textRow.getByText("0.5 / 1")).toBeVisible({ timeout: 15_000 });
    await studentPage.goto("/student/quizzes");
    await expect(studentPage.getByRole("link", { name: /view results/i })).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(
      studentPage.getByText(/awaiting results/i).first(),
    ).toBeVisible({ timeout: 20_000 });

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
