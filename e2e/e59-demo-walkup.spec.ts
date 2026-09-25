import { expect, test } from "@playwright/test";

/**
 * e59 — demo walk-up flow, OPT-IN.
 *
 * Run ONLY against a server built with NEXT_PUBLIC_DEMO_MODE=1 and a seeded
 * demo class (docs/plans/PLAN_DEMO_MODE.md):
 *
 *   NEXT_PUBLIC_DEMO_MODE=1 NEXT_PUBLIC_E2E_FAKE_SEAM=1 FACE_MOCK_ENABLED=1 \
 *   E2E_RATE_LIMIT_DISABLED=1 npm run build && npm run start
 *   npm run seed:demo
 *   DEMO_MODE_E2E=1 npx playwright test e2e/e59-demo-walkup.spec.ts
 *
 * The main harness never sets NEXT_PUBLIC_DEMO_MODE, so the demo branch is dead
 * there and this spec would prove nothing — the skip IS the contract (mirrors
 * e51's opt-in posture).
 */
test.skip(!process.env.DEMO_MODE_E2E, "opt-in: DEMO_MODE_E2E=1 (demo-mode build)");
test.skip(
  process.env.NEXT_PUBLIC_DEMO_MODE !== "1",
  "NEXT_PUBLIC_DEMO_MODE is not 1 — this build has no demo branch",
);

/** Matches DEMO_JOIN_CODE in src/lib/demo/gate.ts. */
const DEMO_JOIN_CODE = "SCAN23";

test.describe("e59 — demo walk-up", () => {
  test("anonymous scanner of the demo QR gets a guest account and reaches the quiz", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    // A FRESH context = an anonymous visitor with no session cookie.
    const context = await browser.newContext();

    try {
      const page = await context.newPage();
      await page.goto(`/join/${DEMO_JOIN_CODE}`);

      // The demo card renders instead of the login wall.
      const joinBtn = page.getByRole("button", { name: /join the demo|sertai demo/i });
      await expect(joinBtn).toBeVisible({ timeout: 15_000 });
      await joinBtn.click();

      // Lands on the student quiz list, signed in as the guest.
      await page.waitForURL(/\/student\/quizzes/, { timeout: 30_000 });

      // The walk-up practice quiz card is present; its Start button is the
      // affordance (the title is a card, not a link).
      const card = page
        .locator("li", { hasText: /try innovision/i })
        .first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.getByRole("button", { name: /^start$|^mula$/i }).click();

      // Reaches the practice player without a camera gate.
      await page.waitForURL(/\/play\//, { timeout: 30_000 });
    } finally {
      await context.close();
    }
  });

  test("the demo QR does not bypass the login wall for a non-demo code", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto("/join/DEMK42");
      // The ordinary anonymous bounce to /login.
      await page.waitForURL(/\/login/, { timeout: 15_000 });
      expect(page.url()).toContain("/login");
    } finally {
      await context.close();
    }
  });
});
