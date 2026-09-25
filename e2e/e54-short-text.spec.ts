import { test, expect } from "@playwright/test";
import {
  registerUser,
  createClass,
  createQuizWithQuestions,
  startQuizByTitle,
  joinClass,
  captureAnswerPosts,
  resolveServiceClient,
} from "./helpers";

/**
 * E-54 — short_text authoring, play, and the skip affordance (v4.9).
 *
 * Covers the whole reachability chain the plan's critic rounds kept finding
 * holes in: the type must be AUTHORABLE (schema + builder + edit dialog), the
 * student must be able to TYPE an answer (the B5-1 blocker: every other layer
 * shipped before the widget), and Skip must be a first-class answer.
 *
 * Also pins the wire SHAPE: short_text and skip each send exactly one answer
 * field. The route's Zod arm is shape-exclusivity only (the shared schema
 * cannot see question type), so a stray index alongside `answerText` is the
 * failure mode worth proving is rejected.
 */

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

test.describe("E-54 — short_text authoring and play", () => {
  test("author a short_text question, answer it, and skip another", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(300_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const CLASS_TITLE = `E54 Class ${TEST_TIMESTAMP}`;
    const QUIZ_TITLE = `E54 ShortText ${TEST_TIMESTAMP}`;
    const TEXT_PROMPT = `Explain photosynthesis ${TEST_TIMESTAMP}`;
    const MCQ_PROMPT = `Pick a colour ${TEST_TIMESTAMP}`;

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(
      lecturerPage,
      `lecturer-e54-${TEST_TIMESTAMP}@innovision.test`,
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
      // 0067: short_text authoring/marking, not identity - bypass the face gate.
      gesturesOff: true,
      questions: [
        {
          type: "short_text" as const,
          prompt: TEXT_PROMPT,
          options: [],
          answerKey: "Mentions light energy and chlorophyll.",
        },
        { prompt: MCQ_PROMPT, options: ["Red", "Blue"], correctIndex: 0 },
      ],
    });

    // The rubric must survive authoring — an unreachable key would make the
    // question ungradeable. The service-role client is the honest read here:
    // the builder's question list renders prompt/type but not the key, and
    // this assertion is about PERSISTENCE, not about the list UI.
    {
      const admin = resolveServiceClient();
      if (!admin) throw new Error("service-role seam unavailable");
      const { data: quizRow } = await admin
        .from("quizzes")
        .select("id")
        .eq("title", QUIZ_TITLE)
        .maybeSingle();
      if (!quizRow) throw new Error("quiz row not found");
      const { data: qRows } = await admin
        .from("questions")
        .select("prompt, type, answer_key, options")
        .eq("quiz_id", quizRow.id);
      const textRow = qRows?.find((r) => r.prompt === TEXT_PROMPT);
      expect(textRow?.type).toBe("short_text");
      expect(textRow?.answer_key).toBe("Mentions light energy and chlorophyll.");
      expect(textRow?.options).toEqual([]);
    }

    // ── Student ───────────────────────────────────────────────────────
    await registerUser(
      studentPage,
      `student-e54-${TEST_TIMESTAMP}@innovision.test`,
      "student",
      LECTURER_INVITE_CODE,
    );
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await startQuizByTitle(studentPage, QUIZ_TITLE);
    await expect(studentPage).toHaveURL(/\/play\//);

    const capture = captureAnswerPosts(studentPage);

    // Q1 is the short_text question.
    await expect(studentPage.getByText(TEXT_PROMPT, { exact: true })).toBeVisible();
    const input = studentPage.getByTestId("short-text-input");
    await expect(input).toBeVisible();

    // Confirm is DISABLED until there is non-blank text.
    const confirm = studentPage.getByRole("button", { name: "Submit answer" });
    await expect(confirm).toBeDisabled();
    await input.fill("   ");
    await expect(confirm, "whitespace alone must not enable submit").toBeDisabled();
    await input.fill("Plants use light energy and chlorophyll.");
    await expect(confirm).toBeEnabled();
    await confirm.click();

    // The POST carries answerText and NO index field.
    await expect
      .poll(() => capture.bodies.length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const textBody = JSON.parse(capture.bodies[0]) as Record<string, unknown>;
    expect(textBody.answerText).toBe("Plants use light energy and chlorophyll.");
    expect(textBody.selectedIndex).toBeUndefined();
    expect(textBody.selectedIndices).toBeUndefined();
    expect(textBody.skipped).toBeUndefined();

    // Feedback advanced; the answered textarea is now read-only.
    await expect(studentPage.getByRole("button", { name: /next|finish/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await studentPage.getByRole("button", { name: /next|finish/i }).first().click();

    // ── Skip on Q2 ────────────────────────────────────────────────────
    await expect(studentPage.getByText(MCQ_PROMPT, { exact: true })).toBeVisible();
    const skip = studentPage.getByTestId("skip-question");
    await expect(skip).toBeVisible();
    capture.bodies.length = 0;
    await skip.click();

    await expect.poll(() => capture.bodies.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const skipBody = JSON.parse(capture.bodies[0]) as Record<string, unknown>;
    expect(skipBody.skipped).toBe(true);
    expect(skipBody.selectedIndex).toBeUndefined();
    expect(skipBody.selectedIndices).toBeUndefined();
    expect(skipBody.answerText).toBeUndefined();

    // The skip renders the Skipped chip, NOT the Incorrect verdict.
    await expect(studentPage.getByText("Skipped", { exact: true })).toBeVisible();
    await expect(studentPage.getByText("Incorrect ✗")).toHaveCount(0);

    // ── RESUME: both survive a reload ─────────────────────────────────
    // The resume lands on the first UNANSWERED question; with both answered
    // that is index 0 (the short_text). Note the feedback button acts as
    // Finish once every question is answered, so the two rows are checked by
    // navigating with the pager rather than by clicking Next.
    await studentPage.reload();
    await expect(studentPage.getByText(TEXT_PROMPT, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // The resumed short_text row shows the typed answer, not an empty box.
    await expect(studentPage.getByTestId("short-text-input")).toHaveValue(
      "Plants use light energy and chlorophyll.",
    );
    await expect(studentPage.getByText("Incorrect ✗")).toHaveCount(0);

    // The resume SEED's data contract is asserted on the BASE table: with
    // every question answered the client has no non-submitting way to page
    // back, and what matters is that the persisted row carries `skipped` and
    // `answer_text` for the seed mapper to read (the view projection was
    // verified separately — `student_answers_view` is auth.uid()-scoped, so
    // a service-role read of it returns nothing).
    {
      const admin = resolveServiceClient();
      if (!admin) throw new Error("service-role seam unavailable");
      const sessionId = /\/play\/([0-9a-f-]{36})/.exec(studentPage.url())?.[1];
      expect(sessionId).toBeTruthy();
      const { data: rows } = await admin
        .from("session_answers")
        .select("skipped, answer_text, mark_status")
        .eq("session_id", sessionId!);
      expect(rows?.length).toBe(2);
      const skippedRow = rows?.find((r) => r.skipped === true);
      const textRow = rows?.find((r) => (r.answer_text ?? "").length > 0);
      expect(skippedRow, "the skipped row persists skipped=true").toBeTruthy();
      expect(textRow?.answer_text).toBe("Plants use light energy and chlorophyll.");
      // The short_text row is PENDING: it is queued for AI marking, so its
      // is_correct/mark_score sentinels must not read as a graded verdict.
      expect(textRow?.mark_status).toBe("pending");
    }

    await lecturerCtx.close();
    await studentCtx.close();
  });

  test("the answer route rejects a mixed short_text payload", async ({ browser }, testInfo) => {
    testInfo.setTimeout(240_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const CLASS_TITLE = `E54b Class ${TEST_TIMESTAMP}`;
    const QUIZ_TITLE = `E54b ShortText ${TEST_TIMESTAMP}`;
    const TEXT_PROMPT = `E54b explain ${TEST_TIMESTAMP}`;

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(
      lecturerPage,
      `lecturer-e54b-${TEST_TIMESTAMP}@innovision.test`,
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
          answerKey: "Any reasonable explanation.",
        },
      ],
    });

    await registerUser(
      studentPage,
      `student-e54b-${TEST_TIMESTAMP}@innovision.test`,
      "student",
      LECTURER_INVITE_CODE,
    );
    await joinClass(studentPage, joinCode, CLASS_TITLE);
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await startQuizByTitle(studentPage, QUIZ_TITLE);
    await expect(studentPage).toHaveURL(/\/play\//);

    const sessionId = /\/play\/([0-9a-f-]{36})/.exec(studentPage.url())?.[1];
    expect(sessionId).toBeTruthy();

    // Resolve the question id via the service client (the student cannot read
    // base `questions`, and this is a boundary test, not a UI one).
    const admin = resolveServiceClient();
    if (!admin) throw new Error("service-role seam unavailable");
    const { data: quizRow } = await admin
      .from("quizzes")
      .select("id")
      .eq("title", QUIZ_TITLE)
      .maybeSingle();
    if (!quizRow) throw new Error("quiz row not found for the boundary probe");
    const { data: qRow } = await admin
      .from("questions")
      .select("id")
      .eq("quiz_id", quizRow.id)
      .maybeSingle();
    if (!qRow) throw new Error("question row not found for the boundary probe");
    const questionId = qRow.id as string;

    // BOTH answerText and selectedIndex — the shape-exclusivity arm must 400.
    const mixed = await studentPage.request.post(`/api/sessions/${sessionId}/answer`, {
      data: { questionId, answerText: "hello", selectedIndex: 0 },
    });
    expect(mixed.status(), "a mixed payload must be rejected at the boundary").toBe(400);

    // Neither field at all — also rejected.
    const empty = await studentPage.request.post(`/api/sessions/${sessionId}/answer`, {
      data: { questionId },
    });
    expect(empty.status()).toBe(400);

    // A clean short_text payload succeeds (proving the 400s above were about
    // SHAPE, not a blanket rejection).
    const ok = await studentPage.request.post(`/api/sessions/${sessionId}/answer`, {
      data: { questionId, answerText: "A clean answer." },
    });
    expect(ok.status()).toBe(200);

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
