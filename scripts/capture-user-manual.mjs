// Reproducible captures for the Easy2U manual, using only local seeded accounts.
// Run a production build on localhost:3100 and `node scripts/seed-demo.mjs` first.
import { chromium } from "@playwright/test";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const baseURL = process.env.MANUAL_CAPTURE_URL ?? "http://localhost:3100";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(baseURL)) {
  throw new Error("Manual captures are limited to a local app origin.");
}
const out = path.resolve("docs/user-manual/screenshots/originals");
const figures = path.resolve("docs/user-manual/screenshots/figures");
await mkdir(out, { recursive: true });
await mkdir(figures, { recursive: true });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const browser = await chromium.launch({ headless: true });
const records = [];

async function login(page, role) {
  await page.goto(`${baseURL}/login`);
  await page.locator('input[type="email"]').fill(`${role}@innovision.test`);
  await page.locator('input[type="password"]').fill("Password123!");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => url.pathname.startsWith(role === "lecturer" ? "/lecturer" : "/student"));
}

async function ready(page) {
  await page.waitForLoadState("networkidle", { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function capture(page, name, role, scenario) {
  await ready(page);
  // Keep synthetic but usable class and share codes out of published images.
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      node.textContent = node.textContent?.replace(/\b(?:DEMK42|DBSYS5|ARCH99)\b/g, "ABC234") ?? "";
    }
  });
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(out, file), animations: "disabled" });
  await copyFile(path.join(out, file), path.join(figures, file));
  records.push({
    file,
    commit,
    capturedAt: new Date().toISOString(),
    browser: "Chromium/Playwright",
    viewport: `${page.viewportSize().width}x${page.viewportSize().height}`,
    locale: "en",
    theme: "light/system",
    role,
    scenario,
    route: new URL(page.url()).pathname,
  });
  console.log(`${file}: ${scenario}`);
}

async function newPage(viewport, mobile = false) {
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: "en-MY", colorScheme: "light", deviceScaleFactor: 1 });
  return { context, page: await context.newPage() };
}

try {
  const desktop = await newPage({ width: 1440, height: 900 });
  await desktop.page.goto(`${baseURL}/login`);
  await capture(desktop.page, "a01-sign-in-desktop", "signed-out", "Sign-in form");
  await login(desktop.page, "student1");
  await capture(desktop.page, "s01-classes-desktop", "student", "Student classes and desktop navigation");
  await desktop.page.getByRole("button", { name: "Join a class" }).click();
  await capture(desktop.page, "s07-join-dialog-desktop", "student", "Enter a class join code");
  await desktop.page.getByRole("dialog").screenshot({
    path: path.join(figures, "s07-join-dialog-desktop.png"),
    animations: "disabled",
  });
  await desktop.page.keyboard.press("Escape");
  await desktop.page.goto(`${baseURL}/student/quizzes`);
  await capture(desktop.page, "s02-class-quizzes-desktop", "student", "Class quiz list and availability");
  await desktop.page.getByRole("button", { name: "Start", exact: true }).click();
  await desktop.page.waitForURL(/\/play\//);
  await desktop.page.getByRole("button", { name: "Skip this question" }).waitFor({ timeout: 30000 });
  await capture(desktop.page, "s08-practice-player-desktop", "student", "Class practice quiz player");
  const playerPath = new URL(desktop.page.url()).pathname;
  await desktop.page.goto(`${baseURL}/student/my-quizzes`);
  await capture(desktop.page, "s03-my-quizzes-desktop", "student", "Personal practice quiz library");
  await desktop.page.goto(`${baseURL}/student/face/enroll`);
  await capture(desktop.page, "s04-face-consent-desktop", "student", "Face enrollment consent before camera use");
  await desktop.context.close();

  const phone = await newPage({ width: 375, height: 812 }, true);
  await login(phone.page, "student1");
  await capture(phone.page, "s05-classes-phone", "student", "Student classes and phone bottom navigation");
  await phone.page.getByRole("button", { name: "Join a class" }).click();
  await capture(phone.page, "s09-join-drawer-phone", "student", "Phone join-code drawer");
  await phone.page.keyboard.press("Escape");
  await phone.page.goto(`${baseURL}/student/quizzes`);
  await capture(phone.page, "s06-class-quizzes-phone", "student", "Phone class quiz list");
  await phone.page.goto(`${baseURL}${playerPath}`);
  await phone.page.getByRole("button", { name: "Skip this question" }).waitFor({ timeout: 30000 });
  await capture(phone.page, "s10-practice-player-phone", "student", "Phone class practice quiz player");
  await phone.context.close();

  const lecturer = await newPage({ width: 1440, height: 900 });
  await login(lecturer.page, "lecturer");
  await capture(lecturer.page, "l01-classes-desktop", "lecturer", "Lecturer class dashboard");
  const classPath = await lecturer.page.locator('a[href^="/lecturer/classes/"]').filter({ hasText: "CS101" }).first().getAttribute("href");
  await lecturer.page.goto(`${baseURL}${classPath}`);
  await capture(lecturer.page, "l02-class-detail-desktop", "lecturer", "Class detail, quiz list and roster tabs");
  const builderPath = await lecturer.page.locator('a[href$="/builder"]').filter({ hasText: "Draft" }).first().getAttribute("href");
  const resultsPath = await lecturer.page.locator('a[href$="/results"]').first().getAttribute("href");
  await lecturer.page.goto(`${baseURL}${builderPath}`);
  await capture(lecturer.page, "l03-builder-desktop", "lecturer", "Quiz builder for a draft quiz");
  await lecturer.page.goto(`${baseURL}${resultsPath}`);
  await capture(lecturer.page, "l04-results-desktop", "lecturer", "Quiz results and review controls");
  await lecturer.page.goto(`${baseURL}${classPath}/gradebook`);
  await capture(lecturer.page, "l05-gradebook-desktop", "lecturer", "Desktop class gradebook");
  await lecturer.context.close();

  const lecturerPhone = await newPage({ width: 375, height: 812 }, true);
  await login(lecturerPhone.page, "lecturer");
  await capture(lecturerPhone.page, "l06-classes-phone", "lecturer", "Lecturer classes and phone Create control");
  await lecturerPhone.page.goto(`${baseURL}${classPath}`);
  await capture(lecturerPhone.page, "l07-class-detail-phone", "lecturer", "Phone class detail and tab controls");
  await lecturerPhone.page.goto(`${baseURL}${builderPath}`);
  await capture(lecturerPhone.page, "l08-builder-phone", "lecturer", "Phone quiz builder controls");
  await lecturerPhone.page.getByRole("button", { name: "Add question" }).click();
  await capture(lecturerPhone.page, "l10-add-question-sheet-phone", "lecturer", "Phone question form sheet");
  await lecturerPhone.page.goto(`${baseURL}${classPath}/gradebook`);
  await capture(lecturerPhone.page, "l09-gradebook-phone", "lecturer", "Phone gradebook drill-down");
  await lecturerPhone.page.getByRole("button", { name: /Muhammad Danish/ }).click();
  await capture(lecturerPhone.page, "l11-student-grade-sheet-phone", "lecturer", "Phone per-student grade details");
  await lecturerPhone.context.close();
} finally {
  await browser.close();
}

const fields = ["file", "commit", "capturedAt", "browser", "viewport", "locale", "theme", "role", "scenario", "route"];
const csv = [fields.join(","), ...records.map((row) => fields.map((key) => `"${String(row[key]).replaceAll('"', '""')}"`).join(","))].join("\n") + "\n";
await writeFile(path.resolve("docs/user-manual/screenshots/manifest.csv"), csv);
