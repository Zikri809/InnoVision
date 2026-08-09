import { test, expect } from "@playwright/test";
import { registerUser } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e1b-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e1b-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

/**
 * E1b (Phase 3 scope) — Lecturer: manual quiz → publish → visible to student
 *
 * Verifies:
 *  1. Lecturer registers (invite code) → creates a class
 *  2. Opens the class → creates a quiz → opens the builder
 *  3. Adds 3 questions (mcq + true_false) by hand
 *  4. Publishes the quiz → status becomes Live
 *  5. Student registers + joins the class → sees the live quiz on
 *     /student/quizzes with a mode badge
 *
 * Prerequisites: local Supabase running + migrations applied.
 * The LECTURER_INVITE_CODE env var must be set.
 */

test.describe("E1b — Manual quiz → publish → visible to student", () => {
  test("lecturer builds and publishes a quiz; student sees it", async ({
    browser,
  }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // ── 1. Lecturer registers and creates a class ──────────────
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(lecturerPage.getByRole("heading", { name: "My Classes" })).toBeVisible();

    await lecturerPage.getByLabel("Class title").fill("E1b Physics");
    await lecturerPage.getByRole("button", { name: /create/i }).click();
    const classCard = lecturerPage.getByText("E1b Physics", { exact: true });
    await expect(classCard).toBeVisible();

    const joinCode = await lecturerPage
      .getByText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
      .first()
      .textContent();
    expect(joinCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);

    // ── 2. Open class → create quiz → open builder ─────────────
    await lecturerPage.getByText("E1b Physics", { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await expect(lecturerPage.getByRole("heading", { name: "E1b Physics" })).toBeVisible();

    await lecturerPage.getByLabel("Quiz title").fill("Chapter 1: Motion");
    await lecturerPage.getByRole("button", { name: /new quiz/i }).click();
    const quizLink = lecturerPage.getByText("Chapter 1: Motion", { exact: true });
    await expect(quizLink).toBeVisible();
    await quizLink.click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    // ── 3. Add 3 questions (mcq, mcq, true_false) ─────────────
    await expect(lecturerPage.getByRole("heading", { name: "Chapter 1: Motion" })).toBeVisible();

    // Q1 — MCQ (default type, starts with 2 options → add 2 more for 4)
    await lecturerPage.getByRole("textbox", { name: "Question" }).fill("What is velocity?");
    await lecturerPage.getByLabel("Option 1").fill("Speed in a direction");
    await lecturerPage.getByLabel("Option 2").fill("Total distance");
    await lecturerPage.getByRole("button", { name: /add option/i }).click();
    await lecturerPage.getByRole("textbox", { name: "Option 3" }).fill("Time taken");
    await lecturerPage.getByRole("button", { name: /add option/i }).click();
    await lecturerPage.getByRole("textbox", { name: "Option 4" }).fill("Acceleration");
    await lecturerPage.getByRole("button", { name: /add question/i }).click();
    // The save completes when the form resets (Question field cleared).
    await expect(lecturerPage.getByRole("textbox", { name: "Question" })).toHaveValue("");
    await expect(lecturerPage.getByText("What is velocity?")).toBeVisible();

    // Q2 — MCQ with the "Add option" path (2 → 3 options)
    await lecturerPage.getByRole("textbox", { name: "Question" }).fill("Which unit is force measured in?");
    await lecturerPage.getByRole("textbox", { name: "Option 1" }).fill("Joule");
    await lecturerPage.getByRole("textbox", { name: "Option 2" }).fill("Newton");
    await lecturerPage.getByRole("button", { name: /add option/i }).click();
    await lecturerPage.getByRole("textbox", { name: "Option 3" }).fill("Watt");
    await lecturerPage.getByRole("button", { name: /add question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question" })).toHaveValue("");
    await expect(lecturerPage.getByText("Which unit is force measured in?")).toBeVisible();

    // Q3 — True/False (type switch fixes options to True/False)
    await lecturerPage.getByLabel("Type").click();
    await lecturerPage.getByRole("option", { name: "True / False" }).click();
    await lecturerPage.getByRole("textbox", { name: "Question" }).fill("Light travels faster than sound.");
    await lecturerPage.getByRole("button", { name: /add question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question" })).toHaveValue("");
    await expect(lecturerPage.getByText("Light travels faster than sound.")).toBeVisible();

    // Publish button enabled only after questions exist; click it.
    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/published/i)).toBeVisible();
    // The quiz is now Live and questions are locked (read-only banner).
    await expect(lecturerPage.getByText("Live", { exact: true })).toBeVisible();
    await expect(lecturerPage.getByText(/can no longer be edited/i)).toBeVisible();

    // ── 4. Student registers, joins, sees the live quiz ────────
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();

    await studentPage.getByLabel("Join code").fill(joinCode!);
    await studentPage.getByRole("button", { name: /join/i }).click();
    await expect(studentPage.getByText("E1b Physics", { exact: true })).toBeVisible();

    // Navigate to the quizzes list and confirm the published quiz + mode badge.
    await studentPage.getByRole("link", { name: /available quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await expect(
      studentPage.getByRole("heading", { name: "Available quizzes" }),
    ).toBeVisible();
    await expect(studentPage.getByText("Chapter 1: Motion", { exact: true })).toBeVisible();
    await expect(studentPage.getByText("Practice", { exact: true })).toBeVisible();
    // Draft secrecy: no draft quiz exists for this student to see beyond the live one.
    await expect(studentPage.getByText("Chapter 1: Motion", { exact: true })).toHaveCount(1);

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
