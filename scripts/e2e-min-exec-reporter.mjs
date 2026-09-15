/**
 * Playwright reporter — fail-on-fully-skipped runs (audit-1 §5 top-5 item 3).
 *
 * ~50 e2e specs `test.skip()` without `LECTURER_INVITE_CODE` (and e51 skips
 * without its dedicated opt-in). That means a broken invite env, a wrong
 * testIgnore pattern, or a harness env regression can produce a fully
 * GREEN run that executed ZERO tests — "green" that proves nothing. This
 * reporter walks the final suite and fails the run when every collected
 * test was skipped (or none was collected at all).
 *
 * Opt-out for intentional no-op invocations: E2E_ALLOW_ALL_SKIPPED=1.
 *
 * Wired in playwright.config.ts `reporter`; see TESTING §5.3.
 */

/** @type {import('@playwright/test').Reporter} */
export default class MinExecReporter {
  /**
   * Playwright calls `onBegin(config, suite)` — the suite is the SECOND
   * argument. Reading it from the first left `this.suite` undefined (the
   * config object has no `allTests`), so `onEnd` threw a TypeError and every
   * run ended with a spurious reporter failure on top of the real result.
   *
   * @param {import('@playwright/test').FullConfig} _config
   * @param {import('@playwright/test').Suite} suite
   */
  onBegin(_config, suite) {
    this.suite = suite;
  }

  async onEnd() {
    if (process.env.E2E_ALLOW_ALL_SKIPPED === "1") return;
    const suite = this.suite;
    if (!suite) return;

    const all = suite.allTests();
    if (all.length === 0) return; // testIgnore/testMatch excluded everything — not a skip regression.

    const executed = all.filter((test) => {
      const res = test.results && test.results[0];
      return res && res.status !== "skipped";
    }).length;

    if (executed === 0) {
      const sample = all.slice(0, 3).map((t) => t.title).join(" | ");
      throw new Error(
        `[min-exec] Every one of the ${all.length} collected tests was SKIPPED — ` +
          `this run proves nothing (e.g. LECTURER_INVITE_CODE unset or a harness env regression). ` +
          `Sample skips: ${sample}. Set E2E_ALLOW_ALL_SKIPPED=1 to allow an intentionally empty run.`,
      );
    }
    if (executed < all.length) {
      console.log(
        `[min-exec] ${executed}/${all.length} tests executed (${all.length - executed} skipped).`,
      );
    }
  }
}
