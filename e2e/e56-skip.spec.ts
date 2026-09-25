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
 * E-56 — the skip flow and the EndScreen golden (v4.9).
 *
 * A skip is an ANSWER, not an absence: it writes a graded 0 row so
 * `allAnswered` advances and `goNext` works, and the DB's
 * `session_answers_skip_shape` guarantees it carries no answer payload.
 *
 * The DENOMINATOR is the subtle part. A skipped question is RESOLVED (it has
 * a final mark of 0), so it stays in the denominator — a student who answers
 * 1 of 2 and skips the other scores 1/2, not 1/1. Rendering 1/1 would read
 * as a perfect score.
 */

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

test.describe("E-56 — skip flow", () => {
  test("a skipped question scores 0, keeps the denominator, and resumes as Skipped", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(300_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const CLASS_TITLE = `E56 Class ${TEST_TIMESTAMP}`;
    const QUIZ_TITLE = `E56 Skip ${TEST_TIMESTAMP}`;
    const Q1 = `E56 answer me ${TEST_TIMESTAMP}`;
    const Q2 = `E56 skip me ${TEST_TIMESTAMP}`;

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(
      lecturerPage,
      `lecturer-e56-${TEST_TIMESTAMP}@innovision.test`,
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
        { prompt: Q1, options: ["Red", "Blue"], correctIndex: 0 },
        { prompt: Q2, options: ["Up", "Down"], correctIndex: 1 },
      ],
    });

    await registerUser(
      studentPage,
      `student-e56-${TEST_TIMESTAMP}@innovision.test`,
      "student",
      LECTURER_INVITE_CODE,
    );
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await startQuizByTitle(studentPage, QUIZ_TITLE);
    await expect(studentPage).toHaveURL(/\/play\//);
    const sessionId = /\/play\/([0-9a-f-]{36})/.exec(studentPage.url())?.[1];
    expect(sessionId).toBeTruthy();

    // Q1: answer correctly. Q2: skip.
    await studentPage.getByRole("button", { name: /^A\b/ }).first().click();
    await studentPage.getByRole("button", { name: /next|finish/i }).first().click();
    await expect(studentPage.getByText(Q2, { exact: true })).toBeVisible();

    const skip = studentPage.getByTestId("skip-question");
    await expect(skip, "Skip must be offered on an unanswered question").toBeVisible();
    await skip.click();

    // The Skipped chip, and never the Incorrect verdict.
    await expect(studentPage.getByText("Skipped", { exact: true })).toBeVisible();
    await expect(studentPage.getByText("Incorrect ✗")).toHaveCount(0);

    // Skip must NOT be offered once the question is answered (R15: question
    // phase only — a skip is itself an answer, so re-offering it would invite
    // an already_answered 409).
    await expect(studentPage.getByTestId("skip-question")).toHaveCount(0);

    // Both answered → the feedback button is Finish and submits.
    await studentPage.getByRole("button", { name: /next|finish/i }).first().click();
    await expect(
      studentPage.locator("p:visible", { hasText: /Assessment submitted|Assessment complete/i }),
    ).toBeVisible({ timeout: 20_000 });

    // ── The persisted skip row ────────────────────────────────────────
    const admin = resolveServiceClient();
    if (!admin) throw new Error("service-role seam unavailable");
    const { data: rows } = await admin
      .from("session_answers")
      .select("question_id, skipped, mark_status, mark_score, is_correct, selected_index")
      .eq("session_id", sessionId!);
    expect(rows?.length, "both questions must have an answer row").toBe(2);

    const skippedRow = rows?.find((r) => r.skipped === true);
    expect(skippedRow, "the skipped row must persist skipped=true").toBeTruthy();
    expect(skippedRow?.mark_status).toBe("marked");
    expect(Number(skippedRow?.mark_score)).toBe(0);
    expect(skippedRow?.is_correct).toBe(false);
    // session_answers_skip_shape: a skip carries NO answer payload.
    expect(skippedRow?.selected_index).toBeNull();

    // Score = 1 (correct Q1) + 0 (skipped Q2) = 1, denominator 2.
    const { data: sessions } = await admin
      .from("quiz_sessions")
      .select("score, status")
      .eq("id", sessionId!);
    expect(sessions?.[0]?.status).toBe("completed");
    expect(Number(sessions?.[0]?.score)).toBe(1);

    // ── EndScreen golden ──────────────────────────────────────────────
    await revealQuiz(lecturerPage, CLASS_TITLE, QUIZ_TITLE);
    await studentPage.reload();

    // The denominator counts the skip: 1 of 2, NOT 1 of 1. The score renders
    // twice (mobile ScoreRing + desktop panel) with only one displayed per
    // viewport, so filter to the visible instance.
    const denominator = studentPage.locator("text=/ 2").locator("visible=true").first();
    await expect(denominator).toBeVisible({ timeout: 20_000 });
    // A pending-EXCLUDED denominator would read "/ 1" — the failure mode this
    // assertion exists to catch.
    await expect(studentPage.locator("text=/ 1").locator("visible=true")).toHaveCount(0);

    // The skipped row in the breakdown reads the EndScreen's skip label
    // (`play.end.skippedRow` = "Skipped — counted as 0"), NOT the in-play
    // chip's shorter "Skipped" — and crucially NOT a red ✗.
    const breakdownSkip = studentPage
      .getByText(/Skipped — counted as 0/)
      .locator("visible=true")
      .first();
    await expect(breakdownSkip).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
