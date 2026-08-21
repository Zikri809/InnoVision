// Demo seed — provisions 1 lecturer + 2 students and a full set of demo
// classes/quizzes/questions/sessions so every screen can be clicked through.
//
// Idempotent: safe to re-run. Existing users are reused (by email); the demo
// class is reused (by fixed join code); quizzes are matched by title and only
// published/questioned when missing. Nothing is deleted.
//
// Run:  node scripts/seed-demo.mjs
// Requires .env.local keys (NEXT_PUBLIC_SUPABASE_URL / ANON / SERVICE_ROLE).
//
// Demo logins (password for all):  Password123!
//   lecturer@innovision.test   (role: lecturer)
//   student1@innovision.test   (role: student)
//   student2@innovision.test   (role: student)
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env.local");
const env = fs
  .readFileSync(envPath, "utf8")
  .split(/\r?\n/)
  .filter((l) => l && !l.trim().startsWith("#"))
  .reduce((acc, l) => {
    const idx = l.indexOf("=");
    if (idx > 0) acc[l.slice(0, idx).trim()] = l.slice(idx + 1).trim();
    return acc;
  }, {});

const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SERVICE) {
  console.error("Missing .env.local keys (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  process.exit(1);
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

const PASSWORD = "Password123!";
const CLASS_JOIN_CODE = "DEMK42"; // 6 chars, unambiguous alphabet (no 0/O/1/I)
const CLASS_TITLE = "CS101 — Intro to Algorithms";

const PEOPLE = [
  { email: "lecturer@innovision.test", name: "Dr. Ada Lovelace", role: "lecturer" },
  { email: "student1@innovision.test", name: "Alan Turing", role: "student" },
  { email: "student2@innovision.test", name: "Grace Hopper", role: "student" },
];

function log(msg) {
  console.log(msg);
}

// ── Users ───────────────────────────────────────────────────────────
async function listAllUsers() {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  return data.users;
}

async function ensureUser({ email, name, role }) {
  const existing = (await listAllUsers()).find((u) => u.email === email);
  let user = existing;
  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: name },
    });
    if (error) throw error;
    user = data.user;
    log(`  + created user ${email}`);
  } else {
    log(`  = reusing user ${email}`);
    // Ensure password is known & confirmed (idempotent re-runs).
    await admin.auth.admin.updateUserById(user.id, { password: PASSWORD, email_confirm: true });
  }

  // Ensure profile role + name (the signup trigger creates a 'student' row;
  // promote lecturers via service role, bypassing RLS).
  const { error } = await admin
    .from("profiles")
    .update({ role, full_name: name })
    .eq("id", user.id);
  if (error) throw error;
  return { id: user.id, email, name, role };
}

// ── Class + enrollments ─────────────────────────────────────────────
async function ensureClass(lecturerId) {
  const { data: found } = await admin
    .from("classes")
    .select("id, join_code")
    .eq("join_code", CLASS_JOIN_CODE)
    .maybeSingle();
  if (found) {
    log(`  = reusing class ${CLASS_TITLE} (${CLASS_JOIN_CODE})`);
    return found.id;
  }
  const { data, error } = await admin
    .from("classes")
    .insert({ lecturer_id: lecturerId, title: CLASS_TITLE, join_code: CLASS_JOIN_CODE })
    .select("id")
    .single();
  if (error) throw error;
  log(`  + created class ${CLASS_TITLE} (${CLASS_JOIN_CODE})`);
  return data.id;
}

async function ensureEnrollment(classId, studentId) {
  const { error } = await admin
    .from("class_enrollments")
    .upsert({ class_id: classId, student_id: studentId }, { onConflict: "class_id,student_id" });
  if (error) throw error;
}

