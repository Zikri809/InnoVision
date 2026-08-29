import { test, expect } from "@playwright/test";
import { registerUser } from "./helpers";

/**
 * E41 — theme toggle (AX-1).
 * Serial tests:
 *   1. Cycle + persistence: the shell toggle cycles system → dark → light
 *      (system is the hydration-stable default), the `.dark` class lands on
 *      <html> exactly when expected, and the choice persists across reload
 *      (localStorage `innovision.theme`).
 *   2. FOUC guard: seeding localStorage with "dark" via an init script means
 *      the inline pre-hydration script (layout <head>) has already applied
 *      `.dark` by DOMContentLoaded — the closest loadable proxy for
 *      "before first paint".
 *   3. ms locale: labels render Bahasa ("Cerah"/"Gelap"/"Sistem") and the
 *      aria-label announces the current mode.
 */

const stamp = Date.now();
const LECTURER_EMAIL = `e41-lec-${stamp}@e2e.test`;
const INVITE = process.env.LECTURER_INVITE_CODE ?? "";

test.describe.configure({ mode: "serial" });

test("toggle cycles system → light → dark and persists across reload", async ({
  page,
}) => {
  await registerUser(page, LECTURER_EMAIL, "lecturer", INVITE);
  const toggle = page.getByTestId("theme-toggle");

  // Hydration-stable default: system. With the Playwright default light
  // emulation, system resolves to light.
  await expect(toggle).toHaveAttribute("data-theme-preference", "system");
  await expect(toggle).toHaveAttribute("data-theme-resolved", "light");
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  // system → light (cycle wraps: light → dark → system → light).
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-theme-preference", "light");
  await expect(toggle).toHaveAttribute("data-theme-resolved", "light");
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  // light → dark: class applied immediately.
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-theme-preference", "dark");
  await expect(toggle).toHaveAttribute("data-theme-resolved", "dark");
  await expect(page.locator("html")).toHaveClass(/dark/);

  // Persistence: reload keeps dark (localStorage), and the pre-hydration
  // script re-applies the class before hydration.
  await page.reload();
  const toggle2 = page.getByTestId("theme-toggle");
  await expect(toggle2).toHaveAttribute("data-theme-preference", "dark");
  await expect(page.locator("html")).toHaveClass(/dark/);

  // dark → system: class removed (Playwright light emulation resolves
  // system → light), and we land back on the default.
  await toggle2.click();
  await expect(toggle2).toHaveAttribute("data-theme-preference", "system");
  await expect(toggle2).toHaveAttribute("data-theme-resolved", "light");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

test("no flash-of-light: stored dark applies before hydration", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("innovision.theme", "dark");
  });
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("labels render Bahasa and aria-label announces the current mode", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("innovision.theme", "dark");
  });
  await registerUser(page, `e41-lec-ms-${stamp}@e2e.test`, "lecturer", INVITE);
  // Default locale en: dark label.
  const toggle = page.getByTestId("theme-toggle");
  await expect(toggle).toHaveAttribute("aria-label", /Colour theme: Dark/);

  // This account starts from seeded dark; cycle dark → system → light →
  // dark (full wrap) to prove the cycle is stable, then switch locale to BM
  // and assert Bahasa labels.
  await toggle.click(); // dark → system
  await toggle.click(); // system → light
  await toggle.click(); // light → dark
  await expect(toggle).toHaveAttribute("data-theme-preference", "dark");

  await page.getByRole("button", { name: "Switch language", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-label", /Tema warna: Gelap/);
});
