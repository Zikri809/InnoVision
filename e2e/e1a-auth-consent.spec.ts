import { test, expect, type Page } from "@playwright/test";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e1a-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e1a-${TEST_TIMESTAMP}@innovision.test`;
const PASSWORD = "testpass123";

/**
 * E1a — Auth both roles + consent persists
 *
 * Gate test for Phase 1 (Scaffold).
 * Verifies:
 *  1. Register as lecturer → redirected to dashboard
 *  2. Logout → redirected to login
 *  3. Register as student (with consent checkbox) → redirected to dashboard
 *  4. Logout/in → consent state persists (shown on dashboard)
 *  5. Unconsented user is blocked from proceeding without consent
 *
 * Prerequisites: local Supabase running (`supabase start`) + migrations applied.
 */

async function registerUser(
  page: Page,
  email: string,
  role: "lecturer" | "student",
) {
  await page.goto("/register");
  await page.getByLabel("Full name (optional)").fill(`${role}-test`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);

  // Select role
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  await page.getByRole("radio", { name: roleLabel }).check();

  // Check consent checkbox (required)
  await page.getByRole("checkbox").check();

  await page.getByRole("button", { name: /register/i }).click();
}

test.describe("E1a — Auth both roles + consent persists", () => {
  test("register as lecturer, logout, register as student, consent persists", async ({
    page,
  }) => {
    // ── 1. Register as lecturer ──────────────────────────────
    await registerUser(page, LECTURER_EMAIL, "lecturer");

    // Should be redirected to dashboard
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText("InnoVision", { exact: true })).toBeVisible();
    await expect(page.getByText(LECTURER_EMAIL)).toBeVisible();
    await expect(page.getByText(/lecturer/i).first()).toBeVisible();
    await expect(page.getByText("Given ✓")).toBeVisible();

    // ── 2. Logout ────────────────────────────────────────────
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);

    // ── 3. Register as student ───────────────────────────────
    await registerUser(page, STUDENT_EMAIL, "student");

    // Should be redirected to dashboard
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText(STUDENT_EMAIL)).toBeVisible();
    await expect(page.getByText(/student/i).first()).toBeVisible();
    await expect(page.getByText("Given ✓")).toBeVisible();

    // ── 4. Logout, then login again — consent persists ───────
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel("Email").fill(STUDENT_EMAIL);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();

    // Consent should still show as given
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText("Given ✓")).toBeVisible();
  });

  test("register blocked without consent", async ({ page }) => {
    const email = `noconsent-${Date.now()}@innovision.test`;

    await page.goto("/register");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("radio", { name: "Student" }).check();

    // Register button should be disabled without consent
    await expect(page.getByRole("button", { name: /register/i })).toBeDisabled();

    // Check consent — button becomes enabled
    await page.getByRole("checkbox").check();
    await expect(
      page.getByRole("button", { name: /register/i }),
    ).toBeEnabled();
  });

  test("unauthenticated user redirected to login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});
