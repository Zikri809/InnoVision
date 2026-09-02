// Scenario explorer — walks InnoVision under THREE seeded dataset sizes and
// captures screenshots + console/page errors per scenario, so UI misbehaviour
// (weird empty states, broken counts, overflow, dead layouts) surfaces:
//
//   first   : brand-new student + lecturer, zero data → empty states
//   normal  : student in 8 classes; lecturer with 5 classes × ~48 students
//   extreme : student in 9 classes (12 total); lecturer with 12 classes and
//             a multi-semester pile of closed/revealed history
//
// Output: screenshots/explore_scenarios/<scenario>/*.png + report.json
// Run:  node scripts/explore-scenarios.mjs [first|normal|extreme|all]
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ROOT = path.resolve(process.cwd(), "screenshots/explore_scenarios");
fs.mkdirSync(ROOT, { recursive: true });

const PASSWORD = "Password123!";
const SCENARIOS = {
  first: {
    student: "first-student@scenario.test",
    lecturer: "first-lecturer@scenario.test",
  },
  normal: {
    student: "norm-student@scenario.test",
    lecturer: "norm-lecturer@scenario.test",
  },
  extreme: {
    student: "extreme-student@scenario.test",
    lecturer: "extreme-lecturer@scenario.test",
  },
};

/** Walk one signed-in role through its pages, screenshotting each stop. */
async function walk(page, dir, stops, errors, label) {
  for (const stop of stops) {
    const t0 = Date.now();
    try {
      if (stop.path) {
        await page.goto(`${BASE_URL}${stop.path}`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(800);
      }
      if (stop.click) {
        await stop.click(page);
      }
      await page.waitForTimeout(stop.settle ?? 1200);
      const name = `${String(stop.n).padStart(2, "0")}_${stop.name}.png`;
      await page.screenshot({ path: path.join(dir, name), fullPage: stop.fullPage ?? true });
      console.log(`  [${label}] ${stop.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      console.log(`  [${label}] FAILED ${stop.name}: ${String(e.message).split("\n")[0]}`);
      errors.push({ scenario: label, stop: stop.name, error: String(e.message).split("\n")[0] });
    }
  }
}

async function signIn(page, email) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  // fill() can outrun React hydration — the DOM value lands but state never
  // updates, and the server action receives empty credentials. Real key
  // events (with a click to confirm focus) are hydration-safe.
  await page.click('input[type="email"]');
  await page.keyboard.type(email, { delay: 5 });
  await page.click('input[type="password"]');
  await page.keyboard.type(PASSWORD, { delay: 5 });
  await page.getByRole("button", { name: /sign in/i }).click();
  await page
    .waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25000, waitUntil: "commit" })
    .catch(async () => {
      await page.waitForSelector("text=Invalid email or password", { timeout: 1000 }).catch(() => {});
      throw new Error(`login did not navigate for ${email}`);
    });
  await page.waitForTimeout(1500);
}

async function runScenario(which, browser, report, { theme = "light" } = {}) {
  const accounts = SCENARIOS[which];
  // Dark pass writes screenshots to <scenario>-dark so both passes coexist.
  const dir = path.join(ROOT, theme === "dark" ? `${which}-dark` : which);
  fs.mkdirSync(dir, { recursive: true });
  const label = theme === "dark" ? `${which}-dark` : which;
  const errors = [];
  const consoleIssues = [];

  console.log(`\n=== SCENARIO ${label} ===`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // The theme boot script reads this key pre-paint (AX-1), so seeding it
  // before any navigation renders every stop in the requested theme.
  if (theme === "dark") {
    await context.addInitScript(() => {
      window.localStorage.setItem("innovision.theme", "dark");
    });
  }
  const page = await context.newPage();
  page.on("pageerror", (err) => {
    consoleIssues.push({ scenario: label, where: page.url(), text: err.message.slice(0, 200) });
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleIssues.push({ scenario: label, where: page.url(), text: msg.text().slice(0, 200) });
    }
  });

  // ── Lecturer pass ──
  await signIn(page, accounts.lecturer);
  let n = 1;
  const lecturerStops = [
    { n: n++, name: "lecturer_classes_hub", path: "/lecturer/classes" },
    { n: n++, name: "lecturer_class_detail", path: "/lecturer/classes", click: async (p) => {
        await p.locator("li a, a").filter({ hasText: /—/ }).first().click({ timeout: 15000 });
      } },
    { n: n++, name: "lecturer_gradebook", path: "/lecturer/classes", click: async (p) => {
        await p.locator("li a, a").filter({ hasText: /—/ }).first().click({ timeout: 15000 });
        const href = await p.locator('a[href*="/gradebook"]').first().getAttribute("href", { timeout: 15000 });
        await p.goto(`${BASE_URL}${href}`, { waitUntil: "domcontentloaded" });
      } },
    { n: n++, name: "lecturer_results_dashboard", path: "/lecturer/classes", click: async (p) => {
        await p.locator("li a, a").filter({ hasText: /—/ }).first().click({ timeout: 15000 });
        await p.locator('a[href*="/results"]').first().click({ timeout: 15000 });
      } },
    { n: n++, name: "lecturer_session_detail", path: "/lecturer/classes", click: async (p) => {
        await p.locator("li a, a").filter({ hasText: /—/ }).first().click({ timeout: 15000 });
        await p.locator('a[href*="/results"]').first().click({ timeout: 15000 });
        await p.locator('a[href*="/results/"]').first().click({ timeout: 15000 });
      } },
    { n: n++, name: "lecturer_builder", path: "/lecturer/classes", click: async (p) => {
        await p.locator("li a, a").filter({ hasText: /—/ }).first().click({ timeout: 15000 });
        // Clicking the quiz title navigates to its builder (the e2e suite's
        // route into the builder — E40 pattern).
        await p.getByText(/Draft:|Assessment:|Practice:|Weekly Quiz/i).first().click({ timeout: 15000 });
        await p.waitForURL(/\/lecturer\/quizzes\/[^/]+\/builder/, { timeout: 15000 });
      } },
  ];
  await walk(page, dir, lecturerStops, errors, label);

  // ── Student pass (fresh session) ──
  await context.clearCookies();
  await signIn(page, accounts.student);
  n = 10;
  const studentStops = [
    { n: n++, name: "student_classes", path: "/student/classes" },
    { n: n++, name: "student_quizzes", path: "/student/quizzes" },
    { n: n++, name: "student_my_quizzes", path: "/student/my-quizzes" },
    { n: n++, name: "student_my_quizzes_new", path: "/student/my-quizzes/new" },
    { n: n++, name: "student_face_setup", path: "/student/face/enroll" },
  ];
  await walk(page, dir, studentStops, errors, label);

  await context.close();
  report[label] = { errors, consoleIssues };
}

async function run() {
  const which = (process.argv[2] ?? "all").toLowerCase();
  const report = {};
  const browser = await chromium.launch({ headless: true });
  try {
    if (which === "dark") {
      // Dark-mode audit: the normal scenario in both themes for comparison.
      await runScenario("normal", browser, report, { theme: "light" });
      await runScenario("normal", browser, report, { theme: "dark" });
    } else if (which === "all") {
      for (const k of Object.keys(SCENARIOS)) await runScenario(k, browser, report);
    } else {
      if (!SCENARIOS[which]) throw new Error(`unknown scenario: ${which}`);
      await runScenario(which, browser, report);
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(ROOT, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`\nDone. Screenshots in ${ROOT}; report.json written.`);
  const totalIssues = Object.values(report).flatMap((r) => r.consoleIssues ?? []);
  if (totalIssues.length) {
    console.log(`\nConsole/page errors captured: ${totalIssues.length}`);
    const seen = new Set();
    for (const c of totalIssues) {
      const key = `${c.text.slice(0, 90)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  - [${c.scenario}] ${key}`);
    }
  }
}

run().catch((e) => {
  console.error("Explorer failed:", e);
  process.exit(1);
});
