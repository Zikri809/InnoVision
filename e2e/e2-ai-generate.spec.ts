import { test, expect } from "@playwright/test";
import { registerUser } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e2-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e2-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

/**
 * E2 (Phase 4 scope) — Lecturer: AI generation from a PDF → editable → publish
 *
 * The Next.js dev server is configured (playwright.config.ts) with AI_BASE_URL
 * pointing at e2e/mock-ai-server.mjs, so /api/ai/generate-quiz hits the mock
 * OpenAI-compatible endpoint and returns deterministic valid quiz JSON. No real
 * LLM is ever contacted in CI.
 *
 * Flow:
 *  1. Lecturer registers → creates a class → creates a draft quiz → opens builder
 *  2. "Generate from file" → uploads a committed tiny text-layer PDF →
 *     native extraction runs in-browser → extracted-text preview visible
 *  3. Generate → the real route persists via replace_quiz_questions →
 *     router.refresh() shows the persisted questions
 *  4. Edit one question → publish → edited text persists
 *  5. Student registers + joins → sees the live quiz
 */

test.describe("E2 — AI quiz from a PDF is editable and publishable", () => {
  test("lecturer generates, edits, publishes; student sees it", async ({ browser }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // ── 1. Lecturer registers + creates a class + draft quiz ────
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();

    await lecturerPage.getByLabel("Class title").fill("E2 Physics");
    await lecturerPage.getByRole("button", { name: /create/i }).click();
    const classCard = lecturerPage.getByText("E2 Physics", { exact: true });
    await expect(classCard).toBeVisible();

    const joinCode = await lecturerPage
      .getByText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
      .first()
      .textContent();
    expect(joinCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);

    await lecturerPage.getByText("E2 Physics", { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);

    await lecturerPage.getByLabel("Quiz title").fill("Chapter 1: Motion");
    await lecturerPage.getByRole("button", { name: /new quiz/i }).click();
    await lecturerPage.getByText("Chapter 1: Motion", { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    // ── 2. Open Generate-from-file, upload the PDF, extract ─────
    await lecturerPage.getByRole("button", { name: /generate from file/i }).click();
    await expect(
      lecturerPage.getByRole("heading", { name: "Generate quiz from file" }),
    ).toBeVisible();

    await lecturerPage.getByLabel("Upload source file").setInputFiles(
      "e2e/fixtures/chapter-sample.pdf",
    );

    await lecturerPage.getByRole("button", { name: /extract text/i }).click();
    // Native extraction of the committed text-layer PDF.
    await expect(
      lecturerPage.getByText(/Velocity is the rate of change of displacement/),
    ).toBeVisible({ timeout: 20_000 });

    // ── 3. Generate (mock AI) → questions persisted + visible ──
    await lecturerPage.getByRole("button", { name: /generate quiz/i }).click();
    await expect(
      lecturerPage.getByText("What is velocity?", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      lecturerPage.getByText("Light travels faster than sound.", { exact: true }),
    ).toBeVisible();
    await expect(
      lecturerPage.getByText("Which unit is force measured in?", { exact: true }),
    ).toBeVisible();

    // ── 4. Edit one question → publish → edited text persists ──
    const editButtons = lecturerPage.getByRole("button", { name: "Edit question" });
    await editButtons.first().click();
    const promptBox = lecturerPage.getByRole("textbox", { name: "Question" });
    await promptBox.fill("What is velocity in a straight line?");
    await lecturerPage.getByRole("button", { name: /save changes/i }).click();
    await expect(
      lecturerPage.getByText("What is velocity in a straight line?", { exact: true }),
    ).toBeVisible();

    await lecturerPage.getByRole("button", { name: /publish/i }).click();
    await expect(lecturerPage.getByText(/published/i)).toBeVisible();
    await expect(lecturerPage.getByText("Live", { exact: true })).toBeVisible();
    await expect(
      lecturerPage.getByText("What is velocity in a straight line?", { exact: true }),
    ).toBeVisible();

    // ── 5. Student sees the live quiz ───────────────────────────
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await studentPage.getByLabel("Join code").fill(joinCode!);
    await studentPage.getByRole("button", { name: /join/i }).click();
    await expect(studentPage.getByText("E2 Physics", { exact: true })).toBeVisible();

    await studentPage.getByRole("link", { name: /available quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await expect(
      studentPage.getByRole("heading", { name: "Available quizzes" }),
    ).toBeVisible();
    await expect(studentPage.getByText("Chapter 1: Motion", { exact: true })).toBeVisible();
    await expect(studentPage.getByText("Practice", { exact: true })).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
