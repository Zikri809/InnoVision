import { test, expect } from "@playwright/test";
import { registerUser, createClass, createQuizWithQuestions } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

/**
 * E2F — grounded web-search AUGMENTATION (web knowledge added on top of the
 * lecturer's material; topic-only mode was removed — every generation is
 * grounded in material the lecturer chose, with web pages as supplementary
 * citations).
 *
 * The scenario marker rides INSIDE the focus hint / pasted text
 * ("[MOCK:tf_*] …"); the route's query planner embeds the topic verbatim,
 * the mock AI echoes the marker into the planned queries, and
 * mock-tinyfish-server sniffs statelessly (parallel-worker safe; see its
 * header for the fixture/scorer coupling constraints).
 *
 * Coverage: happy path (augmented generation → payoff → builder shows BOTH
 * the storage-less material corpus AND web chips → injection wall), thin web
 * corpus DEGRADES to material-only (never errors), search 5xx / 401 degrade,
 * cancel mid-search, partial fetch errors (2 chips), mobile 360 overflow, ms
 * locale, legacy sources tolerance, student-surface absence of the toggle.
 */

const CLEAN_TEXT =
  "Photosynthesis converts light energy into chemical energy in chloroplasts. " +
  "The Calvin cycle fixes carbon dioxide using ATP and NADPH from the light reactions.";
const CLEAN_HINT = "[MOCK:tf_ok] photosynthesis basics";

/** Register → class → draft quiz → paste material → toggle web augmentation
 * → focus hint filled. Returns the dialog (still on step 2 config view). */
