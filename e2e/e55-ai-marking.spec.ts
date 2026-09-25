import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  createQuizWithQuestions,
  startQuizByTitle,
  joinClass,
  revealQuiz,
  resolveServiceClient,
} from "./helpers";

/**
 * E-55 — the AI marking pipeline end to end (v4.9).
 *
 * The two-phase sweep is the load-bearing design: `sweep_ai_marks()` CLAIMS
 * (minting a claim_token), the TS worker does the model call outside any
 * transaction, and `finalize_ai_mark()` writes under an epoch + token guard.
 * This spec drives those RPCs directly with the service-role client, which is
 * the only honest way to test the pipeline without a live model.
 *
 * What it pins:
 *   * a short_text answer lands PENDING and the student sees the banner
 *   * resolving it flips the banner to the "waiting for release" state —
 *     NOT to a revealed score (the quiz is not revealed by one student's
 *     marks resolving)
 *   * a 0.5 mark survives as 0.5. This is the whole reason
 *     `quiz_sessions.score` became NUMERIC (0053): an int4 target rounds
 *     0.5+1.0 to 2, silently corrupting the recompute D10 protects.
 *   * confidence < 0.55 routes to needs_review but the score STANDS
 *   * the score recompute uses the D10 SUM (pending contributes 0)
 */

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

type ClaimRow = {
  ledger_id: string;
  session_id: string;
  question_id: string;
  attempt_version: number;
  quiz_id: string;
};

/**
 * Claim and finalize ONE session's queued ledger row, with the supplied mark.
 *
 * `sweep_ai_marks()` is deliberately GLOBAL — one cron, one sweep, every
 * claimable row — which is right for production but unusable from a spec
 * running under `fullyParallel`: a concurrent spec's sweep claims OUR row
 * first (SKIP LOCKED hands it to whoever asks first), and its own helper
 * finalizes only ITS rows, so ours would sit `marking` until the 5-minute
 * lease expired.
 *
 * So this helper performs the two phases directly on its own row, which is
 * exactly what the sweep + worker pair do between them:
 *   phase 1  claim   — status='marking', a fresh claim_token, attempts+1
 *   phase 3  finalize — `finalize_ai_mark` under that token
 * The RPCs themselves are unchanged; the spec just does not depend on which
 * worker won the race for a row it does not own.
 */
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

