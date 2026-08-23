import { test, expect } from "@playwright/test";
import { registerUser } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e1-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e1-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

/**
 * E1 (Phase 2 scope) — Lecturer: class → join via code → roster updates
 *
 * Verifies:
 *  1. Lecturer registers (with invite code) → lands on /lecturer/classes
 *  2. Lecturer creates a class → join code shown
 *  3. Student registers → lands on /student/classes
 *  4. Student joins via the code → sees the class
 *  5. Lecturer opens the class → roster shows the student
 *
 * Prerequisites: local Supabase running + migrations applied.
 * The LECTURER_INVITE_CODE env var must be set.
 */

test.describe("E1 — Class create → join via code → roster", () => {
  test("lecturer creates class, student joins, roster updates", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    // Two isolated contexts: lecturer + student.
    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    // ── 1. Lecturer registers and lands on /lecturer/classes ──
    await registerUser(lecturerPage, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(
      lecturerPage.getByRole("heading", { name: "My Classes" }),
    ).toBeVisible();

    // ── 2. Create a class ──────────────────────────────────────
    await lecturerPage.getByLabel("Class title").fill("E1 Physics");
    await lecturerPage.getByRole("button", { name: /create/i }).click();

    // Wait for the class card to appear and capture the join code.
    const classCard = lecturerPage.getByText("E1 Physics");
    await expect(classCard).toBeVisible();
    const joinCode = await lecturerPage
      .getByText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
      .first()
      .textContent();
    expect(joinCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);

    // ── 3. Student registers and lands on /student/classes ─────
    await registerUser(studentPage, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(
      studentPage.getByRole("heading", { name: "My Classes" }),
    ).toBeVisible();

    // ── 4. Student joins via the code ──────────────────────────
    await studentPage.getByLabel("Join code").fill(joinCode!);
    await studentPage.getByRole("button", { name: /join/i }).click();
    // Exact match: the "Joined E1 Physics." status toast also contains the
    // title, so a substring query would be ambiguous.
    await expect(studentPage.getByText("E1 Physics", { exact: true })).toBeVisible();

    // ── 5. Lecturer opens the class → roster shows student ─────
    await lecturerPage.getByText("E1 Physics", { exact: true }).click();
    await expect(lecturerPage).toHaveURL(/\/lecturer\/classes\/[^/]+$/);
    await expect(lecturerPage.getByText("Roster")).toBeVisible();
    // The student's full name is prefixed with "student-" from registerUser.
    await expect(lecturerPage.getByText(/student-/)).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
