import { test, expect } from "@playwright/test";

/**
 * E-64b — the SSO-CONFIGURED login surface. Runs ONLY on the `chromium-sso`
 * project (playwright.config.ts): a third app server on :3003 carrying
 * `INSTITUTIONAL_EMAIL_DOMAINS` at runtime (server env — no second build;
 * /login is force-dynamic so the per-instance flag is honest). The main
 * project ignores this file, mirroring the e2f-web-generate-flags pattern.
 *
 * A real Azure OIDC round-trip cannot run here (no tenant), so the button's
 * redirect is intercepted at the FIRST hop. The app owns:
 *   click → startInstitutionalSso() server action → signInWithOAuth({azure})
 *   → a GoTrue authorize URL → window.location.assign()
 * The harness's local GoTrue has no azure provider configured, so that URL
 * answers 400 "Unsupported provider" — which is itself the proof we want:
 * the navigation HAPPENED and carried provider=azure + our callback
 * redirect_to. Everything past GoTrue's own tenant handshake is GoTrue's,
 * not the app's.
 */

// Inside-test guard (the project's testMatch already confines the file —
// test.info() is unavailable at file scope; the m* specs use this pattern).

test.describe("E-64b — SSO-configured server", () => {
  test("Microsoft button renders with the divider and starts the OIDC redirect", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-sso", "chromium-sso project only");
    await page.goto("/login");
    const ssoBtn = page.getByRole("button", { name: /sign in with microsoft/i });
    await expect(ssoBtn).toBeVisible();
    // The "or" divider renders between the password submit and SSO.
    await expect(page.getByText("or", { exact: true })).toBeVisible();

    // Capture GoTrue's authorize navigation. The app builds it server-side
    // and hands it to window.location.assign (a full document navigation).
    const navAttempt = page.waitForEvent("request", {
      predicate: (req) =>
        req.resourceType() === "document" && req.url().includes("/auth/v1/authorize"),
      timeout: 20_000,
    });
    await ssoBtn.click();
    const req = await navAttempt;
    const url = new URL(req.url());
    // Provider selection is the app's (startInstitutionalSso hardcodes azure).
    expect(url.searchParams.get("provider")).toBe("azure");
    // The PKCE callback the app registers is OUR route — a wrong/absent
    // redirect_to would strand the exchange on a URL the app cannot serve.
    const redirectTo =
      url.searchParams.get("redirect_to") ?? url.searchParams.get("redirect_url") ?? "";
    expect(redirectTo).toContain("/auth/callback");
  });

  test("SSO callback arms still land correctly on the configured server", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-sso", "chromium-sso project only");
    await page.goto("/auth/callback?error=access_denied");
    await page.waitForURL(/\/login\?message=sso-error/);
    await expect(
      page.getByRole("alert").filter({ hasText: /Microsoft sign-in failed/ }),
    ).toBeVisible();
    // The configured server ALSO renders the button next to the banner.
    await expect(page.getByRole("button", { name: /sign in with microsoft/i })).toBeVisible();
  });
});
