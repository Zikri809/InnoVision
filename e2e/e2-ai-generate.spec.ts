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
 * pointing at e2e/mock-ai-server.mjs, so /api/ai/generate-quiz and
 * /api/ai/regenerate-question hit the mock OpenAI-compatible endpoint and return
 * deterministic valid JSON. No real LLM is ever contacted in CI.
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
    await expect(lecturerPage.getByText("E2 Physics", { exact: true })).toBeVisible();

    const joinCode = await lecturerPage
      .getByText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
      .first()
      .textContent();
    expect(joinCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);

    await lecturerPage.getByText("E2 Physics", { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);

    await lecturerPage.getByLabel("Quiz title").fill("Chapter 1: Motion");
    await lecturerPage.getByRole("button", { name: /create quiz|new quiz/i }).click();
    await lecturerPage.getByText("Chapter 1: Motion", { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    // ── 2. Open Generate-from-file, upload the PDF, extract ─────
    await lecturerPage.getByRole("button", { name: /generate from file/i }).click();
    await expect(
      lecturerPage.getByRole("heading", { name: "Generate quiz from file" }),
    ).toBeVisible();

    // Target the hidden file input directly (the dropzone wraps it).
    await lecturerPage.locator('input[type="file"]').setInputFiles(
      "e2e/fixtures/chapter-sample.pdf",
    );

    await lecturerPage.getByRole("button", { name: /Read Files & Continue/i }).click();
    await expect(
      lecturerPage.getByText(/ready/i),
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

    // ── 4. Edit one question (with cancel + save test) → publish ──
    const editButtons = lecturerPage.getByRole("button", { name: "Edit", exact: true });
    await editButtons.first().click();

    // 4a. Test cancel: discard edits and ensure original question is unchanged.
    const promptBox = lecturerPage.getByRole("textbox", { name: "Question prompt" });
    await promptBox.fill("Dirty discard prompt");
    await lecturerPage.getByRole("button", { name: /cancel/i }).click();
    await expect(lecturerPage.getByRole("heading", { name: /edit question/i })).not.toBeVisible();
    await expect(lecturerPage.getByText("What is velocity?", { exact: true })).toBeVisible();

    // 4b. Test save: reopen dialog, save changes, and verify persistence.
    await editButtons.first().click();
    await expect(lecturerPage.getByRole("heading", { name: /edit question/i })).toBeVisible();
    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("What is velocity in a straight line?");
    await lecturerPage.getByRole("button", { name: /save changes/i }).click();
    await expect(
      lecturerPage.getByText("What is velocity in a straight line?", { exact: true }),
    ).toBeVisible();
    await expect(lecturerPage.getByRole("heading", { name: /edit question/i })).not.toBeVisible();

    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/^Live/)).toBeVisible();
    await expect(lecturerPage.getByText("Live", { exact: true })).toBeVisible();

    // ── 5. Student sees the live quiz ───────────────────────────
    // The lecturer's title is preserved across AI generation.
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();
    await studentPage.getByLabel("Join code").fill(joinCode!);
    await studentPage.getByRole("button", { name: /join/i }).click();
    await expect(studentPage.getByText("E2 Physics", { exact: true })).toBeVisible();

    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await expect(
      studentPage.getByText("Available quizzes", { exact: true }),
    ).toBeVisible();
    await expect(studentPage.getByText("Chapter 1: Motion", { exact: true })).toBeVisible();
    await expect(studentPage.getByRole("list").getByText("Practice")).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });
});