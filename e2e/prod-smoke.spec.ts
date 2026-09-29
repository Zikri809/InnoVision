import { test, expect, type Page } from "@playwright/test";

/**
 * PROD SMOKE — read-only pulse against the LIVE deployment.
 * See docs/PROD_TESTING.md §2.
 *
 * Run ONLY as:
 *   PROD_SMOKE=1 PROD_URL=https://<prod-host> \
 *     PROD_SMOKE_LECTURER_EMAIL=… PROD_SMOKE_LECTURER_PASSWORD=… \
 *     PROD_SMOKE_STUDENT_EMAIL=… PROD_SMOKE_STUDENT_PASSWORD=… \
 *     [PROD_SMOKE_SHARE_CODE=…] \
 *     npm run test:e2e:prod
 *
 * Rules (hard):
 *  - No registration, no class/quiz creation, no joins, no reveals, no
 *    deletes, no AI generation, no camera/face flows, no form SUBMITS that
 *    send mail (forgot-password renders only).
 *  - The ONLY play surface touched is a SEEDED `/s/<code>` share link:
 *    `answer_student_question` performs ZERO writes by construction.
 *  - The health endpoint is called twice total (anon + lecturer) — it is
 *    budgeted at 30/min/IP and every call is deliberate.
 *  - Every credential-gated test SKIPS INDIVIDUALLY when its env is absent,
 *    so a bare `PROD_URL`-only run still executes the anonymous half (and
 *    never trips the fail-on-fully-skipped reporter).
 */

test.setTimeout(90_000);

const PROD_URL = process.env.PROD_URL ?? process.env.PROD_SMOKE_URL ?? "";
const GATE_ON = process.env.PROD_SMOKE === "1";

// File gate: invisible to every default project (playwright.config.ts
// testIgnores prod-smoke.spec.ts everywhere except the `prod-smoke`
// project), skipped loudly without the explicit opt-in.
test.skip(!GATE_ON, "prod smoke runs only with PROD_SMOKE=1 (see docs/PROD_TESTING.md §2)");
test.skip(!PROD_URL, "prod smoke needs PROD_URL=https://<prod-host>");

const LEC_EMAIL = process.env.PROD_SMOKE_LECTURER_EMAIL ?? "";
const LEC_PASS = process.env.PROD_SMOKE_LECTURER_PASSWORD ?? "";
const STU_EMAIL = process.env.PROD_SMOKE_STUDENT_EMAIL ?? "";
const STU_PASS = process.env.PROD_SMOKE_STUDENT_PASSWORD ?? "";
const SHARE_CODE = process.env.PROD_SMOKE_SHARE_CODE ?? "";

/** Runner-side kill-switch tripwire: sending harness env at prod is a mistake.
 * NOTE: NEXT_PUBLIC_INTEGRITY_HARDENING_OFF is deliberately NOT in this list —
 * playwright.config.ts itself assigns process.env.NEXT_PUBLIC_INTEGRITY_HARDENING_OFF
 * at load (:196-197), so the runner always carries it. The in-page
 * [integrity-gate] console check below is the true prod signal for that flag. */
const HARNESS_KEYS = [
  "NEXT_PUBLIC_E2E_FAKE_SEAM",
  "FACE_MOCK_ENABLED",
  "E2E_RATE_LIMIT_DISABLED",
  "NEXT_PUBLIC_DEMO_MODE",
] as const;

async function loginAs(page: Page, email: string, password: string, landing: RegExp) {
  await page.goto("/login");
  await page.getByLabel(/Email/).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(landing, { timeout: 60_000 });
}

test("P0 — target is remote and harness kill switches are not armed", async ({ page }) => {
  for (const key of HARNESS_KEYS) {
    expect(process.env[key] !== "1", `${key} must not be "1" for a prod run`).toBe(true);
  }
  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (/integrity-gate/i.test(msg.text())) warnings.push(msg.text());
  });
  await page.goto("/login");
  const host = new URL(page.url()).hostname.toLowerCase();
  expect(
    host !== "localhost" && host !== "127.0.0.1" && host !== "::1",
    `refusing to run prod smoke against loopback (${host}) — set PROD_URL to the live host`,
  ).toBe(true);
  // The fake-tracker seams must be absent from the prod bundle.
  const seam = await page.evaluate(() => ({
    hand: typeof (window as unknown as Record<string, unknown>).__INNOVISION_FAKE_HAND_TRACKER__,
    face: typeof (window as unknown as Record<string, unknown>).__INNOVISION_FAKE_FACE_CONTROL__,
  }));
  expect(seam.hand, "fake hand seam baked into prod bundle").toBe("undefined");
  expect(seam.face, "fake face seam baked into prod bundle").toBe("undefined");
  expect(warnings, "[integrity-gate] hardening kill switch baked into prod").toEqual([]);
});