test.describe("E-55 — AI marking pipeline", () => {
  test("pending → marked → banner states, with a 0.5 mark surviving as 0.5", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(300_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const CLASS_TITLE = `E55 Class ${TEST_TIMESTAMP}`;
    const QUIZ_TITLE = `E55 AiMark ${TEST_TIMESTAMP}`;
    const TEXT_PROMPT = `E55 explain ${TEST_TIMESTAMP}`;
    const MCQ_PROMPT = `E55 pick ${TEST_TIMESTAMP}`;

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(
      lecturerPage,
      `lecturer-e55-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      // Assessment: the short_text pending/AI-marking path exists ONLY here.
      // In practice the RPC records needs_review and never marks (no spend
      // budget), so a practice quiz would show no pending banner at all.
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
      `student-e55-${TEST_TIMESTAMP}@innovision.test`,
      "student",
      LECTURER_INVITE_CODE,
    );
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await startQuizByTitle(studentPage, QUIZ_TITLE);
    await expect(studentPage).toHaveURL(/\/play\//);
    const sessionId = /\/play\/([0-9a-f-]{36})/.exec(studentPage.url())?.[1];
    expect(sessionId, "the play URL must carry the session id").toBeTruthy();

    // Answer BOTH: the short_text (which queues marking) and the mcq (which
    // scores immediately) — the 1.5 total is the arithmetic under test.
    await studentPage.getByTestId("short-text-input").fill("Chlorophyll absorbs light.");
    await studentPage.getByRole("button", { name: "Submit answer" }).click();
    await studentPage.getByRole("button", { name: /next|finish/i }).first().click();
    await expect(studentPage.getByText(MCQ_PROMPT, { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /^A\b/ }).first().click();
    // The feedback button IS Finish once every question is answered
    // (goNext submits when allAnswered), so this one click submits.
    await studentPage.getByRole("button", { name: /next|finish/i }).first().click();
    await expect(
      studentPage.locator("p:visible", { hasText: /Assessment submitted|Assessment complete/i }),
    ).toBeVisible({ timeout: 20_000 });

    // ── State (a): the pending banner ─────────────────────────────────
    // The banner sits under the score block, below the fold at this viewport,
    // so scroll it in before asserting visibility.
    //
    // The copy is asserted as a DISJUNCTION of the two legitimate states: a
    // concurrent spec's sweep may claim and resolve this row before we look
    // (the sweep is deliberately global), which legitimately advances the
    // banner to state (b). What must NEVER appear is no banner at all, or the
    // resultsPending copy that only a REVEALED quiz shows.
    const banner = studentPage.getByTestId("pending-banner");
    await banner.scrollIntoViewIfNeeded();
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText(/still being marked|Marks finalised/i);
    // The quiz is NOT revealed — a pending answer must never auto-reveal.
    await expect(banner).not.toContainText(/released by your lecturer/i);

    // ── Resolve with a 0.5 mark ───────────────────────────────────────
    const admin = resolveServiceClient();
    if (!admin) throw new Error("service-role seam unavailable");
    const { data: quizRow } = await admin
      .from("quizzes")
      .select("id")
      .eq("title", QUIZ_TITLE)
      .maybeSingle();
    if (!quizRow) throw new Error("quiz row not found");
    const { data: qRow } = await admin
      .from("questions")
      .select("id")
      .eq("quiz_id", quizRow.id)
      .eq("type", "short_text")
      .maybeSingle();
    if (!qRow) throw new Error("short_text question not found");
    const textQuestionId = qRow.id as string;

    const finalize = await markPendingAnswers(sessionId!, textQuestionId, {
      score: 0.5,
      confidence: 0.9,
      rationale: "Partial credit.",
    });
    expect(finalize?.applied, "the finalizer must apply the claimed row").toBe(1);

    // ── The NUMERIC proof ─────────────────────────────────────────────
    const { data: sessionRows } = await admin
      .from("quiz_sessions")
      .select("id, score")
      .eq("quiz_id", quizRow.id);
    const session = sessionRows?.[0];
    if (!session) throw new Error("session row not found");
    // 1 (mcq correct) + 0.5 (half mark) = 1.5. An int4 column would read 2.
    expect(
      Number(session.score),
      "the 0.5 mark must survive the recompute (int4 would round 1.5 to 2)",
    ).toBe(1.5);

    // ── State (b): marks finalised, awaiting release ──────────────────
    await studentPage.reload();
    await banner.scrollIntoViewIfNeeded();
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText(/Marks finalised|waiting for your lecturer/i);

    // ── Reveal → the score is now visible with the resolved denominator
    await revealQuiz(lecturerPage, CLASS_TITLE, QUIZ_TITLE);
    await studentPage.reload();
    // The score renders TWICE (the mobile ScoreRing and the desktop panel) —
    // only one is displayed at a given viewport, so filter to the visible
    // instance rather than taking .first() (which may be the hidden one).
    const scoreEl = studentPage.locator("text=1.5").locator("visible=true").first();
    await expect(scoreEl).toBeVisible({ timeout: 20_000 });
    // The resolved denominator: 2 questions, 1.5 scored (1 + the 0.5 half
    // mark). A pending-excluded denominator would read "/ 1".
    await expect(studentPage.getByText("/ 2").locator("visible=true").first()).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("low confidence routes to needs_review but the score stands", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(300_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const CLASS_TITLE = `E55b Class ${TEST_TIMESTAMP}`;
    const QUIZ_TITLE = `E55b NeedsReview ${TEST_TIMESTAMP}`;
    const TEXT_PROMPT = `E55b explain ${TEST_TIMESTAMP}`;

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(
      lecturerPage,
      `lecturer-e55b-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);
    await createQuizWithQuestions(lecturerPage, {
      classTitle: CLASS_TITLE,
      quizTitle: QUIZ_TITLE,
      // Assessment: the short_text pending/AI-marking path exists ONLY here.
      // In practice the RPC records needs_review and never marks (no spend
      // budget), so a practice quiz would show no pending banner at all.
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
      ],
    });

    await registerUser(
      studentPage,
      `student-e55b-${TEST_TIMESTAMP}@innovision.test`,
      "student",
      LECTURER_INVITE_CODE,
    );
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await startQuizByTitle(studentPage, QUIZ_TITLE);
    await expect(studentPage).toHaveURL(/\/play\//);
    const sessionId = /\/play\/([0-9a-f-]{36})/.exec(studentPage.url())?.[1];
    expect(sessionId, "the play URL must carry the session id").toBeTruthy();

    await studentPage.getByTestId("short-text-input").fill("A shaky answer.");
    await studentPage.getByRole("button", { name: "Submit answer" }).click();
    // Single-question quiz: the feedback button is Finish and submits.
    await studentPage.getByRole("button", { name: /next|finish/i }).first().click();
    const pendingBanner = studentPage.getByTestId("pending-banner");
    await pendingBanner.scrollIntoViewIfNeeded();
    await expect(pendingBanner).toBeVisible({ timeout: 20_000 });

    const admin = resolveServiceClient();
    if (!admin) throw new Error("service-role seam unavailable");
    const { data: quizRow } = await admin
      .from("quizzes")
      .select("id")
      .eq("title", QUIZ_TITLE)
      .maybeSingle();
    if (!quizRow) throw new Error("quiz row not found");
    const { data: qRow } = await admin
      .from("questions")
      .select("id")
      .eq("quiz_id", quizRow.id)
      .maybeSingle();
    if (!qRow) throw new Error("short_text question not found");

    // confidence 0.3 < 0.55 → needs_review, but score 1 stands.
    const finalize = await markPendingAnswers(sessionId!, qRow.id as string, {
      score: 1,
      confidence: 0.3,
      rationale: "Unsure, but looks right.",
    });
    expect(finalize?.applied).toBe(1);
    const { data: ansRows } = await admin
      .from("session_answers")
      .select("mark_status, mark_score")
      .eq("question_id", (
        await admin
          .from("questions")
          .select("id")
          .eq("quiz_id", quizRow!.id)
          .maybeSingle()
      ).data!.id);
    const answer = ansRows?.[0];
    expect(answer?.mark_status).toBe("needs_review");
    expect(Number(answer?.mark_score)).toBe(1);

    // Reveal → the EndScreen surfaces the needs-review row.
    await revealQuiz(lecturerPage, CLASS_TITLE, QUIZ_TITLE);
    await studentPage.reload();
    const reviewRow = studentPage.getByTestId("needs-review-row").first();
    await reviewRow.scrollIntoViewIfNeeded();
    await expect(reviewRow).toBeVisible({ timeout: 20_000 });

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
