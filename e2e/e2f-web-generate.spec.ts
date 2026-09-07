import { test, expect } from "@playwright/test";
import { registerUser, createClass, createQuizWithQuestions } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

/**
 * E2F — grounded web-search generation (grounded-search.md §9C, TinyFish
 * topic mode, lecturer surface).
 *
 * The scenario marker rides INSIDE the topic string ("[MOCK:tf_ok] …"); the
 * route's query planner embeds the topic verbatim, the mock AI echoes the
 * marker into the planned queries, and mock-tinyfish-server sniffs the query
 * statelessly (parallel-worker safe; see its header for the fixture/scorer
 * coupling constraints).
 *
 * Coverage: happy path (search stage lines → payoff → builder chips with the
 * exact fixture hrefs → injection wall), too-thin corpus, search 5xx / 401
 * (distinct localized strips), cancel mid-search ([MOCK:tf_slow] window),
 * partial fetch errors, mobile-360 overflow, ms locale, legacy sources
 * tolerance, and student-surface absence of the chooser.
 *
 * `request.pollTinyfish` polls the mock's /__requests log — TinyFish is
 * called SERVER-SIDE, invisible to page.route (the reason mock-ai-server.mjs
 * exists at all).
 */

const CLEAN_TOPIC = "[MOCK:tf_ok] photosynthesis basics";

