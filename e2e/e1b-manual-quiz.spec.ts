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
  }, testInfo) => {
    testInfo.setTimeout(120_000);
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
    await lecturerPage.getByRole("button", { name: /create quiz|new quiz/i }).click();
    const quizLink = lecturerPage.getByText("Chapter 1: Motion", { exact: true });
    await expect(quizLink).toBeVisible();
    await quizLink.click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    // ── 3. Add 3 questions (mcq, mcq, true_false) ─────────────
    await expect(lecturerPage.getByRole("heading", { name: "Chapter 1: Motion" })).toBeVisible();

    // Q1 — MCQ (default type, starts with 2 options → add 2 more for 4)
    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("What is velocity?");
    await lecturerPage.getByLabel("Option 1").fill("Speed in a direction");
    await lecturerPage.getByLabel("Option 2").fill("Total distance");
    await lecturerPage.getByRole("button", { name: /add option/i }).click();
    await lecturerPage.getByRole("textbox", { name: "Option 3" }).fill("Time taken");
    await lecturerPage.getByRole("button", { name: /add option/i }).click();
    await lecturerPage.getByRole("textbox", { name: "Option 4" }).fill("Acceleration");
    await lecturerPage.getByRole("button", { name: /add this question/i }).click();
    // The save completes when the form resets (Question field cleared).
    await expect(lecturerPage.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");
    await expect(lecturerPage.getByText("What is velocity?")).toBeVisible();

    // Q2 — MCQ with the "Add option" path (2 → 3 options)
    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("Which unit is force measured in?");
    await lecturerPage.getByRole("textbox", { name: "Option 1" }).fill("Joule");
    await lecturerPage.getByRole("textbox", { name: "Option 2" }).fill("Newton");
    await lecturerPage.getByRole("button", { name: /add option/i }).click();
    await lecturerPage.getByRole("textbox", { name: "Option 3" }).fill("Watt");
    await lecturerPage.getByRole("button", { name: /add this question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");
    await expect(lecturerPage.getByText("Which unit is force measured in?")).toBeVisible();

    // Q3 — True/False (type switch fixes options to True/False)
    await lecturerPage.getByLabel("Type").click();
    await lecturerPage.getByRole("option", { name: "True / False" }).click();
    await lecturerPage.getByRole("textbox", { name: "Question prompt" }).fill("Light travels faster than sound.");
    await lecturerPage.getByRole("button", { name: /add this question/i }).click();
    await expect(lecturerPage.getByRole("textbox", { name: "Question prompt" })).toHaveValue("");
    await expect(lecturerPage.getByText("Light travels faster than sound.")).toBeVisible();

    // Publish button enabled only after questions exist; click it.
    const publishButton = lecturerPage.getByRole("button", { name: /publish/i });
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(lecturerPage.getByText(/^Live/)).toBeVisible();
    // The quiz is now Live and questions are locked (read-only builder):
    await expect(lecturerPage.getByText("Live", { exact: true })).toBeVisible();
    // Published mode swaps editing affordances for a results link.
    await expect(
      lecturerPage.getByRole("link", { name: "View results" }),
    ).toBeVisible();
    await expect(lecturerPage.getByRole("button", { name: /publish/i })).toHaveCount(0);
    // Add-question form is gone → questions are read-only.
    await expect(
      lecturerPage.getByRole("textbox", { name: "Question prompt" }),
    ).toHaveCount(0);

    // ── 4. Student registers, joins, sees the live quiz ────────
    // Non-vacuous draft secrecy: the lecturer leaves a SECOND quiz unpublished
    // so the student's list must show exactly ONE (the live) quiz.
    await lecturerPage.goto(`/lecturer/classes`);
    await lecturerPage.getByText("E1b Physics", { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await lecturerPage.getByLabel("Quiz title").fill("Chapter 2: Draft Only");
    await lecturerPage.getByRole("button", { name: /create quiz|new quiz/i }).click();
    await expect(
      lecturerPage.getByText("Chapter 2: Draft Only", { exact: true }),
    ).toBeVisible();
    // Leave it unpublished (no questions, still draft).

    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(studentPage.getByRole("heading", { name: "My Classes" })).toBeVisible();

    await studentPage.getByLabel("Join code").fill(joinCode!);
    await studentPage.getByRole("button", { name: /join/i }).click();
    await expect(studentPage.getByText("E1b Physics", { exact: true })).toBeVisible();
    // Class card quiz-count reflects ONLY the live quiz (draft invisible):
    // the badge reads "1 Live quiz" — a draft would make it "0".
    const studentCard = studentPage.locator("a").filter({ hasText: "E1b Physics" });
    await expect(studentCard.getByText("1 Live quiz", { exact: true })).toBeVisible();

    // Navigate to the quizzes list and confirm the published quiz + mode badge.
    await studentPage.getByRole("link", { name: /View quizzes/i }).click();
    await expect(studentPage).toHaveURL(/\/student\/quizzes/);
    await expect(
      studentPage.getByText("Available quizzes", { exact: true }),
    ).toBeVisible();
    await expect(studentPage.getByText("Chapter 1: Motion", { exact: true })).toBeVisible();
    await expect(studentPage.getByRole("list").getByText("Practice")).toBeVisible();
    // Draft secrecy (non-vacuous): the draft quiz NEVER appears, and the live
    // one is the ONLY row (count of 1 proves we're not just missing content).
    await expect(studentPage.getByText("Chapter 2: Draft Only", { exact: true })).toHaveCount(0);
    await expect(studentPage.getByText("Chapter 1: Motion", { exact: true })).toHaveCount(1);

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