test("P1 — anonymous health probe is liveness-shaped (no cron/integrity keys)", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok(), `health status ${res.status()}`).toBe(true);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.ok).toBe(true);
  expect(body.db).toMatchObject({ reachable: true });
  expect(typeof (body.db as { latencyMs?: unknown }).latencyMs).toBe("number");
  expect(body.face).toMatchObject({ available: expect.any(Boolean) });
  // Gate S6: anon callers get NO ops detail.
  expect("cron" in body, "anon health must not leak cron topology").toBe(false);
  expect("integrity" in body, "anon health must not leak the integrity snapshot").toBe(false);
});

test("P2 — logged-out visitors bounce to /login; auth surfaces render (no submits)", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/student/quizzes");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByLabel(/Email/)).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await page.goto("/lecturer/classes");
  await expect(page).toHaveURL(/\/login/);
  // Forgot-password renders; NEVER submit (would send real mail + burn budgets).
  await page.goto("/forgot-password");
  await expect(page.getByLabel(/Email/)).toBeVisible();
  await ctx.close();
});

test("P3 — login language toggle flips copy and persists", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  const toggle = page.getByRole("button", { name: /switch language/i });
  await expect(toggle).toBeVisible();
  const before = await page.locator("body").innerText();
  await toggle.click();
  await expect
    .poll(async () => page.locator("body").innerText(), { timeout: 10_000 })
    .not.toBe(before);
  const after = await page.locator("body").innerText();
  await page.reload();
  await expect
    .poll(async () => page.locator("body").innerText(), { timeout: 10_000 })
    .toBe(after);
  await ctx.close();
});

test("P4 — lecturer lists + bell render", async ({ browser }) => {
  test.skip(!LEC_EMAIL || !LEC_PASS, "PROD_SMOKE_LECTURER_EMAIL/_PASSWORD not set");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginAs(page, LEC_EMAIL, LEC_PASS, /\/lecturer\/classes/);
  await expect(page.getByRole("heading", { name: /my classes|kelas saya/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /notifications/i }).first()).toBeVisible();
  await page.goto("/lecturer/quizzes");
  await expect(page.locator("body")).toContainText(/quiz|kuiz/i);
  await ctx.close();
});

test("P5 — lecturer health carries cron + integrity", async ({ browser }) => {
  test.skip(!LEC_EMAIL || !LEC_PASS, "PROD_SMOKE_LECTURER_EMAIL/_PASSWORD not set");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginAs(page, LEC_EMAIL, LEC_PASS, /\/lecturer\/classes/);
  const res = await page.request.get("/api/health");
  expect(res.ok(), `lecturer health status ${res.status()}`).toBe(true);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.ok).toBe(true);
  const cron = body.cron as { jobs?: unknown[] } | undefined;
  expect(Array.isArray(cron?.jobs), "lecturer health must include cron jobs").toBe(true);
  const integrity = body.integrity as { flags24h?: unknown } | undefined;
  expect(typeof integrity?.flags24h).toBe("number");
  await ctx.close();
});

test("P6 — student lists render; role guard bounces off the lecturer area", async ({ browser }) => {
  test.skip(!STU_EMAIL || !STU_PASS, "PROD_SMOKE_STUDENT_EMAIL/_PASSWORD not set");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginAs(page, STU_EMAIL, STU_PASS, /\/student\/classes/);
  await expect(page.getByRole("button", { name: /notifications/i }).first()).toBeVisible();
  await page.goto("/student/quizzes");
  await expect(page.locator("body")).toContainText(/quiz|kuiz/i);
  await page.goto("/lecturer/classes");
  await expect(page).toHaveURL(/\/student\/classes/);
  await ctx.close();
});

