import { test, expect } from "@playwright/test";
import { registerUser } from "./helpers";

/**
 * E34 — root error boundary (src/app/error.tsx).
 * The dev-only /dev/error page throws on render, which routes the crash into
 * the app-level boundary. Asserts:
 *   1. The boundary card renders (title + body copy + actions).
 *   2. "Return home" navigates to /.
 * Retry (reset) re-renders the crashing page, which throws again — the
 * boundary persists by design, so only the navigation action is asserted as a
 * successful exit path.
 *
 * Requires an authenticated session: since the proxy fix (middleware actually
 * running), anonymous visitors are bounced to /login before reaching the page.
 */

const stamp = Date.now();

test.beforeEach(async ({ page }) => {
  await registerUser(page, `e34-stu-${stamp}@e2e.test`, "student", "");
});

test("error boundary renders with actionable actions", async ({ page }) => {
  await page.goto("/dev/error");
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/unexpected error/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Return home", exact: true })).toBeVisible();
});

test("error boundary 'Return home' navigates to /", async ({ page }) => {
  await page.goto("/dev/error");
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("link", { name: "Return home", exact: true }).click();
  // "/" is reachable but immediately hub-redirects an authenticated user
  // (/ → /dashboard → role landing) — the middleware + dashboard chain.
  await expect(page).toHaveURL(/\/(student|lecturer)\//, { timeout: 20_000 });
});
