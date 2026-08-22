import { test, expect } from "@playwright/test";
import { registerUser, createClass, joinClass } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e11-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e11-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";
const CLASS_TITLE = "E11 Secrecy";
const QUIZ_TITLE = "E11 Assessment";

/**
 * E11 (Phase 5 scope) — Answer secrecy, assessment only.
 *
 * Collects same-origin text responses filtered by content-type (document,
 * text/x-component, application/json) AND by URL (the play page + any
 * /api/sessions/—¦ endpoints) AND only response.ok() responses. Asserts
 * `correct_index`/`explanation` are ABSENT across the entire flow, and that
 * the assessment answer response is KEYLESS (`recorded`, no isCorrect, no
 * correctIndex) — PLAN_RESEAL_RESULTS v4: correctness is withhold until reveal.
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

    // â”€â”€ Lecturer: class + UNTIMED assessment + publish â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    await lecturerPage.getByRole("textbox", { name: "Question" }).fill("What is 2+2?");
    await lecturerPage.getByLabel("Option 1").fill("3");
    await lecturerPage.getByLabel("Option 2").fill("4");
    await lecturerPage.getByLabel("Explanation (optional)").fill("Two plus two equals four.");
    await lecturerPage.getByRole("button", { name: /add question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question" })).toHaveValue("");

    await lecturerPage.getByRole("textbox", { name: "Question" }).fill("Capital of France?");
    await lecturerPage.getByLabel("Option 1").fill("Paris");
    await lecturerPage.getByLabel("Option 2").fill("London");
    await lecturerPage.getByRole("button", { name: /add question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question" })).toHaveValue("");

    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/^Live/)).toBeVisible();

    // â”€â”€ Student: register + join + collect responses â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      // Split OK bodies (asserted for key-absence) from ERROR bodies (also
      // asserted — a 409 body that lacks the key would trivially "pass" if we
      // only checked 2xx).
      if (res.ok()) {
        capturedBodies.push({ url, status: res.status(), body });
      } else if (url.includes("/api/sessions/")) {
        capturedErrorBodies.push({ url, status: res.status(), body });
      }
    });

    // â”€â”€ Full assessment flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await studentPage.getByRole("link", { name: /available quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await studentPage.getByRole("button", { name: "Start", exact: true }).click();
    await expect(studentPage).toHaveURL(/\/play\/[0-9a-f-]+/);

    await expect(studentPage.getByText("What is 2+2?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /4/i }).click();
    await expect(studentPage.getByText("Answered", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: "Next", exact: true }).click();
    await expect(studentPage.getByText("Capital of France?", { exact: true })).toBeVisible();
    await studentPage.getByRole("button", { name: /Paris/i }).click();
    await expect(studentPage.getByText("Answered", { exact: true })).toBeVisible();
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

    // ── Assert: no key/explanation across all captured OK responses ──
    expect(capturedBodies.length).toBeGreaterThan(0);
    for (const { url, body } of capturedBodies) {
      expect(
        body.includes("correct_index") || body.includes("correctIndex") || body.includes("explanation"),
        `answer key leaked in ${url}`,
      ).toBe(false);
    }

    // ── Assert: error bodies (409 already_answered etc.) also carry no key ──
    // A 409 body that lacks the key would trivially "pass" if we only checked
    // 2xx responses. The forced duplicate-answer 409 is asserted directly via
    // `dupBody` above; any browser-triggered session error bodies captured here
    // must also be key-free.
    for (const { body } of capturedErrorBodies) {
      expect(
        body.includes("correct_index") || body.includes("correctIndex") || body.includes("explanation"),
        "answer key leaked in an error response",
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
