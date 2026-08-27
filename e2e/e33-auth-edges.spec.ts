import { test, expect } from "@playwright/test";
import { registerUser, createClass } from "./helpers";

/**
 * E33 — auth edges not covered by e1a/e29:
 *   1. Invalid lecturer invite code → registration rejected, no account
 *      created (register is driven directly — the registerUser helper only
 *      succeeds with a VALID code).
 *   2. Authenticated user visiting /login is redirected away (middleware).
 *   3. Open-redirect payloads in ?redirect= stay same-origin
 *      (sanitizeRedirect defense-in-depth at the login page).
 *   4. Reverse role guard: a lecturer hitting /student/* is redirected to the
 *      lecturer area (e29 only covers student→lecturer).
 *   5. Authenticated /dashboard redirect lands on the role-based home.
 */

const stamp = Date.now();
const LECTURER_EMAIL = `e33-lec-${stamp}@e2e.test`;
const STUDENT_EMAIL = `e33-stu-${stamp}@e2e.test`;
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";

test.describe.configure({ mode: "serial" });

test("invalid lecturer invite code rejects signup without creating an account", async ({
  page,
}) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");

  await page.goto("/register");
  await page.getByLabel(/Full name/).fill(`e33-badlec-${stamp}`);
  await page.getByLabel(/Email/).fill(LECTURER_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill("testpass123");
  await page.getByRole("radio", { name: "Lecturer" }).check();
  await page.getByLabel("Lecturer invite code").fill("DEFINITELY-NOT-THE-CODE");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /create account|register/i }).click();

  // Stays on the register surface with the invite-code error — never lands in
  // the lecturer area.
  await expect(page).not.toHaveURL(/\/lecturer\//);
  await expect(page.getByText(/invalid invite|invite code.*(invalid|incorrect)|check.*invite/i).first()).toBeVisible({
    timeout: 20_000,
  });

  // No account was created: signing in with those credentials fails.
  await page.goto("/login");
  await page.getByLabel(/Email/).fill(LECTURER_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill("testpass123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
});

test("authenticated user visiting /login is redirected away", async ({ page }) => {
  await registerUser(page, STUDENT_EMAIL, "student", "");
  // Session cookie now set — the middleware must bounce /login.
  await page.goto("/login");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page).toHaveURL(/\/(dashboard|student\/classes)/);
});

test("open-redirect payloads in ?redirect= never leave the origin", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  for (const payload of [
    "https://evil.example.com",
    "//evil.example.com",
    "/\\evil.example.com",
  ]) {
    await page.goto(`/login?redirect=${encodeURIComponent(payload)}`);
    await expect(page).toHaveURL(/\/login/);

    // Sign in successfully — the sanitized redirect governs the landing URL.
    await page.getByLabel(/Email/).fill(STUDENT_EMAIL);
    await page.getByLabel("Password", { exact: true }).fill("testpass123");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Landing must be a same-origin app route (never the attacker origin).
    await page.waitForURL(/(dashboard|student|lecturer)/, { timeout: 30_000 });
    expect(new URL(page.url()).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
    expect(page.url()).not.toMatch(/evil\.example\.com/);
    await page.getByRole("button", { name: /log out|sign out|account/i }).first().click().catch(() => {});
    // Fall back: clear cookies if no logout affordance was found.
    await ctx.clearCookies();
  }
  await ctx.close();
});

test("reverse role guard: lecturer hitting /student/* is redirected to the lecturer area", async ({
  browser,
}) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await registerUser(page, LECTURER_EMAIL, "lecturer", INVITE);
  // Sanity: class list reachable, and we can mint a class for later specs.
  await createClass(page, `E33 Lecturer Class ${stamp}`);

  await page.goto("/student/classes");
  await expect(page).toHaveURL(/\/lecturer\/classes/);
  await ctx.close();
});

test("authenticated /dashboard redirects to the role-based landing page", async ({
  browser,
}) => {
  test.skip(!INVITE, "LECTURER_INVITE_CODE not set");

  // Lecturer → /lecturer/classes.
  const lecCtx = await browser.newContext();
  const lecPage = await lecCtx.newPage();
  await registerUser(lecPage, `e33-lec2-${stamp}@e2e.test`, "lecturer", INVITE);
  await lecPage.goto("/dashboard");
  await expect(lecPage).toHaveURL(/\/lecturer\/classes/);
  await lecCtx.close();

  // Student → /student/classes.
  const stuCtx = await browser.newContext();
  const stuPage = await stuCtx.newPage();
  await registerUser(stuPage, `e33-stu2-${stamp}@e2e.test`, "student", "");
  await stuPage.goto("/dashboard");
  await expect(stuPage).toHaveURL(/\/student\/classes/);
  await stuCtx.close();
});
