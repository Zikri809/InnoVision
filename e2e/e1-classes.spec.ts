import { test, expect } from "@playwright/test";
import { registerUser, createClass } from "./helpers";

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

  test("wrong-code alert, rejoin toast, two-class roster isolation", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const lecturerCtx = await browser.newContext();
    const studentCtx = await browser.newContext();
    const lecturerPage = await lecturerCtx.newPage();
    const studentPage = await studentCtx.newPage();

    await registerUser(lecturerPage, `${LECTURER_EMAIL}-iso`, "lecturer", LECTURER_INVITE_CODE);
    const codeOne = await createClass(lecturerPage, "E1 Isolation One");

    // Second class: the helper's unanchored /create/i collides with the
    // dashed "Create a class" card once ≥1 class exists (§5.1 #7) — anchor.
    await lecturerPage.getByLabel("Class title").fill("E1 Isolation Two");
    await lecturerPage.getByRole("button", { name: /^create class$/i }).click();
    const cardTwo = lecturerPage.locator("li").filter({ hasText: "E1 Isolation Two" });
    await expect(cardTwo).toBeVisible();
    const codeTwo = await cardTwo
      .getByText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
      .first()
      .textContent();
    expect(codeTwo).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);

    await registerUser(studentPage, `${STUDENT_EMAIL}-iso`, "student", LECTURER_INVITE_CODE);

    // Wrong code → inline role=alert with the literal server string.
    await studentPage.getByLabel("Join code").fill("ZZZZZZ");
    await studentPage.getByRole("button", { name: /join/i }).click();
    await expect(
      studentPage.getByRole("alert").filter({ hasText: "That join code is not valid." }),
    ).toBeVisible();

    // Join the FIRST class, then REJOIN it → sonner info toast (en.json:429),
    // not a duplicated roster row. Post-first-join the dashed "Join a class"
    // card appears — anchor the submit exactly (§5.1 #7).
    await studentPage.getByLabel("Join code").fill(codeOne);
    await studentPage.getByRole("button", { name: /^join class$/i }).click();
    await expect(studentPage.getByText("E1 Isolation One", { exact: true })).toBeVisible();
    await studentPage.getByLabel("Join code").fill(codeOne);
    await studentPage.getByRole("button", { name: /^join class$/i }).click();
    await expect(
      studentPage.getByText("You are already enrolled in that class."),
    ).toBeVisible();
    await expect(
      studentPage.locator("a").filter({ hasText: "E1 Isolation One" }),
    ).toHaveCount(1);

    // Join the SECOND class → both listed; the two rosters are isolated.
    await studentPage.getByLabel("Join code").fill(codeTwo);
    await studentPage.getByRole("button", { name: /^join class$/i }).click();
    await expect(studentPage.getByText("E1 Isolation Two", { exact: true })).toBeVisible();

    await lecturerPage.getByText("E1 Isolation One", { exact: true }).click();
    await expect(lecturerPage.getByText(/student-/)).toBeVisible();
    await lecturerPage.goto("/lecturer/classes");
    await lecturerPage.getByText("E1 Isolation Two", { exact: true }).click();
    await expect(lecturerPage.getByText(/student-/)).toBeVisible();

    await lecturerCtx.close();
    await studentCtx.close();
  });
});