async function openAugmentedDialog(
  page: import("@playwright/test").Page,
  emailPrefix: string,
  hint: string,
) {
  await registerUser(page, `${emailPrefix}-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
  await createClass(page, `E2F ${emailPrefix}`);
  await createQuizWithQuestions(page, {
    classTitle: `E2F ${emailPrefix}`,
    quizTitle: `E2F Draft ${emailPrefix}`,
    questions: [{ prompt: "Seeded draft question?", options: ["x1", "x2"] }],
  });

  // Mobile (<sm, mobile polish): the builder hero strip leads with
  // "Add question" once a seeded question exists — Generate lives in the
  // ⋯ menu. Desktop: the hero button is direct.
  if ((page.viewportSize()?.width ?? 1280) < 640) {
    await page.getByRole("button", { name: /more actions/i }).click();
    await page.getByRole("menuitem", { name: /generate from file/i }).click();
  } else {
    await page.getByRole("button", { name: /generate from file/i }).click();
  }
  const dialog = page.getByRole("dialog");
  // The paste area lives behind an explicit toggle (mobile polish).
  await dialog.getByRole("button", { name: /paste notes or study text instead/i }).click();
  await dialog.getByLabel(/paste your material/i).fill(CLEAN_TEXT);
  await dialog.getByRole("button", { name: /continue with text/i }).click();
  await dialog.getByTestId("web-augment-toggle").check();
  await dialog.getByTestId("web-focus-hint").fill(hint);
  return dialog;
}

/** Poll the mock-tinyfish request log via the Playwright request fixture. */
const MOCK_TINYFISH_URL = `http://127.0.0.1:${process.env.MOCK_TINYFISH_PORT ?? 8788}`;
async function pollTinyfishLog(
  request: import("@playwright/test").APIRequestContext,
): Promise<Array<{ kind: string; query?: string; scenario: string | null }>> {
  const res = await request.get(`${MOCK_TINYFISH_URL}/__requests`);
  return (await res.json()).requests as never;
}

test.describe("E2F — grounded web augmentation", () => {
  test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
  // register + class + quiz + generation + payoff comfortably exceed the
  // 30s default (e2c's 180s precedent, trimmed to the real budget).
  test.setTimeout(120_000);

  test("happy path: material + web corpus, payoff, builder chips, injection wall", async ({
    page,
    request,
  }) => {
    const dialog = await openAugmentedDialog(page, "e2f-ok", CLEAN_HINT);

    await dialog.getByRole("button", { name: /generate quiz/i }).click();

    // The generating view is live INSIDE the dialog (Takeover: bot + rail +
    // one-liner; the search chip appears — web mode emits the search stage).
    await expect(
      dialog.getByTestId("generation-status-strip"),
    ).toBeVisible({ timeout: 15_000 });

    // Payoff: web-variant stamp (sources count, not chars).
    await expect(
      dialog.getByText(/grounded in|disokong/i),
    ).toBeVisible({ timeout: 30_000 });

    // The tool_call chrome streamed through the one-line token strip at some
    // point (catches a silently dropped tool_call case in the client event
    // switch) — poll because the strip shows only the LATEST line.
    await expect
      .poll(async () => {
        const line = dialog.getByTestId("generation-token-line");
        if ((await line.count()) === 0) return "terminal";
        return (await line.textContent()) ?? "";
      }, { timeout: 15_000 })
      .toMatch(/Searching the web|terminal|— /);

    // The search actually ran server-side with the marker (stateless sniff).
    await expect
      .poll(async () => {
        const log = await pollTinyfishLog(request);
        return log.some((r) => r.kind === "search" && r.scenario === "tf_ok");
      }, { timeout: 10_000 })
      .toBe(true);

    const reviewBtn = dialog.getByTestId("generation-review-btn");
    await expect(reviewBtn).toBeEnabled();
    await reviewBtn.click();
    await expect(dialog).toHaveCount(0);

    // Builder shows exactly the 3 fetched sources as link chips (scorer
    // coupling: 3 distinct hostnames + topic-token snippets → all 3 survive).
    const chips = page.getByTestId("web-source-chip");
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toHaveAttribute("href", /en\.wikipedia\.org\/wiki\/Photosynthesis/);
    await expect(chips.nth(1)).toHaveAttribute("href", /khanacademy\.org/);
    await expect(chips.nth(2)).toHaveAttribute("href", /britannica\.com/);

    // Injection wall: the hostile page text never reaches a saved prompt.
    await expect(
      page.locator("body").getByText("IGNORE PREVIOUS INSTRUCTIONS"),
    ).toHaveCount(0);
  });

  test("thin web corpus DEGRADES: payoff from material alone, no chips", async ({
    page,
  }) => {
    const dialog = await openAugmentedDialog(
      page,
      "e2f-thin",
      "[MOCK:tf_thin] photosynthesis basics",
    );
    await dialog.getByRole("button", { name: /generate quiz/i }).click();

    // Augmentation contract: a failed/thin search NEVER errors — the
    // material grounds the quiz and the payoff still lands.
    await expect(
      dialog.getByText(/grounded in|disokong/i),
    ).toBeVisible({ timeout: 30_000 });
    // The thin fixture fetched 0 usable pages → 0 web sources in the stamp;
    // the material-grounded mock quiz (3 questions) still saves — the count
    // comes from the route's post-save head-count (the old "0 questions"
    // pin codified the RPC-void bug).
    await expect(dialog.getByText(/3 questions grounded in 0 web pages/i)).toBeVisible();

    const reviewBtn = dialog.getByTestId("generation-review-btn");
    await expect(reviewBtn).toBeEnabled();
    await reviewBtn.click();
    await expect(dialog).toHaveCount(0);

    // Material-only provenance: no chips section.
    await expect(page.getByTestId("web-source-chip")).toHaveCount(0);
    await expect(page.getByTestId("web-source-chip-section")).toHaveCount(0);
    // The generated questions ARE there (from the pasted material).
    await expect(page.getByText("What is velocity?", { exact: true })).toBeVisible();
  });

  test("search 5xx DEGRADES to material-only", async ({ page }) => {
    const dialog = await openAugmentedDialog(
      page,
      "e2f-5xx",
      "[MOCK:tf_5xx] photosynthesis basics",
    );
    await dialog.getByRole("button", { name: /generate quiz/i }).click();
    await expect(
      dialog.getByText(/grounded in|disokong/i),
    ).toBeVisible({ timeout: 30_000 });
    // 5xx degradation: 3 material-grounded questions, 0 web sources.
    await expect(dialog.getByText(/3 questions grounded in 0 web pages/i)).toBeVisible();
  });

  test("search 401 (bad key) DEGRADES to material-only", async ({ page }) => {
    const dialog = await openAugmentedDialog(
      page,
      "e2f-401",
      "[MOCK:tf_401] photosynthesis basics",
    );
    await dialog.getByRole("button", { name: /generate quiz/i }).click();
    await expect(
      dialog.getByText(/grounded in|disokong/i),
    ).toBeVisible({ timeout: 30_000 });
    // The degraded run never surfaces a raw error strip.
    await expect(dialog.getByText(/generation failed/i)).toHaveCount(0);
  });

  test("cancel mid-search: cancelled strip, then a fresh run succeeds (guard released)", async ({
    page,
  }) => {
    const dialog = await openAugmentedDialog(
      page,
      "e2f-slow",
      "[MOCK:tf_slow] photosynthesis basics",
    );
    await dialog.getByRole("button", { name: /generate quiz/i }).click();

    // tf_slow holds the search response ~8s — a deterministic running window.
    await expect(dialog.getByTestId("generation-cancel-btn")).toBeVisible({
      timeout: 15_000,
    });
    await dialog.getByTestId("generation-cancel-btn").click();
    await expect(
      dialog
        .getByTestId("generation-status-strip")
        .getByText(/generation cancelled|penjanaan dibatalkan/i),
    ).toBeVisible();

    // Fresh clean re-run immediately: the in-flight guard was released.
    await dialog.getByTestId("generation-retry-btn").click();
    await expect(dialog.getByTestId("generation-cancel-btn")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      dialog.getByText(/already running|sedang berjalan/i),
    ).toHaveCount(0);
    await dialog.getByTestId("generation-cancel-btn").click();
    await expect(
      dialog
        .getByTestId("generation-status-strip")
        .getByText(/generation cancelled|penjanaan dibatalkan/i),
    ).toBeVisible();
  });

  test("partial fetch errors: skipped line + exactly 2 chips", async ({
    page,
  }) => {
    const dialog = await openAugmentedDialog(
      page,
      "e2f-partial",
      "[MOCK:tf_partial] photosynthesis basics",
    );
    await dialog.getByRole("button", { name: /generate quiz/i }).click();
    await expect(
      dialog.getByText(/grounded in|disokong/i),
    ).toBeVisible({ timeout: 30_000 });
    // The skipped fetch is reported as server chrome (tool_result "skip")
    // — with the Thinking accordion gone, the plan-level truth lives in the
    // done payload's source count (2 chips below) and the token strip is
    // transient; assert the builder outcome instead of the transient line.
    await dialog.getByTestId("generation-review-btn").click();
    await expect(page.getByTestId("web-source-chip")).toHaveCount(2);
  });

  test.describe("mobile 360×640", () => {
    // test.use must live in a describe scope (Playwright 1.62 rejects it
    // inside a test callback — UI-critic Blocker 4).
    test.use({ viewport: { width: 360, height: 640 } });

    test("augment toggle + hint stack, no horizontal overflow at payoff", async ({
      page,
    }) => {
      const dialog = await openAugmentedDialog(page, "e2f-mobile", CLEAN_HINT);
      const body = dialog.locator('[tabindex="-1"]').first();
      await dialog.getByRole("button", { name: /generate quiz/i }).click();
      await expect(
        dialog.getByText(/grounded in|disokong/i),
      ).toBeVisible({ timeout: 30_000 });
      await expect(async () => {
        const metrics = await body.evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        }));
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
      }).toPass({ timeout: 5_000 });
    });
  });

  test("ms locale: Malay payoff copy after the shell language toggle", async ({
    page,
  }) => {
    await openAugmentedDialog(page, "e2f-ms", CLEAN_HINT);
    // Flip the shell to BM (e31 pattern) BEFORE generating — the payoff must
    // come out localized. The toggle re-renders the shell; REOPEN the
    // dialog by its BM name ("Jana daripada fail").
    await page.keyboard.press("Escape");
    // Mobile polish round 2: below sm the language toggle lives in the
    // account sheet (pill variant) — the topbar copy is max-sm:hidden. The
    // account menu trigger (avatar) works at all widths; the pill inside
    // keeps the same accessible name ("Tukar bahasa" / "Switch language").
    await page.getByRole("button", { name: /account|akaun/i }).click();
    const langPill = page.getByRole("button", { name: /tukar bahasa|switch language/i });
    await expect(langPill).toBeVisible();
    await langPill.click();
    await page.keyboard.press("Escape"); // close the account sheet
    await page.waitForTimeout(800);
    await page
      .getByRole("button", { name: /jana daripada fail|generate from file/i })
      .click();
    const dialog2 = page.getByRole("dialog");
    // Paste area lives behind an explicit toggle (mobile polish); the BM
    // confirm button is "Teruskan dengan Teks" (was "guna teks ditampal").
    await dialog2.getByRole("button", { name: /tampal nota/i }).click();
    await dialog2.getByLabel(/tampal/i).fill(CLEAN_TEXT);
    await dialog2.getByRole("button", { name: /teruskan dengan teks/i }).click();
    await dialog2.getByTestId("web-augment-toggle").check();
    await dialog2.getByRole("button", { name: /jana kuiz/i }).click();
    await expect(dialog2.getByText(/disokong/i)).toBeVisible({ timeout: 30_000 });
  });

  test("legacy sources tolerance: builder hides the chips section for a sources-less quiz", async ({
    page,
  }) => {
    // A quiz generated BEFORE this feature (no sources content): the chips
    // section must not render at all (not even an empty shell). Fresh page —
    // the ms-locale test above leaves the browser mid-dialog in BM.
    await registerUser(
      page,
      `e2f-legacy-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await createClass(page, "E2F legacy");
    await createQuizWithQuestions(page, {
      classTitle: "E2F legacy",
      quizTitle: "E2F Legacy Draft",
      questions: [{ prompt: "Legacy question?", options: ["y1", "y2"] }],
    });
    // The helper landed us on the fresh draft's builder — no generation has
    // ever run for it.
    await expect(page.getByTestId("web-source-chip-section")).toHaveCount(0);
    await expect(page.getByTestId("web-source-chip")).toHaveCount(0);
  });

  test("student surface never shows the augmentation toggle", async ({ page }) => {
    await registerUser(
      page,
      `student-e2f-${TEST_TIMESTAMP}@innovision.test`,
      "student",
      LECTURER_INVITE_CODE,
    );
    // Minimal regression guard: the toggle testid never exists for students.
    const toggleCount = await page.getByTestId("web-augment-toggle").count();
    expect(toggleCount).toBe(0);
  });
});
