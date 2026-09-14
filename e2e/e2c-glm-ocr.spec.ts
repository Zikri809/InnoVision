import { test, expect } from "@playwright/test";
import { registerUser } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_EMAIL = `lecturer-glm-${TEST_TIMESTAMP}@innovision.test`;
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

/**
 * E2-GLM — Lecturer: GLM-OCR (local Docker/vLLM) extraction → AI generation.
 *
 * Unlike E2 (which uses a text-layer PDF), this test uploads a SCANNED image
 * (no native text layer), so the extraction pipeline falls through to the
 * selected OCR engine. It selects GLM-OCR, whose calls run SERVER-SIDE: the
 * browser POSTs the rasterized page to the app's own proxy
 * (`POST /api/extract/ocr`), and the route talks to the lecturer's local
 * GLM-OCR container (`{GLM_BASE_URL}/v1/chat/completions`).
 *
 * The header here used to claim the browser called the container directly.
 * That stopped being true when the server-side proxy landed (the container is
 * loopback-bound, so a browser on another machine could not reach it, and the
 * remote leg's key must never reach the browser). Do NOT reintroduce a
 * browser→container call: `GLM_BASE_URL` / `ZAI_API_KEY` are server-only.
 *
 * The subsequent quiz generation still hits the mock AI server (AI_BASE_URL),
 * so no real LLM is contacted for question generation.
 *
 * GATING: the picker only shows the AI Vision option when the app's OWN probe
 * (`GET /api/extract/ocr` → `glmEngineInfo()`) reports `available: true`. That
 * probe requires an authenticated LECTURER, so it cannot run before
 * registration. This spec therefore does two things:
 *   1. a CHEAP PRE-CHECK on the container itself (`{GLM_BASE_URL}/v1/models`,
 *      loopback, unauthenticated) — when the container is simply not running
 *      we skip in ~2s instead of after a full registration journey; and
 *   2. an APP-PROBE assertion after registration, which is the real gate and
 *      the one the picker uses.
 *
 * CI note: GitHub Actions runners do NOT run the GLM-OCR Docker container, so
 * this spec is skipped when `CI` is set (the E2E suite's Playwright config
 * already runs `workers: 1` + `retries: 2` in CI). The GLM-OCR path remains a
 * manual pre-demo checklist item (TESTING §7 #3) and is covered locally by
 * running `docker compose up -d glm-ocr` on the dev machine.
 *
 * ⚠️ LOCAL LEG ONLY. This spec asserts `provider: "local"` (see the app-probe
 * block below) and therefore CANNOT pass against a remote-leg (VPS)
 * deployment — it fails on the probe by design. Use `scripts/vps-smoke.mjs`
 * (ops gate O4) to check the remote leg against a real host.
 */
