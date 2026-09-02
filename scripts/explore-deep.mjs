import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SCREENSHOT_DIR = path.resolve(process.cwd(), "screenshots/explore_deep");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const consoleLogs = [];
const errors = [];

async function run() {
  console.log("=== Launching Headless Chromium for Deep Exploration ===");
  console.log(`Target URL: ${BASE_URL}`);
  console.log(`Screenshots will be saved to: ${SCREENSHOT_DIR}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      consoleLogs.push({ type: msg.type(), text: msg.text(), url: page.url() });
    }
  });

  page.on("pageerror", (err) => {
    console.error(`[PAGE ERROR] on ${page.url()}:`, err.message);
    errors.push({ text: err.message, stack: err.stack, url: page.url() });
  });

  // ==========================================
  // 1. PUBLIC & AUTH PAGES
  // ==========================================
  console.log("\n1. Exploring Landing & Public Pages");
  await page.goto(`${BASE_URL}/`);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01_landing_desktop.png"), fullPage: true });

  // 1.2 Login Page
  await page.goto(`${BASE_URL}/login`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02_login_empty.png") });

  // Test invalid credentials
  await page.fill('input[type="email"]', "nonexistent@test.com");
  await page.fill('input[type="password"]', "BadPass123!");
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03_login_invalid_creds.png") });

  // 1.3 Register Page
  await page.goto(`${BASE_URL}/register`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "04_register_page.png") });

  // Toggle Lecturer Role in register
  const lecturerRoleBtn = page.getByRole("button", { name: /lecturer/i }).or(page.getByText(/lecturer/i)).first();
  if (await lecturerRoleBtn.isVisible()) {
    await lecturerRoleBtn.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "05_register_lecturer_selected.png") });
  }

  // 1.4 Forgot Password & Reset
  await page.goto(`${BASE_URL}/forgot-password`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "06_forgot_password.png") });

  // 1.5 404 Not Found
  await page.goto(`${BASE_URL}/some-invalid-corner-url-xyz`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "07_404_not_found.png") });

  // ==========================================
  // 2. LECTURER EXPERIENCE (Dr. Farah Omar)
  // ==========================================
  console.log("\n2. Exploring Lecturer Journey");
  await page.goto(`${BASE_URL}/login`);
  await page.fill('input[type="email"]', "lecturer@innovision.test");
  await page.fill('input[type="password"]', "Password123!");
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 10000 });
  await page.waitForTimeout(1500);

  // 2.1 Classes Hub
  console.log("Lecturer classes URL:", page.url());
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "08_lecturer_classes_hub.png"), fullPage: true });

  // Test typing in Create Class card
  const titleInput = page.locator("#class-title");
  if (await titleInput.isVisible()) {
    await titleInput.fill("Test Sandbox Class");
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "09_lecturer_create_class_filled.png") });
    await titleInput.fill("");
  }

  // 2.2 Archived Classes Page
  await page.goto(`${BASE_URL}/lecturer/classes/archived`);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "10_lecturer_archived_classes.png"), fullPage: true });

  // 2.3 Class Detail Page (CS101)
  await page.goto(`${BASE_URL}/lecturer/classes`);
  await page.waitForTimeout(600);
  await page.click('text="CS101 — Intro to Algorithms"');
  await page.waitForURL(/\/lecturer\/classes\/[a-f0-9-]+/, { timeout: 8000 });
  await page.waitForTimeout(1000);
  const classUrl = page.url();
  const classId = classUrl.split("/").pop();
  console.log("Class detail URL:", classUrl);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "11_class_detail_quizzes.png"), fullPage: true });

  // Roster section
  const rosterHeading = page.getByText(/roster|enrolled students|students/i).first();
  if (await rosterHeading.isVisible()) {
    await rosterHeading.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "12_class_detail_roster.png"), fullPage: true });
  }

  // 2.4 Class Gradebook
  await page.goto(`${BASE_URL}/lecturer/classes/${classId}/gradebook`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "13_class_gradebook.png"), fullPage: true });

  // 2.5 Quiz Results Dashboard (Weekly Quiz 3 - Closed Assessment)
  await page.goto(classUrl);
  await page.waitForTimeout(800);
  const weekly3Row = page.locator("li", { hasText: "Weekly Quiz 3" }).first();
  if (await weekly3Row.isVisible()) {
    const resultsBtn = weekly3Row.locator("a[href*='/results']").first();
    if (await resultsBtn.isVisible()) {
      await resultsBtn.click();
      await page.waitForURL(/\/lecturer\/quizzes\/[a-f0-9-]+\/results/, { timeout: 8000 });
      await page.waitForTimeout(1200);
      const resultsUrl = page.url();
      console.log("Results dashboard URL:", resultsUrl);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "14_results_dashboard_closed_assessment.png"), fullPage: true });

      // Check Question Insights accordion
      const insightsBtn = page.getByRole("button", { name: /insights|question insights/i }).first();
      if (await insightsBtn.isVisible()) {
        await insightsBtn.click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "15_results_question_insights_expanded.png"), fullPage: true });
      }

      // Check Session Detail View (first student)
      const sessionLink = page.locator("a[href*='/results/']").first();
      if (await sessionLink.isVisible()) {
        await sessionLink.click();
        await page.waitForURL(/\/lecturer\/quizzes\/[a-f0-9-]+\/results\/[a-f0-9-]+/, { timeout: 8000 });
        await page.waitForTimeout(1200);
        console.log("Session detail URL:", page.url());
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "16_session_detail_student.png"), fullPage: true });
      }
    }
  }

  // 2.6 Quiz Builder (Practice Quiz / Midterm)
  await page.goto(classUrl);
  await page.waitForTimeout(800);
  const builderLink = page.locator("a[href*='/builder']").first();
  if (await builderLink.isVisible()) {
    await builderLink.click();
    await page.waitForURL(/\/lecturer\/quizzes\/[a-f0-9-]+\/builder/, { timeout: 8000 });
    await page.waitForTimeout(1200);
    console.log("Quiz builder URL:", page.url());
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "17_quiz_builder_overview.png"), fullPage: true });

    // Open AI Generator Dialog
    const aiBtn = page.getByRole("button", { name: /generate from file|ai/i }).first();
    if (await aiBtn.isVisible()) {
      await aiBtn.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "18_quiz_builder_generate_dialog.png") });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }

    // Open Import Questions Dialog
    const importBtn = page.getByRole("button", { name: /import questions/i }).first();
    if (await importBtn.isVisible()) {
      await importBtn.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "19_quiz_builder_import_dialog.png") });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }

    // Open Duplicate Quiz Dialog
    const duplicateBtn = page.getByRole("button", { name: /duplicate quiz/i }).first();
    if (await duplicateBtn.isVisible()) {
      await duplicateBtn.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "20_quiz_builder_duplicate_dialog.png") });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
  }

  // ==========================================
  // 3. STUDENT EXPERIENCE (Muhammad Danish)
  // ==========================================
  console.log("\n3. Exploring Student Journey");
  await context.clearCookies();

  await page.goto(`${BASE_URL}/login`);
  await page.fill('input[type="email"]', "student1@innovision.test");
  await page.fill('input[type="password"]', "Password123!");
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 10000 });
  await page.waitForTimeout(1500);

  // 3.1 Student Classes Hub
  console.log("Student Classes URL:", page.url());
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "22_student_classes_hub.png"), fullPage: true });

  // Test Join Code input & submission
  const joinCodeInput = page.locator("#join-code");
  if (await joinCodeInput.isVisible()) {
    console.log("Testing invalid join code submission...");
    await joinCodeInput.fill("INVALID99");
    await page.waitForTimeout(300);
    const joinSubmitBtn = page.locator("button[type='submit']:has-text('Join')").first();
    if (await joinSubmitBtn.isVisible()) {
      await joinSubmitBtn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "23_student_join_error.png") });
    }
    await joinCodeInput.fill("");
  }

  // 3.2 Student Assigned Quizzes Page
  await page.goto(`${BASE_URL}/student/quizzes`);
  await page.waitForTimeout(1200);
  console.log("Student Quizzes URL:", page.url());
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "24_student_assigned_quizzes.png"), fullPage: true });

  // 3.3 Taking / Playing a Practice Quiz
  const practiceLink = page.locator("a[href*='/play/']").first();
  if (await practiceLink.isVisible()) {
    const playHref = await practiceLink.getAttribute("href");
    console.log("Navigating to play quiz:", playHref);
    await page.goto(`${BASE_URL}${playHref}`);
    await page.waitForTimeout(1500);
    console.log("Play player URL:", page.url());
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "25_practice_quiz_player.png"), fullPage: true });

    // Pick an option
    const firstOption = page.locator("button[role='radio'], label:has(input[type='radio']), button:has-text('Queue'), button:has-text('Stack')").first();
    if (await firstOption.isVisible()) {
      await firstOption.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "26_practice_quiz_option_picked.png"), fullPage: true });
    }
  }

  // 3.4 Student Self-Created Quizzes (SQ feature)
  await page.goto(`${BASE_URL}/student/my-quizzes`);
  await page.waitForTimeout(1200);
  console.log("Student My Quizzes URL:", page.url());
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "27_student_my_quizzes_list.png"), fullPage: true });

  // 3.5 Create New Student Quiz
  await page.goto(`${BASE_URL}/student/my-quizzes/new`);
  await page.waitForTimeout(1200);
  console.log("Create New Student Quiz URL:", page.url());
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "28_student_create_quiz_page.png"), fullPage: true });

  // 3.6 Public Shared Quiz (/s/STUDYHARD2)
  await page.goto(`${BASE_URL}/s/STUDYHARD2`);
  await page.waitForTimeout(1200);
  console.log("Shared Quiz URL:", page.url());
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "29_shared_quiz_preview_desktop.png"), fullPage: true });

  // Start shared quiz
  const startBtn = page.getByRole("button", { name: /start quiz|start practice|play/i }).or(page.getByRole("link", { name: /start|play/i })).first();
  if (await startBtn.isVisible()) {
    await startBtn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "30_shared_quiz_playing.png"), fullPage: true });
  }

  // 3.7 Matric Capture Flow
  await page.goto(`${BASE_URL}/matric-capture`);
  await page.waitForTimeout(1000);
  console.log("Matric capture URL:", page.url());
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "31_matric_capture.png"), fullPage: true });

  // ==========================================
  // 4. RESPONSIVE / MOBILE VIEWPORT (375px)
  // ==========================================
  console.log("\n4. Testing Mobile Viewports (375px)");
  await page.setViewportSize({ width: 375, height: 812 });

  await page.goto(`${BASE_URL}/`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "32_mobile_landing.png"), fullPage: true });

  await page.goto(`${BASE_URL}/login`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "33_mobile_login.png"), fullPage: true });

  await page.goto(`${BASE_URL}/student/classes`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "34_mobile_student_classes.png"), fullPage: true });

  await page.goto(`${BASE_URL}/student/quizzes`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "35_mobile_student_quizzes.png"), fullPage: true });

  await page.goto(`${BASE_URL}/student/my-quizzes`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "36_mobile_student_my_quizzes.png"), fullPage: true });

  await page.goto(`${BASE_URL}/s/STUDYHARD2`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "37_mobile_shared_quiz.png"), fullPage: true });

  // Switch to Lecturer on mobile
  await page.goto(`${BASE_URL}/login`);
  await page.fill('input[type="email"]', "lecturer@innovision.test");
  await page.fill('input[type="password"]', "Password123!");
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 10000 });
  await page.waitForTimeout(1500);

  await page.goto(`${BASE_URL}/lecturer/classes`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "38_mobile_lecturer_classes.png"), fullPage: true });

  if (classId) {
    await page.goto(`${BASE_URL}/lecturer/classes/${classId}`);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "39_mobile_lecturer_class_detail.png"), fullPage: true });

    await page.goto(`${BASE_URL}/lecturer/classes/${classId}/gradebook`);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "40_mobile_lecturer_gradebook.png"), fullPage: true });
  }

  await browser.close();

  fs.writeFileSync(
    path.join(SCREENSHOT_DIR, "deep_audit.json"),
    JSON.stringify({ consoleLogs, errors }, null, 2),
    "utf8"
  );
  console.log(`\nDeep exploration successfully completed! Generated 40 screenshots in ${SCREENSHOT_DIR}.`);
}

run().catch((err) => {
  console.error("Exploration error:", err);
  process.exit(1);
});
