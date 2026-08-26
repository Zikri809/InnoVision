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
    // Lecturers show the role chip — the consent card is students-only
    // (lecturer consent is auto-granted at signup and never gated in UI).
    await expect(page.getByText("Lecturer", { exact: true })).toBeVisible();

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

  test("wrong-password error, duplicate-email generic signup, logout goBack re-guard", async ({
    page,
  }) => {
    // Self-contained account so the parallel worker never races test 1's signup.
    const email = `e1a-dup-${TEST_TIMESTAMP}@innovision.test`;
    await registerUser(page, email, "student", "");

    // Derive an UNUSED deterministic matric from a distinct seed, so the
    // duplicate-email attempt below can never be blocked early by the matric
    // pre-check (register.ts:158) — only the email-uniqueness check fires.
    const seed = `e1a-dup-seed-${TEST_TIMESTAMP}@innovision.test`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 100000;
    const unusedMatric = `8${String(h).padStart(5, "0")}`;

    // Wrong password → localized generic error surfaces inline.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("wrongpass123");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Invalid email or password." }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    // Duplicate-email signup → the GENERIC signupFailed copy (register.ts:185
    // — no email-specific key so the form can't oracle registered addresses).
    await page.goto("/register");
    await page.getByLabel(/Full name/).fill("Dup User");
    await page.getByLabel(/Email/).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole("radio", { name: "Student" }).check();
    await page.getByLabel(/Matric number/i).fill(unusedMatric);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /create account|register/i }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: /could not create the account/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/register/);

    // Sign in, then logout → the shell re-guards even a back-navigation.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/student\/classes/);
    await page.getByRole("button", { name: /account/i }).click();
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goBack();
    await expect(page).toHaveURL(/\/login/);
  });
});
