import { test, expect } from "@playwright/test";
import { registerUser, createClass, joinClass } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e11-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e11-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E11 Secrecy";
const QUIZ_TITLE = "E11 Assessment";
/** Q1's explanation — the strongest leak candidate (asserted by its VALUE below). */
const Q1_EXPLANATION = "Two plus two equals four.";

/**
 * Matches a correct-answer KEY carrying a VALUE — plain JSON (`"correct_index":0`,
 * `"correctIndex":"1"`, `"correct_index":null`) and the backslash-quote-escaped
 * form Next.js embeds inside HTML flight scripts (`\"correctIndex\":0`).
 *
 * Why not a bare substring match on the key names? The root layout ships the
 * ENTIRE next-intl message catalog to the client (src/app/layout.tsx passes
 * unscoped `getMessages()` to <NextIntlClientProvider>), so EVERY full-document
 * render embeds unrelated builder/practice UI strings whose keys literally
 * contain "explanation" (en.json: "explanationLabel", "explanationPlaceholder",
 * "explanation":"Explanation:" …). Those are framework UI chrome, not answer
 * data — a bare `body.includes("explanation")` false-positives on any /play
 * document load. The catalog contains NO correct_index/correctIndex keys, but
 * key+colon matching keeps this detector honest against future catalog edits too.
 */
const CORRECT_KEY_WITH_VALUE = /\\?"(?:correct_index|correctIndex)\\?"\s*:/;

/**
 * E11 (Phase 5 scope) — Answer secrecy, assessment only.
 *
 * Collects same-origin text responses filtered by content-type (document,
 * text/x-component, application/json) AND by URL (the play page + any
 * /api/sessions/… endpoints) AND only response.ok() responses. Asserts, across
 * the entire flow INCLUDING post-Finish revalidation:
 *  - the lecturer's explanation TEXT never reaches any student-facing response;
 *  - no correct_index/correctKey data (key-with-a-value) rides in any payload;
 *  - pure API JSON (/api/sessions/*) carries none of the key NAMES at all —
 *    those responses bypass the root layout, so the i18n catalog cannot appear;
 *  - the assessment answer response is KEYLESS (`recorded`, no isCorrect, no
 *    correctIndex) — PLAN_RESEAL_RESULTS v4: correctness is withheld until reveal.
 *
 * A mid-assessment FULL RELOAD of /play is part of the flow (realistic student
 * behaviour): it forces the document-render class whose flight bootstrap embeds
 * the shared i18n catalog, exactly the payload shape that regressed the naive
 * matcher. Resume-seeding through student_answers_view is exercised by it.
 *
 * (Practice disclosure assertions live in E4, not E11.)
 */