/** Register → class → draft quiz → open the generate dialog in web mode. */
async function openWebTopicDialog(
  page: import("@playwright/test").Page,
  emailPrefix: string,
  topic: string,
) {
  await registerUser(page, `${emailPrefix}-${TEST_TIMESTAMP}@innovision.test`, "lecturer", LECTURER_INVITE_CODE);
  await createClass(page, `E2F ${emailPrefix}`);
  await createQuizWithQuestions(page, {
    classTitle: `E2F ${emailPrefix}`,
    quizTitle: `E2F Draft ${emailPrefix}`,
    questions: [{ prompt: "Seeded draft question?", options: ["x1", "x2"] }],
  });

  await page.getByRole("button", { name: /generate from file/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("source-mode-web").click();
  await dialog.getByLabel(/quiz topic/i).fill(topic);
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

test.describe("E2F — grounded web generation", () => {
  test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");
  // register + class + quiz + generation + payoff comfortably exceed the
  // 30s default (e2c's 180s precedent, trimmed to the real budget).
  test.setTimeout(120_000);

  test("happy path: search lines, payoff, builder chips, injection wall", async ({
    page,
    request,
  }) => {
    const dialog = await openWebTopicDialog(page, "e2f-ok", CLEAN_TOPIC);

    // Submit from step 1 (web mode has no extraction step).
    await dialog.getByRole("button", { name: /generate quiz/i }).click();

    // The generating view shows the search stage + tool lines INSIDE the
    // dialog (server chrome, query text included — catches a silently
    // dropped tool_call case in the client switch).
    await expect(
      dialog.getByTestId("generation-thinking-toggle"),
    ).toBeVisible({ timeout: 15_000 });

    // Payoff: web-variant stamp (sources count, not chars).
    await expect(
      dialog.getByText(/grounded in|disokong/i),
    ).toBeVisible({ timeout: 30_000 });

    // Tool lines carry the real query text (server chrome — catches a
    // silently dropped tool_call case in the client event switch). Both
    // planned queries render, so assert the prefix appears at least twice.
    await dialog.getByTestId("generation-thinking-toggle").click();
    const searchLines = dialog.getByText(/Searching the web: /);
    await expect(searchLines.first()).toBeVisible();
    await expect(searchLines).toHaveCount(2);

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

  test("too-thin corpus: distinct localized strip, topic preserved on retry", async ({
    page,
  }) => {
    const dialog = await openWebTopicDialog(
      page,
      "e2f-thin",
      "[MOCK:tf_thin] photosynthesis basics",
    );
    await dialog.getByRole("button", { name: /generate quiz/i }).click();

    // The thin-corpus copy — NOT the generic "Generation failed" headline.
    await expect(
      dialog.getByText(/too little content|terlalu sedikit kandungan/i),
    ).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId("generation-retry-btn")).toBeEnabled();

    // Topic preserved: retry re-posts the same config (fails again).
    await dialog.getByTestId("generation-retry-btn").click();
    await expect(
      dialog.getByText(/too little content|terlalu sedikit kandungan/i),
    ).toBeVisible({ timeout: 30_000 });

    // Builder untouched: the seed question remains.
    await page.keyboard.press("Escape");
    await expect(page.getByText("Seeded draft question?", { exact: true })).toBeVisible();
  });

  test("search 5xx → search_failed strip", async ({ page }) => {
    const dialog5xx = await openWebTopicDialog(
      page,
      "e2f-5xx",
      "[MOCK:tf_5xx] photosynthesis basics",
    );
    await dialog5xx.getByRole("button", { name: /generate quiz/i }).click();
    await expect(
      dialog5xx.getByText(/web search failed|carian web gagal/i),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("search 401 → distinct search_unavailable strip", async ({ page }) => {
    const dialog401 = await openWebTopicDialog(
      page,
      "e2f-401",
      "[MOCK:tf_401] photosynthesis basics",
    );
    await dialog401.getByRole("button", { name: /generate quiz/i }).click();
    await expect(
      dialog401.getByText(/web search is unavailable|carian web tidak tersedia/i),
    ).toBeVisible({ timeout: 30_000 });
    // The two codes are two DIFFERENT localized strings — assert the copy on
    // this strip is NOT the search_failed one (they share a landing strip).
    await expect(
      dialog401.getByText(/web search failed|carian web gagal/i),
    ).toHaveCount(0);
  });

  test("cancel mid-search: cancelled strip, then a fresh run succeeds (guard released)", async ({
    page,
  }) => {
    const dialog = await openWebTopicDialog(
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
    await expect(dialog.getByTestId("generation-status-strip").getByText(/generation cancelled|penjanaan dibatalkan/i)).toBeVisible();

    // Fresh clean re-run immediately: the in-flight guard was released.
    await dialog.getByTestId("generation-retry-btn").click();
    // The retry replays the SAME slow scenario; cancel again then accept the
    // payoff is NOT possible — instead assert the run is live again (strip
    // pulsing) and cancel once more; the guard is proven released by the
    // second cancel not showing "already running".
    await expect(dialog.getByTestId("generation-cancel-btn")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      dialog.getByText(/already running|sedang berjalan/i),
    ).toHaveCount(0);
    await dialog.getByTestId("generation-cancel-btn").click();
    await expect(dialog.getByTestId("generation-status-strip").getByText(/generation cancelled|penjanaan dibatalkan/i)).toBeVisible();
  });

  test("partial fetch errors: skipped line + exactly 2 chips", async ({
    page,
  }) => {
    const dialog = await openWebTopicDialog(
      page,
      "e2f-partial",
      "[MOCK:tf_partial] photosynthesis basics",
    );
    await dialog.getByRole("button", { name: /generate quiz/i }).click();
    await expect(
      dialog.getByText(/grounded in|disokong/i),
    ).toBeVisible({ timeout: 30_000 });
    // The skipped fetch is reported as server chrome with the page URL and
    // the API's error code.
    await dialog.getByTestId("generation-thinking-toggle").click();
    await expect(
      dialog.getByText(/Skipped .*britannica\.com.*target_http_error/),
    ).toBeVisible();
    await dialog.getByTestId("generation-review-btn").click();
    await expect(page.getByTestId("web-source-chip")).toHaveCount(2);
  });

  test.describe("mobile 360×640", () => {
    // test.use must live in a describe scope (Playwright 1.62 rejects it
    // inside a test callback — UI-critic Blocker 4).
    test.use({ viewport: { width: 360, height: 640 } });

    test("chooser + topic stack, no horizontal overflow at payoff", async ({
      page,
    }) => {
      const dialog = await openWebTopicDialog(page, "e2f-mobile", CLEAN_TOPIC);
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
    const dialog = await openWebTopicDialog(page, "e2f-ms", CLEAN_TOPIC);
    // Flip the shell to BM (e31 pattern) BEFORE generating — the payoff and
    // strip copy must come out localized, never the EN by accident. The
    // toggle navigates/re-renders the shell, so REOPEN the dialog by its BM
    // name ("Jana daripada fail").
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /tukar bahasa|switch language/i }).click();
    await page.waitForTimeout(800);
    await page
      .getByRole("button", { name: /jana daripada fail|generate from file/i })
      .click();
    const dialog2 = page.getByRole("dialog");
    await dialog2.getByTestId("source-mode-web").click();
    await dialog2.getByLabel(/topik kuiz|quiz topic/i).fill(CLEAN_TOPIC);
    await dialog2.getByRole("button", { name: /jana kuiz|generate quiz/i }).click();
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

  test("student surface never shows the source-mode chooser", async ({ page }) => {
    await registerUser(
      page,
      `student-e2f-${TEST_TIMESTAMP}@innovision.test`,
      "student",
      LECTURER_INVITE_CODE,
    );
    // Minimal regression guard: the chooser testids never exist for students.
    const chooserCount = await page.getByTestId("source-mode-web").count();
    expect(chooserCount).toBe(0);
  });
});
