import { test, expect } from "@playwright/test";
import { registerUser, createClass, createQuizWithQuestions } from "./helpers";

const TEST_TIMESTAMP = Date.now();
const LECTURER_INVITE_CODE = process.env.LECTURER_INVITE_CODE ?? "";

/**
 * E2D — the in-dialog generation view (Phase 3 pattern adopted for the
 * lecturer surface; the /generating console page is RETIRED).
 *
 * The dialog's step 2 morphs into the generating view on submit: a status
 * strip (four TRUE stage dots) + a collapsed "Thinking" accordion, then the
 * strip morphs into the outcome card. Coverage (plan §C/§D, relocated):
 *  - HAPPY PATH: strip reaches the payoff + Review CTA inside the dialog;
 *    Review lands the questions in the builder (e2 covers the full journey);
 *  - THINKING ACCORDION: expands, streams inert trace text, stage lines;
 *  - MID-STREAM ERROR: error strip + Try again inside the dialog; retry
 *    re-runs in place (config preserved in component state);
 *  - CANCEL: mid-run cancel (footer X) marks cancelled; immediate retry is
 *    NOT locked out (server in-flight guard released);
 *  - ALREADY RUNNING: pre-stream JSON 429 maps to the distinct no-retry state;
 *  - DEAD STREAM: [MOCK:stall] silent upstream → idle abort → error strip.
 *
 * Scenario selection rides the stateless [MOCK:scenario] marker in the pasted
 * source text — the mock AI server sniffs it per-request (parallel-safe).
 */

const CLEAN_TEXT =
  "Velocity is displacement over time. Light travels faster than sound. " +
  "Force is measured in newtons. Energy is conserved in closed systems.";

/** Drive the dialog to step 2 with pasted text, then submit. */
async function pasteAndGenerate(
  page: import("@playwright/test").Page,
  text: string,
) {
  await page.getByRole("button", { name: /generate from file/i }).click();
  const dialog = page.getByRole("dialog");
  // The mobile polish moved the paste textarea behind an explicit toggle.
  await dialog.getByRole("button", { name: /paste notes or study text instead/i }).click();
  await dialog.getByLabel(/paste your material/i).fill(text);
  await dialog.getByRole("button", { name: /continue with text/i }).click();
  await dialog.getByRole("button", { name: /generate quiz/i }).click();
  return dialog;
}