test.describe("E2-GLM — GLM-OCR extraction from a scanned image", () => {
  test("lecturer extracts a scanned image with GLM-OCR, then generates", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
    test.skip(!!process.env.CI, "GLM-OCR requires the local Docker container, not provisioned in CI");

    // Cheap pre-check: is the container up at all? The app's own probe (below)
    // is the real gate, but it needs a session, so this avoids a full
    // registration journey just to discover the container is not running.
    // GLM_BASE_URL is the same server-side var the route reads; default matches
    // src/lib/ai/glm-provider.ts.
    const glmBaseUrl = process.env.GLM_BASE_URL ?? "http://localhost:11434";
    const glmHealthy = await fetch(`${glmBaseUrl.replace(/\/$/, "")}/v1/models`, {
      signal: AbortSignal.timeout(2000),
    })
      .then((r) => r.ok)
      .catch(() => false);
    test.skip(!glmHealthy, `GLM-OCR container is not running at ${glmBaseUrl}`);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // ── 1. Lecturer registers + creates a class + draft quiz ────
    await registerUser(page, LECTURER_EMAIL, "lecturer", LECTURER_INVITE_CODE);
    await expect(page.getByRole("heading", { name: "My Classes" })).toBeVisible();

    // The app's OWN probe — the same GET the picker's `glmEngineInfo()` calls,
    // through the authenticated browser context (so the session cookie is
    // present). This is the real gate: the picker only renders the option when
    // `available` is true, and the response shape is the client contract.
    //
    // ⚠️ LOCAL-LEG-ONLY SPEC — DO NOT run this suite against a remote-leg (VPS)
    // deployment. The `provider: "local"` assertion below is deliberate and
    // must NOT be weakened: playwright.config.ts PINS `GLM_PROVIDER=local` for
    // the harness (the suite must never be able to spend money on the metered
    // Z.ai leg), so a `remote` here means the pin leaked and the run is on the
    // billed leg. The cost of that assertion is that this spec CANNOT pass on a
    // deployment serving the remote leg — it FAILS on the probe rather than
    // skipping, and the failure is CORRECT, not a bug.
    //
    // To exercise the remote leg you would need a SEPARATE spec (not this one)
    // with: (a) `GLM_PROVIDER=remote` + a real `ZAI_API_KEY` in the webServer
    // env, (b) `--expect-provider remote` on the smoke run, (c) a fixture PDF
    // rather than the single scanned page (the remote leg rejects the per-page
    // `{image}` shape outright — contract §4.5 — and takes the whole-document
    // `{file,kind}` shape), and (d) acceptance that each run bills the Z.ai
    // account. The local leg below is the CI/local coverage; the remote leg's
    // deployment check is `scripts/vps-smoke.mjs` (ops gate O4), which is where
    // `available`/`provider` are asserted against the real host.
    const probe = await page.request.get("/api/extract/ocr");
    expect(probe.status(), "GET /api/extract/ocr should be 200 for a lecturer").toBe(200);
    const probeBody = await probe.json();
    expect(probeBody, "probe must carry the GlmEngineInfo shape").toMatchObject({
      available: true,
      provider: "local",
    });
    expect(typeof probeBody.maxPages).toBe("number");

    await page.getByLabel("Class title").fill("GLM Physics");

    await page.getByRole("button", { name: /create/i }).click();
    await expect(page.getByText("GLM Physics", { exact: true })).toBeVisible();

    await page.getByText("GLM Physics", { exact: true }).click();
    await expect(page).toHaveURL(/\/lecturer\/classes\/[^/]+$/);

    await page.getByLabel("Quiz title").fill("Chapter 1: Motion");
    await page.getByRole("button", { name: /create quiz|new quiz/i }).click();
    await page.getByText("Chapter 1: Motion", { exact: true }).click();
    await expect(page).toHaveURL(/\/lecturer\/quizzes\/[^/]+\/builder/);

    // ── 2. Open Generate-from-file, upload the scanned image ────
    await page.getByRole("button", { name: /generate from file/i }).click();
    await expect(
      page.getByRole("heading", { name: "Generate quiz from file" }),
    ).toBeVisible();

    // Scope to the dropzone: the page also renders hidden avatar and
    // question-image file inputs.
    await page
      .getByRole("button", { name: /upload course slides/i })
      .locator('input[type="file"]')
      .setInputFiles("e2e/fixtures/scanned-chapter.png");

    // ── 3. Select GLM-OCR (present because the app's own probe said available) ──
    // The app-probe assertion above is the real gate; open the dropdown, then
    // pick the AI Vision option.
    await page.getByRole("combobox", { name: /document scanner/i }).click();
    const glmOption = page.getByRole("option", { name: /AI Vision Scanner/i });
    await expect(glmOption).toBeVisible({ timeout: 10_000 });
    await glmOption.click();

    // ── 4. Extract → the server-side proxy transcribes the page ──
    await page.getByRole("button", { name: /Read Files & Continue/i }).click();
    await expect(
      page.getByText(/ready/i),
    ).toBeVisible({ timeout: 120_000 });

    // ── 5. Generate (mock AI) → in-dialog stream → questions persisted ──
    // The dialog's step 2 morphs into the generating view; the strip morphs
    // into the payoff + Review CTA, which closes back into the builder.
    await page.getByRole("button", { name: /generate quiz/i }).click();
    const genDialog = page.getByRole("dialog");
    await expect(
      genDialog.getByText(/questions forged|soalan dihasilkan/i),
    ).toBeVisible({ timeout: 30_000 });
    await genDialog.getByTestId("generation-review-btn").click();
    await expect(genDialog).toHaveCount(0);
    await expect(
      page.getByText("What is velocity?", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    await ctx.close();
  });
});
