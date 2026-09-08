// Fast probe: computed .text-xs font-size + card-grid gap at mobile/desktop.
import { chromium } from "@playwright/test";

const BASE = "http://localhost:3000";
const PASSWORD = "Password123!";
const results = {};

const browser = await chromium.launch();
for (const [vp, opts] of [
  ["mobile", { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }],
  ["desktop", { viewport: { width: 1440, height: 900 } }],
]) {
  results[vp] = {};
  for (const [role, account, pages] of [
    ["student", "norm-student@scenario.test", ["/student/classes", "/student/quizzes", "/student/my-quizzes"]],
    ["lecturer", "norm-lecturer@scenario.test", ["/lecturer/classes"]],
  ]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[type="email"]', { timeout: 20000 });
    await page.click('input[type="email"]');
    await page.keyboard.type(account, { delay: 5 });
    await page.click('input[type="password"]');
    await page.keyboard.type(PASSWORD, { delay: 5 });
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30000 });
    for (const route of pages) {
      await page.goto(BASE + route, { waitUntil: "networkidle" }).catch(() => {});
      await page.evaluate(() => document.fonts.ready).catch(() => {});
      const textXs = await page
        .locator(".text-xs")
        .first()
        .evaluate((el) => {
          const cs = getComputedStyle(el);
          return `${cs.fontSize}/${cs.lineHeight}`;
        })
        .catch(() => "NOT_FOUND");
      const gap = await page.evaluate(() => {
        const ul = document.querySelector("ul.grid");
        if (!ul) return "NO_GRID";
        const items = ul.querySelectorAll(":scope > li");
        if (items.length < 2) return "ONE_CARD";
        const a = items[0].getBoundingClientRect(), b = items[1].getBoundingClientRect();
        const gx = Math.round(b.left - a.right);
        return gx >= 0 ? `${gx}px` : `${Math.round(b.top - a.bottom)}px`;
      });
      results[vp][route] = { textXs, gap };
    }
    await ctx.close();
  }
}
console.log(JSON.stringify(results, null, 2));
await browser.close();
