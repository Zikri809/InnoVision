import { test, expect } from "@playwright/test";
import { fastRegisterUser } from "./helpers";

/**
 * E-64 — institutional SSO login surfaces (AU-2, audits 2 H-02/M-16/M-18).
 *
 * A real Azure OIDC round-trip cannot run in CI (no tenant), but everything
 * the login page and the shared PKCE callback RENDER can be driven exactly:
 * the button's existence is env-gated server-side (`isSsoConfigured()`),
 * the callback's error arms land back on /login with `?message=` params,
 * and the anonymous wall must stay the wall — never a leak.
 *
 * The SSO-configured server: `chromium-sso` runs against a third app server
 * (port 3003) carrying `INSTITUTIONAL_EMAIL_DOMAINS` (playwright.config.ts),
 * mirroring the e2f-web-generate-flags pattern — server-RUNTIME env needs no
 * second build. `/login` reads the flag in a server component, so the page
 * is force-dynamic (the harness must be able to flip it per instance).
 *
 * Main-project tests pin the DEFAULT (button absent) + the callback arms:
 *   * anonymous /auth/callback?error=… → /login?message=sso-error → the
 *     role=alert banner with the generic provider-failure copy
 *   * anonymous /auth/callback (no code, no error) → silent /login bounce
 *   * the domain-rejection arm (`?message=sso-domain`) renders the
 *     nonInstitutional copy (M-16: no personal-Microsoft-account session)
 *   * the callback redirects stay on PUBLIC origins (H-02: Site URL, not
 *     the Host header) — asserted by landing on OUR origin after an error
 *     round-trip
 *   * authenticated users are bounced OFF /login by the proxy (sso message
 *     arms included — a signed-in user must never see login banners)
 *
 * The CONFIGURED surface (button + divider + the OIDC redirect attempt)
 * lives in e64b-sso-configured.spec.ts on the dedicated `chromium-sso`
 * project — a third app server on :3003 carrying
 * `INSTITUTIONAL_EMAIL_DOMAINS` at runtime (mirrors the
 * e2f-web-generate-flags pattern).
 */

const stamp = Date.now();
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";

test.describe.configure({ mode: "serial" });

test.describe("E-64 — SSO login states (default server, SSO off)", () => {
  test("login page renders NO Microsoft button when SSO is unconfigured", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /sign in with microsoft/i })).toHaveCount(0);
    // The ordinary password form is intact.
    await expect(page.getByLabel(/Email/)).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  });

  test("callback error arm lands on the generic ssoFailed banner", async ({ page }) => {
    // GoTrue error round-trip: no code, error params present (audit-2 M-18).
    await page.goto("/auth/callback?error=access_denied&error_description=User+denied+access");
    await page.waitForURL(/\/login\?message=sso-error/);
    await expect(
      page.getByRole("alert").filter({ hasText: /Microsoft sign-in failed/ }),
    ).toBeVisible();
    // The landing is the REAL login form (the user can immediately retry).
    await expect(page.getByLabel(/Email/)).toBeVisible();
  });

  test("callback without code and without error bounces silently to /login", async ({ page }) => {
    await page.goto("/auth/callback");
    await page.waitForURL(/\/login/);
    // NO sso banner on the silent bounce.
    await expect(
      page.getByRole("alert").filter({ hasText: /Microsoft sign-in failed/ }),
    ).toHaveCount(0);
  });

  test("domain-rejection arm renders the nonInstitutional copy", async ({ page }) => {
    await page.goto("/login?message=sso-domain");
    await expect(
      page.getByRole("alert").filter({ hasText: /isn't a university Microsoft account/ }),
    ).toBeVisible();
  });

  test("error round-trips stay on the public origin (H-02)", async ({ page }) => {
    await page.goto("/auth/callback?error=server_error");
    await page.waitForURL(/\/login\?message=sso-error/);
    // resolveSiteOrigin falls back to the request origin locally — the URL
    // must be OUR base, never a Host-derived internal address.
    expect(new URL(page.url()).origin).toBe("http://localhost:3001");
  });

  test("an authenticated user is bounced off /login even with sso params", async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    test.skip(!INVITE, "LECTURER_INVITE_CODE not set");

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await fastRegisterUser(page, `student-e64-${stamp}@innovision.test`, "student", INVITE);
    await page.goto("/login?message=sso-domain");
    // The proxy sends authenticated users to the role landing.
    await page.waitForURL(/\/(student|lecturer)\//, { timeout: 15_000 });
    await ctx.close();
  });
});