test("P7 — /join: malformed code is neutral; well-formed code confirms blind (no oracle)", async ({
  browser,
}) => {
  test.skip(!STU_EMAIL || !STU_PASS, "PROD_SMOKE_STUDENT_EMAIL/_PASSWORD not set");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginAs(page, STU_EMAIL, STU_PASS, /\/student\/classes/);
  // Invalid charset ("!" is outside the join alphabet) → neutral card, link
  // CTA only. Joining is never automated (failed POSTs burn the join budget).
  await page.goto("/join/zz!");
  await expect(page.getByText(/not valid|tidak sah/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /confirm|join class|sertai/i })).toHaveCount(0);
  // Well-formed code → confirm card that echoes ONLY the code. The page
  // performs zero lookups (no-oracle rule): the class title arrives only
  // inside the join POST response, so nothing here can leak existence.
  await page.goto("/join/ZZZZZZ");
  await expect(page.getByText(/join this class|sertai kelas ini/i)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("ZZZZZZ", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /join class|sertai kelas/i }),
  ).toBeVisible();
  await ctx.close();
});

test("P8 — seeded share link resolves and grades (zero-write RPC)", async ({ browser }) => {
  test.skip(!STU_EMAIL || !STU_PASS, "PROD_SMOKE_STUDENT_EMAIL/_PASSWORD not set");
  test.skip(!SHARE_CODE, "PROD_SMOKE_SHARE_CODE not set (seed one, never mint from automation)");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginAs(page, STU_EMAIL, STU_PASS, /\/student\/classes/);
  await page.goto(`/s/${SHARE_CODE}`);
  const options = page.getByRole("button", { name: /^[A-E] / });
  await expect(options.first()).toBeVisible({ timeout: 15_000 });
  // Answer the first question only: proves resolve + barrier view + grading
  // without committing to a full play-through of unknown length.
  await options.first().click();
  await expect(options.first()).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
  await ctx.close();
});

test("P9 — theme toggle flips and persists (account menu)", async ({ browser }) => {
  test.skip(
    (!LEC_EMAIL || !LEC_PASS) && (!STU_EMAIL || !STU_PASS),
    "no smoke credentials set (lecturer preferred, student fallback)",
  );
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (LEC_EMAIL && LEC_PASS) await loginAs(page, LEC_EMAIL, LEC_PASS, /\/lecturer\/classes/);
  else await loginAs(page, STU_EMAIL, STU_PASS, /\/student\/classes/);
  // Account-menu trigger carries the product name ("Your Easy2U account").
  const trigger = page.getByRole("button", { name: /your .* account/i });
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Two theme-toggles exist app-wide (header pill + account menu) — scope to
  // the open menu or the locator strict-mode-violates.
  const toggle = dialog.getByTestId("theme-toggle");
  await expect(toggle).toBeVisible();
  // Preference cycles system → light → dark (order is an implementation
  // detail); assert the STORED preference flips and survives reload — the
  // resolved `.dark` class depends on OS scheme in headless runs, so it is
  // not a stable signal here.
  const before = await toggle.getAttribute("data-theme-preference");
  await toggle.click();
  await expect
    .poll(async () => toggle.getAttribute("data-theme-preference"), {
      timeout: 10_000,
    })
    .not.toBe(before);
  const after = await toggle.getAttribute("data-theme-preference");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect
    .poll(
      async () =>
        page.getByTestId("theme-toggle").first().getAttribute("data-theme-preference"),
      { timeout: 10_000 },
    )
    .toBe(after);
  await ctx.close();
});

test.describe("mobile viewport", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("P10 — login renders at 375px with no horizontal overflow", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel(/Email/)).toBeVisible();
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(overflow.scroll, "horizontal overflow at 375px").toBeLessThanOrEqual(overflow.inner + 1);
  });
});

test("P11 — no raw i18n keys leak on visited surfaces", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const texts: string[] = [];
  for (const path of ["/login", "/forgot-password", "/join/zz"]) {
    await page.goto(path);
    texts.push(await page.locator("body").innerText());
  }
  const scrubbed = texts
    .join("\n")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "") // emails
    .replace(/https?:\/\/\S+/g, "") // urls
    .replace(/\d+\.\d+/g, ""); // versions
  const leaked = scrubbed.match(/^[a-z][\w]*(\.[\w]+)+$/gim) ?? [];
  const allow = new Set(["e.g", "i.e"]);
  const hits = [...new Set(leaked.map((s) => s.trim()))].filter((s) => !allow.has(s.toLowerCase()));
  expect(hits, `raw i18n keys rendered: ${hits.join(", ")}`).toEqual([]);
  await ctx.close();
});
