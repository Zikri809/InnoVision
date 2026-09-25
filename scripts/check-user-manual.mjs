// Smoke-check the generated static manual over a local HTTP server.
import { chromium } from "@playwright/test";
import path from "node:path";

const baseURL = process.env.MANUAL_SITE_URL ?? "http://127.0.0.1:8765";
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, width, height] of [["desktop", 1440, 900], ["phone", 375, 812], ["small-phone", 320, 700]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseURL}/index.html`, { waitUntil: "networkidle" });
    if (!await page.getByRole("heading", { name: "Easy2U user manual" }).isVisible()) throw new Error(`${name}: home heading missing`);
    if (width <= 375) {
      await page.locator(".mobile-menu summary").click();
      await page.locator(".mobile-menu a[href='student.html']").click();
    } else {
      await page.locator(".section-nav a[href='student.html']").click();
    }
    await page.waitForLoadState("networkidle");
    if (!await page.getByRole("heading", { name: "Student guide" }).isVisible()) throw new Error(`${name}: student guide missing`);
    if (await page.locator(".section-nav .nav-group-label").count() !== 3) throw new Error(`${name}: contents groups missing`);
    const caption = await page.locator("article .manual-shot figcaption").first().innerText();
    if (!caption.startsWith("Figure 1.")) throw new Error(`${name}: numbered image caption missing`);
    const textAlign = await page.locator("article > p").first().evaluate((element) => getComputedStyle(element).textAlign);
    if (textAlign !== (width <= 375 ? "start" : "justify")) throw new Error(`${name}: unexpected text alignment ${textAlign}`);
    const broken = await page.locator("article img").evaluateAll(async (images) => {
      for (const image of images) image.loading = "eager";
      return (await Promise.all(images.map(async (image) => {
        try { await image.decode(); return null; } catch { return image.src; }
      }))).filter(Boolean);
    });
    if (broken.length) throw new Error(`${name}: broken images: ${broken.join(", ")}`);
    const centeredPhoneFigure = await page.locator('.manual-shot[data-device="phone"]').first().evaluate((figure) => {
      const parent = figure.getBoundingClientRect();
      const image = figure.querySelector("img")?.getBoundingClientRect();
      const caption = figure.querySelector("figcaption")?.getBoundingClientRect();
      if (!image || !caption) return false;
      const center = parent.left + parent.width / 2;
      return Math.abs(center - (image.left + image.width / 2)) <= 2
        && Math.abs(center - (caption.left + caption.width / 2)) <= 2;
    });
    if (!centeredPhoneFigure) throw new Error(`${name}: phone figure or caption is not centered`);
    if (name !== "small-phone") await page.screenshot({ path: path.resolve(`tmp/manual-site-${name}.png`), animations: "disabled" });
    if (width <= 375) {
      const pageToc = page.locator(".page-toc");
      if (!await pageToc.isVisible()) throw new Error(`${name}: page contents missing`);
      await pageToc.locator("summary").click();
      await pageToc.locator('a[href="#join-a-class"]').click();
      if (!page.url().endsWith("#join-a-class") || await pageToc.evaluate((element) => element.open)) {
        throw new Error(`${name}: page contents navigation failed`);
      }
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) throw new Error(`${name}: horizontal overflow`);
    const search = width <= 375 ? page.locator("#manual-search-mobile") : page.locator("#manual-search");
    await search.fill("join a class");
    await page.locator(width <= 375 ? "#mobile-search-results a" : "#search-results a").first().waitFor();
    if (errors.length) throw new Error(`${name}: ${errors.join("; ")}`);
    console.log(`${name}: navigation, images, search, and width passed`);
    await page.close();
  }
} finally {
  await browser.close();
}
