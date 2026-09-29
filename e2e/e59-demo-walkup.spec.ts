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

// The booth-reset test rewrites walk-up quiz state; serial keeps it from
// racing the walk-up join test under fullyParallel.
test.describe.configure({ mode: "serial" });

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

  test("A2+A1: Continue mints nothing, Start fresh mints one, curated assessment starts (consent granted at provisioning)", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      // Count guest-provisioning POSTs — the direct assertion of "Continue
      // performs NO POST" (A2).
      let guestPosts = 0;
      page.on("request", (r) => {
        if (r.url().includes("/api/demo/guest") && r.method() === "POST") guestPosts++;
      });

      // 1. Anonymous join → one guest minted.
      await page.goto(`/join/${DEMO_JOIN_CODE}`);
      await page.getByRole("button", { name: /join the demo|sertai demo/i }).click();
      await page.waitForURL(/\/student\/quizzes/, { timeout: 30_000 });
      expect(guestPosts).toBe(1);

      // 2. Reused phone → Continue card. Clicking it navigates WITHOUT a POST.
      await page.goto(`/join/${DEMO_JOIN_CODE}`);
      const continueBtn = page.getByRole("button", { name: /continue as|teruskan sebagai/i });
      await expect(continueBtn).toBeVisible({ timeout: 15_000 });
      await continueBtn.click();
      await page.waitForURL(/\/student\/quizzes/, { timeout: 30_000 });
      expect(guestPosts).toBe(1);

      // 3. Start fresh → exactly one new guest.
      await page.goto(`/join/${DEMO_JOIN_CODE}`);
      await page.getByRole("button", { name: /start fresh|mula semula/i }).click();
      await page.waitForURL(/\/student\/quizzes/, { timeout: 30_000 });
      expect(guestPosts).toBe(2);

      // 4. A1: the curated gesture-off assessment starts WITHOUT a
      // consent_required dead-end (consent was granted at provisioning).
      const card = page.locator("li", { hasText: /demo assessment/i }).first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.getByRole("button", { name: /^start$|^mula$/i }).click();
      await page.waitForURL(/\/play\//, { timeout: 30_000 });
    } finally {
      await context.close();
    }
  });

  test("A3: no spurious join-retry banner for an enrolled guest", async ({ browser }) => {
    // The banner renders only when ?join=retry is present AND the list is
    // empty AND the demo flag is on. An enrolled guest carries quizzes, so
    // the banner must stay hidden here (guards a spurious render). The
    // positive path (empty list → banner → retry POST → quizzes) is covered
    // by the guest-route payload tests — producing a genuinely empty
    // enrolled list has no UI path (no self-unenroll API).
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`/join/${DEMO_JOIN_CODE}`);
      await page.getByRole("button", { name: /join the demo|sertai demo/i }).click();
      await page.waitForURL(/\/student\/quizzes/, { timeout: 30_000 });
      await page.goto("/student/quizzes?join=retry");
      // Positive hydration signal first: the enrolled guest's walk-up card
      // must be rendered before the absence assertion means anything.
      await expect(page.locator("li", { hasText: /try innovision/i }).first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByRole("button", { name: /retry joining the demo|cuba sertai demo semula/i }),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("the /demo control room is a 404 for anonymous visitors (no oracle)", async ({ browser }) => {
    // The page self-gates (flag + demo-lecturer auth) and calls notFound() —
    // NEVER a /login redirect (demo/page.tsx: flag-gating is not
    // authorization, and visitor phones share the booth LAN).
    //
    // Assert the RENDERED contract, not the status code: Next's App Router
    // serves notFound() from a server component as HTTP 200 with the
    // not-found document (the status is 200 even though the route 404s to
    // the user). What must hold is that the anonymous visitor gets the
    // not-found UI and NOT the control room's content — and critically, is
    // not redirected to /login (which would advertise the route's existence).
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto("/demo");
      expect(page.url(), "no /login bounce — that would be an oracle").toContain("/demo");
      await expect(
        page.getByRole("heading", { name: "Demo control room" }),
        "the control room must not render for an anonymous visitor",
      ).toHaveCount(0);
      // The pre-flight checklist is the page's fingerprint — absent too.
      await expect(page.getByText("Demo mode flag")).toHaveCount(0);
      // The not-found document IS what renders.
      await expect(
        page.getByText(/Page not found|could not be found|not be found/i).first(),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("demo lecturer sees the control room pre-flight and can reset the booth", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      // Sign in as the seeded demo presenter (fixed seed password).
      await page.goto("/login");
      await page.getByLabel(/Email/).fill("demo-lecturer@innovision.test");
      await page.getByLabel("Password", { exact: true }).fill("Password123!");
      await page.getByRole("button", { name: /sign in/i }).click();
      await page.waitForURL(/\/(lecturer|student|dashboard)/, { timeout: 30_000 });

      await page.goto("/demo");
      // Pre-flight checks render with pass/fail discs (seeded local run: the
      // flag, class, and walk-up quiz checks must PASS; the sidecar/AI-key
      // checks may legitimately fail — assert the LIST, not every ✓).
      await expect(page.getByRole("heading", { name: "Demo control room" })).toBeVisible();
      await expect(page.getByText("Demo mode flag")).toBeVisible();
      await expect(page.getByText("Demo class seeded")).toBeVisible();
      await expect(page.getByText("Walk-up quiz live").first()).toBeVisible();

      // The reset island: confirm-first (blast-radius warning), then the
      // summary line. The booth is between shows in this test, so a reset is
      // safe — and it restores the exact state the first test relies on.
      await page.getByRole("button", { name: /Reset walk-up demo/i }).click();
      await expect(page.getByText(/Run it only between shows/i)).toBeVisible();
      await page.getByRole("button", { name: "Yes, reset now" }).click();
      await expect(
        page.getByText(/Deleted \d+ idle guest\(s\)[\s\S]*removed \d+ idle real enrollment\(s\)/i),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await context.close();
    }
  });
});
