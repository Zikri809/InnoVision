import { test, expect } from "@playwright/test";
import { registerUser } from "./helpers";

/**
 * E34 — forgot/reset password journey (AU-1):
 *   1. Login page exposes the "Forgot password?" affordance.
 *   2. Submitting an email on /forgot-password ALWAYS shows the generic
 *      confirmation (no enumeration oracle — unknown accounts look identical).
 *   3. The confirm surface /reset-password/confirm exists and enforces the
 *      min-length (6) + mismatch client parity.
 *   4. Expired/no recovery session surfaces the generic reset-failed alert.
 *   5. Authenticated users are bounced off the public reset pages (middleware).
 *   6. BM copy renders after the language toggle on both new pages.
 *   7. No duplicate brand link on the confirm surface.
 *
 * The actual GoTrue recovery email delivery + click-back handoff is exercised
 * manually in hosted mode (documented in the plan's Implementation log); the
 * hermetic E2E below asserts the UI contract + no-oracle posture.
 */

const stamp = Date.now();
const STUDENT_EMAIL = `e34-stu-${stamp}@e2e.test`;
const UNKNOWN_EMAIL = `e34-ghost-${stamp}@e2e.test`;

test.describe.configure({ mode: "serial" });

test("login page links to forgot-password", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: /forgot password|lupa kata laluan/i }).click();
  await expect(page).toHaveURL(/\/forgot-password/);
});

test("forgot-password shows generic confirmation for unknown AND known-shaped emails", async ({
  page,
}) => {
  for (const email of [UNKNOWN_EMAIL, STUDENT_EMAIL]) {
    await page.goto("/forgot-password");
    await page.getByLabel(/Email/).fill(email);
    await page.getByRole("button", { name: /send reset link|hantar pautan/i }).click();

    // Identical generic confirmation regardless of account existence.
    await expect(
      page.getByText(/reset link.*(on its way|dihantar)|if that email/i),
    ).toBeVisible({ timeout: 20_000 });
    expect(page.url()).toContain("/forgot-password");
  }
});

test("reset-password/confirm enforces min length and mismatch parity", async ({ page }) => {
  await page.goto("/reset-password/confirm");

  // Mismatch guard fires before any submission to Supabase.
  await page.getByLabel(/new password/i).first().fill("abc123");
  await page.getByLabel(/confirm/i).fill("abc124");
  await page.getByRole("button", { name: /save new password|simpan/i }).click();
  await expect(page.getByText(/do not match|tidak sepadan/i)).toBeVisible();

  // Short-password guard (register-parity: min 6).
  await page.getByLabel(/new password/i).first().fill("abc12");
  await page.getByLabel(/confirm/i).fill("abc12");
  await page.getByRole("button", { name: /save new password|simpan/i }).click();
  await expect(page.getByText(/at least 6|sekurang-kurangnya 6/i)).toBeVisible();
});

test("known account still shows generic copy end-to-end (register + forgot)", async ({
  browser,
}) => {
  // Register in its own context so the recovery request below is signed-out
  // (the middleware bounces authenticated sessions off the public reset
  // pages, which is the correct posture for this flow).
  const regCtx = await browser.newContext();
  const regPage = await regCtx.newPage();
  await registerUser(regPage, STUDENT_EMAIL, "student", "");
  await regCtx.close();

  const forgotCtx = await browser.newContext();
  const page = await forgotCtx.newPage();
  await page.goto("/forgot-password");
  await page.getByLabel(/Email/).fill(STUDENT_EMAIL);
  await page.getByRole("button", { name: /send reset link|hantar pautan/i }).click();

  // Copy must be IDENTICAL to the unknown-account case (no oracle).
  await expect(
    page.getByText(/reset link.*(on its way|dihantar)|if that email/i),
  ).toBeVisible({ timeout: 20_000 });
  await forgotCtx.close();
});

test("forgot-password confirmation uses role=status and back-to-login navigates", async ({
  page,
}) => {
  await page.goto("/forgot-password");
  await page.getByLabel(/Email/).fill(UNKNOWN_EMAIL);
  await page.getByRole("button", { name: /send reset link|hantar pautan/i }).click();

  // The generic confirmation must be announced via role=status (a11y).
  const status = page.getByRole("status");
  await expect(status).toBeVisible({ timeout: 20_000 });
  await expect(status).toContainText(/reset link.*(on its way|dihantar)|if that email/i);

  // "Back to sign in" returns to /login (a button in the sent state).
  await page.getByRole("button", { name: /back to sign in|kembali ke log masuk/i }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("expired/no recovery session surfaces the generic reset-failed error", async ({
  page,
}) => {
  // Signed-out visit to the confirm surface: updateUser must fail without a
  // recovery session and render the generic error via role=alert.
  await page.goto("/reset-password/confirm");
  await page.getByLabel(/new password/i).first().fill("newpass123");
  await page.getByLabel(/confirm/i).fill("newpass123");
  await page.getByRole("button", { name: /save new password|simpan/i }).click();

  // Next's route announcer also carries role=alert, so scope to the page's
  // styled error paragraph (border-destructive) via text filter.
  const alert = page.getByRole("alert").filter({ hasText: /could not update|tidak dapat dikemas kini/i });
  await expect(alert).toBeVisible({ timeout: 20_000 });
});

test("authenticated users are bounced off the public reset pages", async ({ page }) => {
  await registerUser(page, STUDENT_EMAIL, "student", "");
  await page.goto("/forgot-password");
  await expect(page).not.toHaveURL(/\/forgot-password/);
  await expect(page).toHaveURL(/\/(dashboard|student\/classes)/);

  // /reset-password/confirm is EXEMPT from the bounce: a recovery-session
  // user arriving after the code exchange is authenticated, and bouncing them
  // would strand the reset flow. A signed-in visitor sees the form instead.
  await page.goto("/reset-password/confirm");
  await expect(page).toHaveURL(/\/reset-password\/confirm/);
  await expect(page.getByRole("button", { name: /save new password|simpan/i })).toBeVisible();
});

test("new reset pages render BM copy after language toggle", async ({ page }) => {
  await page.goto("/forgot-password");
  await page.getByRole("button", { name: "Switch language", exact: true }).click();
  // The toggle's aria-label flips to BM once the locale swap + refresh lands.
  await expect(page.getByRole("button", { name: "Tukar bahasa", exact: true })).toBeVisible();
  await expect(page.getByText("Tetapkan semula kata laluan", { exact: true })).toBeVisible();

  // Locale cookie persisted — the confirm page is already BM.
  await page.goto("/reset-password/confirm");
  await expect(page.getByText("Pilih kata laluan baharu", { exact: true })).toBeVisible();

  // Toggling back returns to EN copy.
  await page.getByRole("button", { name: "Tukar bahasa", exact: true }).click();
  await expect(page.getByText("Choose a new password", { exact: true })).toBeVisible();
});

test("confirm page renders a single brand link (no duplicate logo)", async ({ page }) => {
  await page.goto("/reset-password/confirm");
  // Accessible name concatenates the "IV" mark + wordmark, so match substring.
  await expect(page.getByRole("link", { name: /InnoVision/ })).toHaveCount(1);
});
