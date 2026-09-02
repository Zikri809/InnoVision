import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SCREENSHOT_DIR = path.resolve(process.cwd(), "screenshots/explore_prod");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const findings = [];
const consoleLogs = [];
const errors = [];

function noteFinding({ area, screen, severity, issue, recommendation }) {
  findings.push({ area, screen, severity, issue, recommendation });
  console.log(`\n[${severity.toUpperCase()}] [${area}] ${screen}: ${issue}\n  -> Rec: ${recommendation}`);
}

async function run() {
  console.log("Starting deep exploration of InnoVision on production build...");
  console.log(`Target URL: ${BASE_URL}`);
  console.log(`Screenshots will be saved to: ${SCREENSHOT_DIR}`);

  const browser = await chromium.launch({ headless: true });
  
  // Create desktop context
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
  });

  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      consoleLogs.push({ type: msg.type(), text: msg.text(), url: page.url() });
    }
  });

  page.on("pageerror", (err) => {
    console.error(`[PAGE ERROR] on ${page.url()}:`, err.message);
    errors.push({ type: "pageerror", text: err.message, stack: err.stack, url: page.url() });
  });

  // ==========================================
  // SECTION 1: PUBLIC & AUTH CORNERS
  // ==========================================
  console.log("\n--- Exploring Public & Auth Pages ---");

  // 1.1 Landing / Root
  await page.goto(`${BASE_URL}/`);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01_landing.png"), fullPage: true });

  // 1.2 Login Page
  await page.goto(`${BASE_URL}/login`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02_login_initial.png") });

  // Test invalid login
  await page.fill('input[type="email"]', "invalid_user@innovision.test");
  await page.fill('input[type="password"]', "WrongPassword123!");
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03_login_invalid.png") });

  // 1.3 Register Page
  await page.goto(`${BASE_URL}/register`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "04_register_student.png") });

  // Check Lecturer role toggle on register
  const lecturerRoleBtn = page.getByRole("button", { name: /lecturer/i }).or(page.getByLabel(/lecturer/i)).or(page.getByText(/lecturer/i)).first();
  if (await lecturerRoleBtn.isVisible()) {
    await lecturerRoleBtn.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "05_register_lecturer_invite.png") });
  }

  // 1.4 Forgot Password
  await page.goto(`${BASE_URL}/forgot-password`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "06_forgot_password.png") });

  // 1.5 404 Not Found Page
  await page.goto(`${BASE_URL}/non-existent-route-404-check`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "07_404_page.png") });

  // ==========================================
  // SECTION 2: LECTURER JOURNEY & DASHBOARDS
  // ==========================================
  console.log("\n--- Exploring Lecturer Workspace ---");

  // Sign in as Dr. Farah Omar
  await page.goto(`${BASE_URL}/login`);
  await page.fill('input[type="email"]', "lecturer@innovision.test");
  await page.fill('input[type="password"]', "Password123!");
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 10000 });
  await page.waitForTimeout(1500);

  // 2.1 Lecturer Classes Hub
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "08_lecturer_classes_hub.png"), fullPage: true });

  // Create Class Modal
  const createClassBtn = page.getByRole("button", { name: /create class|new class|\+ class/i }).first();
  if (await createClassBtn.isVisible()) {
    await createClassBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "09_create_class_dialog.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }

  // 2.2 Archived Classes Page
  await page.goto(`${BASE_URL}/lecturer/classes/archived`);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "10_archived_classes_page.png"), fullPage: true });

  // 2.3 Class Detail: CS101 (Active Course)
  await page.goto(`${BASE_URL}/lecturer/classes`);
  await page.waitForTimeout(800);
  const cs101Card = page.getByText("CS101 — Intro to Algorithms").first();
  if (await cs101Card.isVisible()) {
    await cs101Card.click();
    await page.waitForURL(/\/lecturer\/classes\/[a-f0-9-]+/, { timeout: 8000 });
    await page.waitForTimeout(1000);
    const classUrl = page.url();
    const classId = classUrl.split("/").pop();

    // Quizzes tab
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "11_cs101_quizzes_tab.png"), fullPage: true });

    // Students / Roster tab
    const studentsTab = page.getByRole("tab", { name: /students|roster|enrolled/i }).or(page.getByText(/students/i)).first();
    if (await studentsTab.isVisible()) {
      await studentsTab.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "12_cs101_students_tab.png"), fullPage: true });
    }

    // 2.4 Class Gradebook
    await page.goto(`${BASE_URL}/lecturer/classes/${classId}/gradebook`);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "13_cs101_gradebook.png"), fullPage: true });

    // 2.5 Quiz Results Dashboard: Weekly Quiz 3 (Closed Assessment with sessions)
    await page.goto(classUrl);
    await page.waitForTimeout(800);
    const weekly3Results = page.locator("a[href*='/results']").first();
    if (await weekly3Results.isVisible()) {
      await weekly3Results.click();
      await page.waitForURL(/\/lecturer\/quizzes\/[a-f0-9-]+\/results/, { timeout: 8000 });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "14_weekly3_results_dashboard.png"), fullPage: true });

      // Click on a student session with integrity traces (e.g. Wei Jian or Mei Mei)
      const sessionLink = page.locator("a[href*='/results/']").first();
      if (await sessionLink.isVisible()) {
        await sessionLink.click();
        await page.waitForURL(/\/lecturer\/quizzes\/[a-f0-9-]+\/results\/[a-f0-9-]+/, { timeout: 8000 });
        await page.waitForTimeout(1200);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "15_session_detail_view.png"), fullPage: true });
      }
    }

    // 2.6 Quiz Builder: Draft or Live Quiz
    await page.goto(classUrl);
    await page.waitForTimeout(800);
    const builderLink = page.locator("a[href*='/builder']").first();
    if (await builderLink.isVisible()) {
      await builderLink.click();
      await page.waitForURL(/\/lecturer\/quizzes\/[a-f0-9-]+\/builder/, { timeout: 8000 });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "16_quiz_builder_overview.png"), fullPage: true });

      // Test AI Quiz Generator Dialog
      const aiBtn = page.getByRole("button", { name: /ai|generate|ai generate/i }).first();
      if (await aiBtn.isVisible()) {
        await aiBtn.click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "17_ai_generator_modal.png") });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }

      // Test Question editing accordion/card expansion
      const addQBtn = page.getByRole("button", { name: /add question|\+ question/i }).first();
      if (await addQBtn.isVisible()) {
        await addQBtn.click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "18_quiz_builder_add_question.png"), fullPage: true });
      }
    }
  }

  // ==========================================
  // SECTION 3: STUDENT JOURNEY & PRACTICE
  // ==========================================
  console.log("\n--- Exploring Student Experience ---");
  await context.clearCookies();

  // Sign in as Danish (student1@innovision.test)
  await page.goto(`${BASE_URL}/login`);
  await page.fill('input[type="email"]', "student1@innovision.test");
  await page.fill('input[type="password"]', "Password123!");
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 10000 });
  await page.waitForTimeout(1500);

  // 3.1 Student Classes Hub
  await page.goto(`${BASE_URL}/student/classes`);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "19_student_classes_hub.png"), fullPage: true });

  // Join Class Modal
  const joinClassBtn = page.getByRole("button", { name: /join class|\+ join/i }).first();
  if (await joinClassBtn.isVisible()) {
    await joinClassBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "20_student_join_modal.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }

  // 3.2 Student Assigned Quizzes Page
  await page.goto(`${BASE_URL}/student/quizzes`);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "21_student_assigned_quizzes.png"), fullPage: true });

  // 3.3 Taking / Resuming a Practice Quiz
  const resumePracticeBtn = page.locator("a[href*='/play/'], button:has-text('Practice'), button:has-text('Resume')").first();
  if (await resumePracticeBtn.isVisible()) {
    await resumePracticeBtn.click();
    await page.waitForURL(/\/play\//, { timeout: 8000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "22_practice_quiz_player.png"), fullPage: true });

    // Try selecting an option to observe interaction feedback
    const optionButton = page.locator("button[role='radio'], [data-option], label:has(input[type='radio'])").first();
    if (await optionButton.isVisible()) {
      await optionButton.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "23_practice_option_selected.png") });
    }
  }

  // 3.4 Student Self-Created Quizzes (SQ)
  await page.goto(`${BASE_URL}/student/my-quizzes`);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "24_student_my_quizzes.png"), fullPage: true });

  // 3.5 Create New Student Quiz
  await page.goto(`${BASE_URL}/student/my-quizzes/new`);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "25_student_new_quiz_builder.png"), fullPage: true });

  // 3.6 Public Shared Quiz Link (/s/STUDYHARD2)
  await page.goto(`${BASE_URL}/s/STUDYHARD2`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "26_shared_quiz_preview_desktop.png"), fullPage: true });

  // Start playing the shared quiz
  const startSharedBtn = page.getByRole("button", { name: /start quiz|start practice|play/i }).or(page.getByRole("link", { name: /start|play/i })).first();
  if (await startSharedBtn.isVisible()) {
    await startSharedBtn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "27_shared_quiz_player.png"), fullPage: true });
  }

  // 3.7 Matric Capture Flow
  await page.goto(`${BASE_URL}/matric-capture`);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "28_matric_capture_desktop.png"), fullPage: true });

  // ==========================================
  // SECTION 4: MOBILE RESPONSIVENESS AUDIT (375px)
  // ==========================================
  console.log("\n--- Testing Mobile Viewport (375px) ---");
  await page.setViewportSize({ width: 375, height: 812 });

  // Mobile Landing
  await page.goto(`${BASE_URL}/`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "29_mobile_landing.png"), fullPage: true });

  // Mobile Student Quizzes
  await page.goto(`${BASE_URL}/student/quizzes`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "30_mobile_student_quizzes.png"), fullPage: true });

  // Mobile Student My-Quizzes
  await page.goto(`${BASE_URL}/student/my-quizzes`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "31_mobile_my_quizzes.png"), fullPage: true });

  // Mobile Shared Quiz
  await page.goto(`${BASE_URL}/s/STUDYHARD2`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "32_mobile_shared_quiz.png"), fullPage: true });

  // Mobile Lecturer Gradebook
  await page.goto(`${BASE_URL}/login`);
  await page.fill('input[type="email"]', "lecturer@innovision.test");
  await page.fill('input[type="password"]', "Password123!");
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 10000 });
  await page.waitForTimeout(1500);

  // Mobile Lecturer Classes
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "33_mobile_lecturer_classes.png"), fullPage: true });

  await browser.close();

  fs.writeFileSync(
    path.join(SCREENSHOT_DIR, "exploration_data.json"),
    JSON.stringify({ consoleLogs, errors, findings }, null, 2),
    "utf8"
  );
  console.log(`\nExploration completed! Generated 33 screenshots in ${SCREENSHOT_DIR}.`);
}

run().catch((err) => {
  console.error("Exploration error:", err);
  process.exit(1);
});
