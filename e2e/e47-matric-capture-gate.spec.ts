import { test, expect } from "@playwright/test";
import { registerUser, resolveServiceClient, E2E_PASSWORD } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

// Fail-fast: 5s in-page assertion budget (e18 convention ONLY), 150s ceiling,
// skip without invite code / service-role seam. No networkidle, no fixed
// sleeps; polling uses expect.poll with a bounded timeout.
const fast = expect.configure({ timeout: 5_000 });

/**
 * E47 — AU-2 matric capture gate, END TO END (the OAuth shape without real
 * Entra):
 *
 * A real SSO round-trip can't run in the harness (no Microsoft tenant), and
 * the admin-magic-link seam is unusable for the same reason AU-1 documented
 * for recovery links: admin action_links carry GoTrue's IMPLICIT
 * `#access_token` shape and redirect to the configured site_url (never our
 * harness port, never a PKCE `?code=` our callback handles) — probed live
 * during the E2E audit. So the identity is seeded through the SERVICE-ROLE
 * admin API (createUser WITH a password — needed to sign in through /login
 * — email confirmed, and NO signup metadata except the OIDC `name` claim
 * that 0038 maps to full_name) and signed in through the real /login form.
 *
 * Everything app-relevant about the OAuth shape is preserved: the
 * handle_new_user trigger fires on the admin-created row with NO
 * registration-path metadata → profile.matric_no is NULL (the gate's exact
 * precondition). Downstream is real app behavior:
 *
 * 1. GATE: the student layout redirects /student/* → /matric-capture.
 * 2. CAPTURE: reserved/invalid matric rejected with the signup copy; a valid
 *    one lands on /student/classes.
 * 3. GONE: /student/quizzes renders (gate passes); /matric-capture bounces
 *    to /dashboard.
 * 4. Control: a password-registered student NEVER sees the gate.
 */
test.describe("E47 — AU-2 matric capture gate", () => {
  test("null-matric OAuth-shaped user is gated, captures a matric, then passes", async ({ browser }, testInfo) => {
    testInfo.setTimeout(150_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    const admin = resolveServiceClient();
    test.skip(!admin, "SUPABASE_SERVICE_ROLE_KEY not available (non-local run)");

    const email = `sso-e47-${TEST_TIMESTAMP}@innovision.test`;

    // ── Seed the OAuth-shaped identity through the admin API ──
    // A password is required ONLY to sign in through /login (the admin-link
    // seam is dead — see the doc comment). No signup metadata → the trigger's
    // matric branch stays NULL and the 0038 name claim maps `name` →
    // full_name (asserted via the user menu after capture).
    const { data: created, error: createErr } = await admin!.auth.admin.createUser({
      email,
      password: E2E_PASSWORD,
      email_confirm: true,
      user_metadata: { name: "SSO E47 Student" },
    });
    expect(createErr).toBeNull();
    expect(created?.user?.id).toMatch(/^[0-9a-f-]{36}$/);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Real sign-in through the app (same choreography as registerUser's
    // poisoned-retry fallback).
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await fast(page).toHaveURL(/\/(dashboard|student)/, { timeout: 15_000 });

    // ── GATE: the student area bounces a null-matric user to capture ──
    await page.goto("/student/classes");
    await fast(page).toHaveURL(/\/matric-capture/);

    // ── Invalid input: same copy contract as signup ──
    // The reserved-range rejection (99xxxx, 6 digits → button enabled).
    const input = page.getByLabel(/matric/i);
    await fast(input).toBeVisible();
    await input.fill("991234");
    await page.getByRole("button", { name: /finish setup/i }).click();
    await fast(page.getByText(/reserved by the system|dikhaskan oleh sistem/i)).toBeVisible();

    // The shape rejection must go through the SERVER path: the form's client
    // guard disables submit unless the value is exactly 6 chars, so a 6-char
    // non-digit ("12a456") is the reachable way to exercise the server's
    // normalizeMatric → matricInvalid copy (a 5-digit value can never submit —
    // the button is disabled, maxLength=6).
    await input.fill("12a456");
    await page.getByRole("button", { name: /finish setup/i }).click();
    await fast(page.getByText(/exactly 6 digits|tepat 6 digit/i)).toBeVisible();

    // ── Valid capture → student area ──
    const matric = `8${String(TEST_TIMESTAMP).slice(-5)}`;
    await input.fill(matric);
    await page.getByRole("button", { name: /finish setup/i }).click();
    await fast(page).toHaveURL(/\/student\/classes/, { timeout: 15_000 });

    // Gate passes now: /student/quizzes renders instead of bouncing.
    await page.goto("/student/quizzes");
    await expect(page).toHaveURL(/\/student\/quizzes/, { timeout: 15_000 });

    // The 0038 name claim surfaced: the app-shell menu trigger shows only
    // initials; the full name (trigger-mapped from the OIDC `name` claim)
    // renders in the profile dialog — open it and assert.
    await page.getByRole("button", { name: "Your InnoVision account" }).click();
    await fast(page.getByText("SSO E47 Student")).toBeVisible();
    await page.keyboard.press("Escape");

    // The capture page itself now bounces a captured student to /dashboard.
    await page.goto("/matric-capture");
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

    await ctx.close();
  });

  test("control: a password-registered student never sees the gate", async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await registerUser(page, `student-e47c-${TEST_TIMESTAMP}@innovision.test`, "student", LECTURER_INVITE_CODE);
    await fast(page.getByRole("heading", { name: "My Classes" })).toBeVisible();

    await page.goto("/student/quizzes");
    await expect(page).toHaveURL(/\/student\/quizzes/, { timeout: 15_000 });

    // Direct visit bounces straight to the dashboard (matric already set).
    await page.goto("/matric-capture");
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

    await ctx.close();
  });
});