// ── Quizzes + questions ─────────────────────────────────────────────
// Note: quizzes must start 'draft' (trigger), get questions, THEN be
// transitioned to 'live'. Questions only insert while status = 'draft'.
async function ensureQuiz({ classId, createdBy, title, mode, timeLimitSec, status, questions }) {
  let { data: quiz } = await admin
    .from("quizzes")
    .select("id, status")
    .eq("class_id", classId)
    .eq("title", title)
    .maybeSingle();

  if (!quiz) {
    const { data, error } = await admin
      .from("quizzes")
      .insert({ class_id: classId, created_by: createdBy, title, mode, time_limit_sec: timeLimitSec })
      .select("id, status")
      .single();
    if (error) throw error;
    quiz = data;
    log(`  + created ${mode} quiz "${title}" (draft)`);
  } else {
    log(`  = reusing quiz "${title}" (${quiz.status})`);
  }

  // Add questions only if the quiz currently has none.
  const { count } = await admin
    .from("questions")
    .select("id", { count: "exact", head: true })
    .eq("quiz_id", quiz.id);

  if ((count ?? 0) === 0 && questions?.length) {
    const rows = questions.map((q, i) => ({
      quiz_id: quiz.id,
      order_index: i,
      type: q.type,
      prompt: q.prompt,
      options: q.options,
      correct_index: q.correctIndex,
      explanation: q.explanation ?? null,
    }));
    const { error } = await admin.from("questions").insert(rows);
    if (error) throw error;
    log(`  + added ${rows.length} questions to "${title}"`);
  }

  // Publish if requested and not already live/closed.
  if (status === "live" && quiz.status === "draft") {
    const { error } = await admin.from("quizzes").update({ status: "live" }).eq("id", quiz.id);
    if (error) throw error;
    log(`  + published "${title}" → live`);
  }
  return { id: quiz.id, title, mode };
}