test.describe("E11 — answer secrecy (assessment)", () => {
  test("correct_index/explanation never appear in any student-facing response", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // ── Lecturer: class + UNTIMED assessment + publish ──────────────────
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    const joinCode = await createClass(lecturerPage, CLASS_TITLE);

    await lecturerPage.getByText(CLASS_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByLabel("Quiz title").fill(QUIZ_TITLE);
    await lecturerPage.getByLabel("Mode").click();
    await lecturerPage.getByRole("option", { name: "Assessment" }).click();
    await lecturerPage.getByRole("button", { name: /create quiz|new quiz/i }).click();
    await expect(lecturerPage.getByText(QUIZ_TITLE, { exact: true })).toBeVisible();
    await lecturerPage.getByText(QUIZ_TITLE, { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    // Q1 with an explanation (the strongest leak candidate).
    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("What is 2+2?");
    await lecturerPage.getByLabel("Option 1").fill("3");
    await lecturerPage.getByLabel("Option 2").fill("4");
    await lecturerPage.getByLabel("Explanation (optional)").fill(Q1_EXPLANATION);
    await lecturerPage.getByRole("button", { name: /add question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");

    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("Capital of France?");
    await lecturerPage.getByLabel("Option 1").fill("Paris");
    await lecturerPage.getByLabel("Option 2").fill("London");
    await lecturerPage.getByRole("button", { name: /add question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");

    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/^Live/)).toBeVisible();

    // ── Student: register + join + collect responses ────────────────────
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await joinClass(studentPage, joinCode, CLASS_TITLE);

    const capturedBodies: { url: string; status: number; body: string }[] = [];
    const capturedErrorBodies: { url: string; status: number; body: string }[] = [];
    const answerRequestBodies: string[] = [];
    studentPage.on("request", (req) => {
      if (req.url().includes("/answer") && req.method() === "POST") {
        answerRequestBodies.push(req.postData() ?? "");
      }
    });
    studentPage.on("response", async (res) => {
      const url = res.url();
      // Filter: same-origin only.
      if (!url.startsWith("http://localhost")) return;
      const contentType = res.headers()["content-type"] ?? "";
      const isRelevantType =
        contentType.includes("text/html") ||
        contentType.includes("text/x-component") ||
        contentType.includes("application/json");
      const isRelevantUrl =
        url.includes("/play/") || url.includes("/api/sessions/") || url.includes("/student/quizzes");
      if (!isRelevantType || !isRelevantUrl) return;
      const body = await res.text().catch(() => "");
      // Split OK bodies (asserted for absence) from ERROR bodies (also
      // asserted — a 409 body that lacks the key would trivially "pass" if we
      // only checked 2xx).
      if (res.ok()) {
        capturedBodies.push({ url, status: res.status(), body });
      } else if (url.includes("/api/sessions/")) {
        capturedErrorBodies.push({ url, status: res.status(), body });
      }
    });

    // ── Full assessment flow ────────────────────────────────────────────
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);

    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    // Mid-assessment full-document reload: exercises resume seeding AND the
    // document-render payload class (i18n-catalog-bearing) that the value-based
    // detector below must see through. See header comment.
    await studentPage.reload();
    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /4/i }).click();
    await expect(studentPage.getByRole("button", { name: /^(Next|Finish)$/, exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentPage.getByText("Capital of France?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /Paris/i }).click();
    await expect(studentPage.getByRole("button", { name: /^(Next|Finish)$/, exact: true })).toBeVisible();
    // Force a real 409 already_answered by POSTing a duplicate answer for Q1
    // via page.request (the UI locks options after feedback, so this exercises
    // the server-side first-answer-wins path and captures the error body).
    // Q1's real id comes from the UI's own answer POST request body.
    const q1Body = answerRequestBodies.find((b) => b.includes("questionId"));
    expect(q1Body).toBeTruthy();
    const q1QuestionId = (JSON.parse(q1Body!) as { questionId: string }).questionId;
    const sessionId = studentPage.url().split("/play/")[1];
    const dup = await studentPage.request.post(`/api/sessions/${sessionId}/answer`, {
      data: { questionId: q1QuestionId, selectedIndex: 0 },
    });
    expect(dup.status()).toBe(409);
    const dupBody = await dup.json();
    expect(dupBody.error).toBe("already_answered");
    // Keyless replay: NO isCorrect (correctness withheld until reveal).
    expect(dupBody.isCorrect).toBeUndefined();
    expect(JSON.stringify(dupBody)).not.toContain("correctIndex");
    expect(JSON.stringify(dupBody)).not.toContain("correct_index");
    expect(JSON.stringify(dupBody)).not.toContain("explanation");
    await studentPage.getByRole("button", { name: "Finish", exact: true }).click();
    // Hidden assessment → "awaiting release" message, NOT the score.
    await expect(studentPage.getByText(/results will be released by your lecturer/i)).toBeVisible({ timeout: 10_000 });

    // ── Assert: no leaked ANSWER DATA across all captured OK responses ──
    // Value-based (see CORRECT_KEY_WITH_VALUE above): scans every phase,
    // including post-Finish RSC revalidations where disclosure would be
    // legitimate ONLY after an explicit lecturer reveal — E11 never reveals.
    expect(capturedBodies.length).toBeGreaterThan(0);
    for (const { url, body } of capturedBodies) {
      // The lecturer's actual explanation TEXT must never ship to the client.
      expect(body.includes(Q1_EXPLANATION), `explanation text leaked in ${url}`).toBe(false);
      // No correct-answer index serialized as data (any key:value form).
      expect(CORRECT_KEY_WITH_VALUE.test(body), `correct-index data leaked in ${url}`).toBe(false);
    }

    // ── Assert: API JSON carries none of the key NAMES at all ───────────
    // /api/sessions/* responses are rendered by route handlers, NOT the root
    // layout, so the i18n catalog cannot ride along — strict key-absence is
    // sound here (covers null-valued keys too, which key:value regex skips).
    const apiBodies = [
      ...capturedBodies.filter((c) => c.url.includes("/api/sessions/")),
      ...capturedErrorBodies,
    ];
    for (const { url, body } of apiBodies) {
      expect(
        body.includes("correct_index") || body.includes("correctIndex") || body.includes("explanation"),
        `answer key leaked in an API response: ${url}`,
      ).toBe(false);
    }

    // The assessment answer SUCCESS body is a keyless ack: `recorded`, with NO
    // isCorrect / correctIndex / explanation (correctness withheld until reveal).
    const answerBodies = capturedBodies.filter(
      (c) => c.url.includes("/answer") && c.url.includes("/api/sessions/"),
    );
    expect(answerBodies.length).toBeGreaterThan(0);
    for (const { body } of answerBodies) {
      expect(body.includes("recorded")).toBe(true);
      expect(body.includes("isCorrect")).toBe(false);
      expect(body.includes("correctIndex")).toBe(false);
      expect(body.includes("explanation")).toBe(false);
    }

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