test.describe("E2D — in-dialog generation", () => {
  test("happy path: strip morphs to payoff in-dialog, Review lands in builder", async ({
    page,
  }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    await registerUser(
      page,
      `lecturer-e2d-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await createClass(page, "E2D Dialog");
    await createQuizWithQuestions(page, {
      classTitle: "E2D Dialog",
      quizTitle: "E2D Draft",
      questions: [{ prompt: "Seeded draft question?", options: ["x1", "x2"] }],
    });

    await pasteAndGenerate(page, CLEAN_TEXT);

    // Still in the dialog (NO navigation to a console route).
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Payoff stamp renders inside the strip (localized), with the Review CTA.
    await expect(
      dialog.getByText(/questions forged|soalan dihasilkan/i),
    ).toBeVisible({ timeout: 30_000 });
    const reviewBtn = dialog.getByTestId("generation-review-btn");
    await expect(reviewBtn).toBeEnabled();

    // The Thinking accordion is GONE (replaced by the one-line token strip).
    await expect(dialog.getByTestId("generation-thinking-toggle")).toHaveCount(0);
    await expect(dialog.getByTestId("generation-thinking-trace")).toHaveCount(0);

    // Review closes the dialog; the builder already refreshed server-side.
    await reviewBtn.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("What is velocity?", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    // Replace mode: the seeded question is gone, the generated set is in.
    await expect(
      page.getByText("Seeded draft question?", { exact: true }),
    ).toHaveCount(0);
  });

  test("token line: stage lines surface in the grey one-liner (S7 inert)", async ({
    page,
  }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    await registerUser(
      page,
      `lecturer-e2d2-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await createClass(page, "E2D Trace");
    await createQuizWithQuestions(page, {
      classTitle: "E2D Trace",
      quizTitle: "E2D Trace Draft",
      questions: [{ prompt: "Trace question?", options: ["t1", "t2"] }],
    });

    // The one-line grey strip (replaces the Thinking accordion) streams the
    // latest trace line: the mock's reasoning tokens surface here. It renders
    // ONLY while `phase === "running"` (GenerationProgress.tsx) and is REMOVED
    // at the terminal morph — so it is transient by design and any direct
    // assertion races the stream (the mock can finish before the locator is
    // first queried; observed as "element(s) not found" while the terminal
    // payoff was already on screen).
    //
    // Record it instead: a MutationObserver installed BEFORE generation starts
    // captures every version of the node as it streams, so the contract is
    // asserted against the observed history rather than a lucky DOM snapshot.
    await page.evaluate(() => {
      const w = window as unknown as { __tokenLineSeen?: Array<Record<string, string>> };
      w.__tokenLineSeen = [];
      const record = (el: Element) => {
        w.__tokenLineSeen!.push({
          text: (el.textContent ?? "").trim(),
          ariaHidden: el.getAttribute("aria-hidden") ?? "",
          className: el.getAttribute("class") ?? "",
        });
      };
      const scan = (root: ParentNode) => {
        root.querySelectorAll?.('[data-testid="generation-token-line"]').forEach(record);
      };
      scan(document);
      new MutationObserver((muts) => {
        for (const m of muts) {
          m.addedNodes.forEach((n) => {
            if (n.nodeType === 1) {
              const el = n as Element;
              if (el.getAttribute("data-testid") === "generation-token-line") record(el);
              scan(el);
            }
          });
        }
      }).observe(document.body, { childList: true, subtree: true });
    });

    await pasteAndGenerate(page, CLEAN_TEXT);
    const dialog = page.getByRole("dialog");

    // Terminal: the sentence morphs to the payoff; the token line is gone —
    // endings are spoken by the sentence + live region, not the log.
    await expect(
      dialog.getByText(/questions forged|soalan dihasilkan/i),
    ).toBeVisible({ timeout: 30_000 });

    const seen = await page.evaluate(
      () => (window as unknown as { __tokenLineSeen?: Array<Record<string, string>> }).__tokenLineSeen ?? [],
    );
    expect(seen.length).toBeGreaterThan(0);
    // Inertness (S7) + ONE-line contract held for EVERY streamed version.
    for (const rec of seen) {
      expect(rec.ariaHidden).toBe("true");
      expect(rec.className).toContain("truncate");
    }
    // The streamed vocabulary is the stage chrome / model tokens.
    expect(seen.map((r) => r.text).join(" | ")).toMatch(/Analyzing|Parse|Draft|Refine|Save|Reading|—/);

    // Gone at the terminal state (the removal is part of the contract).
    await expect(dialog.getByTestId("generation-token-line")).toHaveCount(0);
  });

  test("mid-stream error: error strip + Try again recovers in place", async ({
    page,
  }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    await registerUser(
      page,
      `lecturer-e2d3-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await createClass(page, "E2D Error");
    await createQuizWithQuestions(page, {
      classTitle: "E2D Error",
      quizTitle: "E2D Error Draft",
      questions: [{ prompt: "Error question?", options: ["z1", "z2"] }],
    });

    // [MOCK:invalid] makes the upstream return invalid JSON TWICE (attempt +
    // retry) → the route emits an invalid_ai_output error event.
    await pasteAndGenerate(
      page,
      "[MOCK:invalid] Velocity is displacement over time. Force is measured in newtons. " +
        "Energy is conserved. Light travels faster than sound.",
    );
    const dialog = page.getByRole("dialog");

    // Error strip inside the dialog with the retry affordance (trace kept).
    await expect(
      dialog.getByText(/generation failed|penjanaan gagal/i).first(),
    ).toBeVisible({ timeout: 30_000 });
    const retryBtn = dialog.getByTestId("generation-retry-btn");
    await expect(retryBtn).toBeVisible();

    // Recovery attempt: the marker is still in the text so it fails again by
    // design; the point is the dialog stays functional and retains state.
    await retryBtn.click();
    await expect(
      dialog.getByText(/generation failed|penjanaan gagal/i).first(),
    ).toBeVisible({ timeout: 30_000 });

    // Zero rows landed server-side (atomicity): builder still shows the seed.
    await page.keyboard.press("Escape");
    await expect(page.getByText("Error question?", { exact: true })).toBeVisible();
    await expect(
      page.getByText("What is velocity?", { exact: true }),
    ).toHaveCount(0);
  });

  test("cancel mid-generation: marked cancelled, immediate retry not locked out", async ({
    page,
  }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    await registerUser(
      page,
      `lecturer-e2d4-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await createClass(page, "E2D Cancel");
    await createQuizWithQuestions(page, {
      classTitle: "E2D Cancel",
      quizTitle: "E2D Cancel Draft",
      questions: [{ prompt: "Cancel question?", options: ["c1", "c2"] }],
    });

    // [MOCK:stall] holds the stream open (one chunk, then silence; the route's
    // 3s idle abort is the only end) — the Cancel button is GUARANTEED present
    // and no catch-fallback is needed: if the button disappears this test
    // fails loudly instead of degrading into a payoff assertion.
    await pasteAndGenerate(
      page,
      "[MOCK:stall] Velocity is displacement over time. Light travels faster than sound.",
    );
    const dialog = page.getByRole("dialog");
    const cancelBtn = dialog.getByTestId("generation-cancel-btn");
    await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
    await cancelBtn.click();

    // Cancelled strip inside the still-open dialog (trace retained).
    await expect(
      dialog.getByText(/generation cancelled|penjanaan dibatalkan/i).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByTestId("generation-retry-btn")).toBeVisible();

    // Guard release is guaranteed within the harness's 3s upstream idle
    // abort (+ socket-teardown slack) — there is no client-observable
    // signal for the server-side latch, so wait out that bounded window.
    // NOTE: the in-dialog "Try again" replays the SAME body, whose
    // [MOCK:stall] marker would stall again by design — so lockout release
    // is proven with a FRESH clean-text run instead.
    await page.waitForTimeout(4_000);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: /generate from file/i }).click();
    const dialog2 = page.getByRole("dialog");
    await dialog2.getByRole("button", { name: /paste notes or study text instead/i }).click();
    await dialog2.getByLabel(/paste your material/i).fill(CLEAN_TEXT);
    await dialog2.getByRole("button", { name: /continue with text/i }).click();
    await dialog2.getByRole("button", { name: /generate quiz/i }).click();
    await expect(
      dialog2.getByText(/questions forged|soalan dihasilkan/i).first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("dead stream: silent upstream is reaped by the idle abort, dialog shows failure", async ({
    page,
  }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    await registerUser(
      page,
      `lecturer-e2d5-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await createClass(page, "E2D Stall");
    await createQuizWithQuestions(page, {
      classTitle: "E2D Stall",
      quizTitle: "E2D Stall Draft",
      questions: [{ prompt: "Stall question?", options: ["s1", "s2"] }],
    });

    // [MOCK:stall] sends one chunk then goes silent; the harness
    // AI_STREAM_IDLE_TIMEOUT_MS=3s makes chatStream abort, and the route
    // converts that into an error event (dead-stream path).
    await pasteAndGenerate(
      page,
      "[MOCK:stall] Velocity is displacement over time. Force is measured in newtons. " +
        "Energy is conserved. Light travels faster than sound.",
    );
    const dialog = page.getByRole("dialog");

    // Idle abort (3s) + event round-trip: failure state inside the test budget.
    await expect(
      dialog.getByText(/generation failed|penjanaan gagal/i).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByTestId("generation-retry-btn")).toBeVisible();

    // Zero rows landed (atomicity); the builder is intact behind the dialog.
    await page.keyboard.press("Escape");
    await expect(page.getByText("Stall question?", { exact: true })).toBeVisible();
    await expect(
      page.getByText("What is velocity?", { exact: true }),
    ).toHaveCount(0);
  });

  test("already running: pre-stream 429 renders the distinct state with no retry", async ({
    page,
  }) => {
    test.skip(!LECTURER_INVITE_CODE, "LECTURER_INVITE_CODE not set");

    await registerUser(
      page,
      `lecturer-e2d6-${TEST_TIMESTAMP}@innovision.test`,
      "lecturer",
      LECTURER_INVITE_CODE,
    );
    await createClass(page, "E2D Running");
    await createQuizWithQuestions(page, {
      classTitle: "E2D Running",
      quizTitle: "E2D Running Draft",
      questions: [{ prompt: "Running question?", options: ["r1", "r2"] }],
    });

    // Intercept the generate POST BEFORE the dialog fires it and answer with
    // the exact pre-stream JSON the in-flight guard emits — proving the strip
    // maps the CODE, not just the status.
    await page.route(/\/api\/ai\/generate-quiz$/, (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          error: "already_running",
          message: "A generation for this quiz is already in progress.",
        }),
      }),
    );

    await pasteAndGenerate(page, CLEAN_TEXT);
    const dialog = page.getByRole("dialog");

    // Distinct title (NOT the generic "Generation failed"), and NO retry CTA.
    await expect(
      dialog.getByText(/already running|sedang berjalan/i).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByTestId("generation-retry-btn")).toHaveCount(0);
  });
});