// ── Sessions + answers (for the results dashboard) ──────────────────
async function seedSession({ quizId, studentId, mode, correctCount, totalQuestions, status }) {
  // One assessment attempt per (quiz, student): skip if one already exists.
  const { data: existing } = await admin
    .from("quiz_sessions")
    .select("id")
    .eq("quiz_id", quizId)
    .eq("student_id", studentId)
    .eq("mode", mode)
    .maybeSingle();
  if (existing) {
    log(`  = session already exists for quiz ${quizId.slice(0, 8)}… student ${studentId.slice(0, 8)}…`);
    return existing.id;
  }

  const submitted = status === "completed";
  const { data: session, error } = await admin
    .from("quiz_sessions")
    .insert({
      quiz_id: quizId,
      student_id: studentId,
      mode,
      status,
      score: submitted ? correctCount : null,
      submitted_at: submitted ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  if (error) throw error;

  if (submitted) {
    // Insert answers: first `correctCount` correct, rest incorrect.
    const { data: qs, error: qErr } = await admin
      .from("questions")
      .select("id, correct_index")
      .eq("quiz_id", quizId)
      .order("order_index", { ascending: true });
    if (qErr) throw qErr;
    const answers = (qs ?? []).slice(0, totalQuestions).map((q, i) => {
      const correct = i < correctCount;
      return {
        session_id: session.id,
        question_id: q.id,
        selected_index: correct ? q.correct_index : (q.correct_index + 1) % 2 === 0 ? 0 : 1,
        is_correct: correct,
      };
    });
    if (answers.length) {
      const { error: aErr } = await admin.from("session_answers").insert(answers);
      if (aErr) throw aErr;
    }
  }
  log(`  + seeded ${status} session (score ${correctCount}/${totalQuestions})`);
  return session.id;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  log("\n== InnoVision demo seed ==\n");

  log("Users:");
  const [lecturer, s1, s2] = await Promise.all(PEOPLE.map(ensureUser));

  log("\nClass:");
  const classId = await ensureClass(lecturer.id);
  await ensureEnrollment(classId, s1.id);
  await ensureEnrollment(classId, s2.id);
  log(`  + enrolled ${s1.email} + ${s2.email}`);

  log("\nQuizzes:");
  const practice = await ensureQuiz({
    classId,
    createdBy: lecturer.id,
    title: "Practice: Data Structures Basics",
    mode: "practice",
    timeLimitSec: null,
    status: "live",
    questions: [
      { type: "mcq", prompt: "Which data structure uses FIFO (first-in, first-out) ordering?", options: ["Stack", "Queue", "Tree", "Graph"], correctIndex: 1, explanation: "A queue dequeues in the same order items were enqueued — first in, first out." },
      { type: "mcq", prompt: "Which data structure uses LIFO (last-in, first-out) ordering?", options: ["Queue", "Linked List", "Stack", "Heap"], correctIndex: 2, explanation: "A stack pops the most recently pushed item first." },
      { type: "true_false", prompt: "A binary search tree keeps its elements sorted in-order.", options: ["True", "False"], correctIndex: 0, explanation: "An in-order traversal of a BST visits keys in ascending order." },
      { type: "mcq", prompt: "What is the time complexity of binary search on a sorted array?", options: ["O(n)", "O(log n)", "O(n log n)", "O(1)"], correctIndex: 1, explanation: "Each step halves the search space, giving logarithmic time." },
    ],
  });

  const assessment = await ensureQuiz({
    classId,
    createdBy: lecturer.id,
    title: "Assessment: Midterm — Algorithms",
    mode: "assessment",
    timeLimitSec: 600,
    status: "live",
    questions: [
      { type: "mcq", prompt: "Which sorting algorithm has O(n log n) worst-case time?", options: ["Bubble sort", "Insertion sort", "Merge sort", "Selection sort"], correctIndex: 2, explanation: "Merge sort always divides in half and merges linearly." },
      { type: "true_false", prompt: "A hash table guarantees O(1) lookup in the worst case.", options: ["True", "False"], correctIndex: 1, explanation: "Collisions can degrade lookups; O(1) is the average case." },
      { type: "mcq", prompt: "Which traversal visits the root node first?", options: ["In-order", "Pre-order", "Post-order", "Level-order"], correctIndex: 1, explanation: "Pre-order visits root, then left, then right." },
      { type: "mcq", prompt: "What does a priority queue typically use internally?", options: ["Array", "Heap", "Stack", "Linked list"], correctIndex: 1, explanation: "A binary heap gives O(log n) insert and extract." },
      { type: "true_false", prompt: "Dijkstra's algorithm works with negative edge weights.", options: ["True", "False"], correctIndex: 1, explanation: "Negative weights break Dijkstra's greedy assumption; use Bellman-Ford." },
    ],
  });

  await ensureQuiz({
    classId,
    createdBy: lecturer.id,
    title: "Draft: Graph Theory (WIP)",
    mode: "practice",
    timeLimitSec: null,
    status: "draft",
    questions: [
      { type: "mcq", prompt: "A graph with no cycles is called a…", options: ["Tree", "Complete graph", "Bipartite graph", "DAG only"], correctIndex: 0, explanation: "A connected acyclic graph is a tree." },
      { type: "true_false", prompt: "A DAG can be topologically sorted.", options: ["True", "False"], correctIndex: 0, explanation: "Directed acyclic graphs always admit a topological ordering." },
    ],
  });

  log("\nSessions (results dashboard):");
  // Student1: completed the assessment 4/5. Student2: completed it 3/5.
  await seedSession({ quizId: assessment.id, studentId: s1.id, mode: "assessment", correctCount: 4, totalQuestions: 5, status: "completed" });
  await seedSession({ quizId: assessment.id, studentId: s2.id, mode: "assessment", correctCount: 3, totalQuestions: 5, status: "completed" });
  // Student2 also did a practice run (completed 3/4).
  await seedSession({ quizId: practice.id, studentId: s2.id, mode: "practice", correctCount: 3, totalQuestions: 4, status: "completed" });

  log("\n== Done ==\n");
  log("Sign in at http://localhost:3000/login  (password for all: " + PASSWORD + ")");
  for (const p of PEOPLE) log(`  ${p.role.padEnd(9)}  ${p.email}`);
  log(`\nStudent join code for ${CLASS_TITLE}: ${CLASS_JOIN_CODE}\n`);
}

main().catch((e) => {
  console.error("\nSEED FAILED:", e?.message ?? e);
  process.exit(1);
});
