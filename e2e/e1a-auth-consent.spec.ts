import { test, expect } from "@playwright/test";
import { registerUser, E2E_PASSWORD } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-e1a-${TEST_TIMESTAMP}@innovision.test`;
const STUDENT_EMAIL = `student-e1a-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

/**
 * E1a — Auth both roles + consent persists
 *
 * Gate test for Phase 1 (Scaffold).
 * Verifies:
 *  1. Register as lecturer (requires LECTURER_INVITE_CODE) → lecturer landing
 *  2. Logout → redirected to login
 *  3. Register as student (with consent checkbox) → student landing
 *  4. Logout/in → consent state persists (shown on the landing page)
 *  5. Unconsented user is blocked from proceeding without consent
 *
 * Prerequisites: local Supabase running (`supabase start`) + migrations applied.
 * The LECTURER_INVITE_CODE env var must be set (CI/local .env.local).
 */

test.describe("E1a — Auth both roles + consent persists", () => {
  test("register as lecturer, logout, register as student, consent persists", async ({
    page,
  }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    // ── 1. Register as lecturer ──────────────────────────────
    await registerUser(page, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(page).toHaveURL(/\/lecturer\/classes/);
    await expect(
      page.getByRole("heading", { name: "My Classes" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /account/i }).click();
    await expect(page.getByText(LECTURER_EMAIL)).toBeVisible();
    await expect(page.getByText("Biometric consent given")).toBeVisible();

    // ── 2. Logout ────────────────────────────────────────────
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);

    // ── 3. Register as student ───────────────────────────────
    await registerUser(page, STUDENT_EMAIL, "student", LECTURER_INVITE_CODE);
    await expect(page).toHaveURL(/\/student\/classes/);
    await page.getByRole("button", { name: /account/i }).click();
    await expect(page.getByText(STUDENT_EMAIL)).toBeVisible();
    await expect(page.getByText("Biometric consent given")).toBeVisible();

    // ── 4. Logout, then login again — consent persists ───────
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel("Email").fill(STUDENT_EMAIL);
    await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();

    // Consent should still show as given inside user menu
    await expect(page).toHaveURL(/\/student\/classes/);
    await page.getByRole("button", { name: /account/i }).click();
    await expect(page.getByText("Biometric consent given")).toBeVisible();
  });

  test("register blocked without consent", async ({ page }) => {
    const email = `noconsent-${Date.now()}@innovision.test`;

    await page.goto("/register");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole("radio", { name: "Student" }).check();

    // Register button should be disabled without consent
    await expect(page.getByRole("button", { name: /create account|register/i })).toBeDisabled();

    // Check consent — button becomes enabled
    await page.getByRole("checkbox").check();
    await expect(
      page.getByRole("button", { name: /create account|register/i }),
    ).toBeEnabled();
  });

  test("unauthenticated user redirected to login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});
