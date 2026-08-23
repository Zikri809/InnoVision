// Demo seed — provisions a REALISTIC semester of InnoVision usage so every
// screen can be clicked through with believable data:
//   • 2 lecturers, 10 students (varied engagement: some do everything, some
//     only play shared quizzes, some have never attempted anything)
//   • 3 classes: two active (different courses), one archived
//   • Lecturer quizzes across the full lifecycle: draft → live → CLOSED with
//     historical sessions + revealed results (a past weekly quiz)
//   • Session spread: completed assessments with varied scores, an ACTIVE
//     practice session mid-progress, completed practice runs
//   • Student-created PRACTICE quizzes (the SQ feature): some SHARED via
//     /s/<code> links, some kept private — as real students would use them
//
// Face setup is intentionally NOT seeded (biometric enrollment stays a
// deliberate user action).
//
// Idempotent: safe to re-run. Users reused by email, classes by join code,
// quizzes by (class, title), student quizzes by (creator, title). Nothing is
// deleted; share codes are only set when currently NULL.
//
// Run:  node scripts/seed-demo.mjs
// Requires .env.local keys (NEXT_PUBLIC_SUPABASE_URL / SERVICE_ROLE).
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

const isLocalUrl = URL.includes("localhost") || URL.includes("127.0.0.1");
if (!isLocalUrl && process.env.ALLOW_PROD_SEED !== "1" && env.ALLOW_PROD_SEED !== "1") {
  console.error(
    `\n⚠️ SAFETY GUARD: Target Supabase URL (${URL}) appears to be a remote/production environment.` +
    `\nSeeding demo accounts and mock data to a remote project is blocked by default.` +
    `\nIf you intended to seed this remote project, re-run with: ALLOW_PROD_SEED=1 node scripts/seed-demo.mjs\n`
  );
  process.exit(1);
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

const PASSWORD = "Password123!";
// Join codes: 6 chars, unambiguous alphabet (no 0/O/1/I/L).
// Share codes: 10 chars from the SAME alphabet (CHECK-enforced).

const PEOPLE = [
  { email: "lecturer@innovision.test", name: "Dr. Ada Lovelace", role: "lecturer" },
  { email: "lecturer2@innovision.test", name: "Dr. Alan Kay", role: "lecturer" },
  { email: "student1@innovision.test", name: "Alan Turing", role: "student" },
  { email: "student2@innovision.test", name: "Grace Hopper", role: "student" },
  { email: "student3@innovision.test", name: "Margaret Hamilton", role: "student" },
  { email: "student4@innovision.test", name: "Barbara Liskov", role: "student" },
  { email: "student5@innovision.test", name: "Donald Knuth", role: "student" },
  { email: "student6@innovision.test", name: "Radia Perlman", role: "student" },
  { email: "student7@innovision.test", name: "Ken Thompson", role: "student" },
  { email: "student8@innovision.test", name: "Adele Goldberg", role: "student" },
  { email: "student9@innovision.test", name: "Tim Berners-Lee", role: "student" },
  { email: "student10@innovision.test", name: "Anita Borg", role: "student" },
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
async function ensureClass({ lecturerId, title, joinCode, archivedAt = null }) {
  const { data: found } = await admin
    .from("classes")
    .select("id, join_code")
    .eq("join_code", joinCode)
    .maybeSingle();
  if (found) {
    log(`  = reusing class ${title} (${joinCode})`);
    return found.id;
  }
  const { data, error } = await admin
    .from("classes")
    .insert({ lecturer_id: lecturerId, title, join_code: joinCode, archived_at: archivedAt })
    .select("id")
    .single();
  if (error) throw error;
  log(`  + created class ${title} (${joinCode})${archivedAt ? " [archived]" : ""}`);
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
// transitioned toward 'live'/'closed'. Questions only insert while 'draft'.
// A 'closed' target walks draft→live→closed like a real past quiz.
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

  // Transition toward the requested status along the legal path.
  if (quiz.status === "draft" && (status === "live" || status === "closed")) {
    const { error } = await admin.from("quizzes").update({ status: "live" }).eq("id", quiz.id);
    if (error) throw error;
    log(`  + published "${title}" → live`);
  }
  if (status === "closed" && quiz.status !== "closed") {
    // Re-read: the publish above may have just flipped it.
    const { data: cur } = await admin.from("quizzes").select("status").eq("id", quiz.id).single();
    if (cur?.status === "live") {
      const { error } = await admin.from("quizzes").update({ status: "closed" }).eq("id", quiz.id);
      if (error) throw error;
      log(`  + closed "${title}"`);
    }
  }
  return { id: quiz.id, title, mode };
}

/** Reveal results on an assessment (one-way gate the dashboard respects). */
async function ensureRevealed(quizId) {
  await admin
    .from("quizzes")
    .update({ results_revealed_at: new Date().toISOString() })
    .eq("id", quizId)
    .is("results_revealed_at", null);
}

// ── Sessions + answers (for the results dashboard) ──────────────────
async function seedSession({ quizId, studentId, mode, correctCount, totalQuestions, status }) {
  // One attempt per (quiz, student, mode) for these statuses: skip if exists.
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
  const startedAt = new Date(Date.now() - (submitted ? 2 * 86400000 : 15 * 60000)).toISOString();
  const { data: session, error } = await admin
    .from("quiz_sessions")
    .insert({
      quiz_id: quizId,
      student_id: studentId,
      mode,
      status,
      score: submitted ? correctCount : null,
      submitted_at: submitted ? new Date(Date.now() - 2 * 86400000 + 14 * 60000).toISOString() : null,
      started_at: startedAt,
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
  log(`  + seeded ${status} ${mode} session (score ${correctCount}/${totalQuestions})`);
  return session.id;
}

// ── Student-created practice quizzes (SQ feature) ───────────────────
// Mirrors what the API/RPC produce: creator-owned rows; sharing = setting a
// 10-char alphabet code. Plays leave NO rows (stateless grading) — so no
// "attempts by others" are seeded, matching privacy-by-construction.
async function ensureStudentQuiz({ createdBy, title, description, shareCode, questions }) {
  let { data: quiz } = await admin
    .from("student_quizzes")
    .select("id, share_code")
    .eq("created_by", createdBy)
    .eq("title", title)
    .maybeSingle();

  if (!quiz) {
    const { data, error } = await admin
      .from("student_quizzes")
      .insert({ created_by: createdBy, title, description: description ?? null })
      .select("id, share_code")
      .single();
    if (error) throw error;
    quiz = data;
    log(`  + created student quiz "${title}"`);
  } else {
    log(`  = reusing student quiz "${title}"`);
  }

  const { count } = await admin
    .from("student_quiz_questions")
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
    const { error } = await admin.from("student_quiz_questions").insert(rows);
    if (error) throw error;
    log(`    + ${rows.length} questions`);
  }

  if (shareCode && !quiz.share_code) {
    const { error } = await admin
      .from("student_quizzes")
      .update({ share_code: shareCode })
      .eq("id", quiz.id);
    if (error) throw error;
    log(`    + shared at /s/${shareCode}`);
  }
  return quiz.id;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  log("\n== InnoVision demo seed ==\n");

  log("Users:");
  const people = [];
  for (const p of PEOPLE) people.push(await ensureUser(p));
  const [ada, kay] = people.filter((p) => p.role === "lecturer");
  const [alan, grace, margaret, barbara, donald, radia, ken, adele, tim, anita] =
    people.filter((p) => p.role === "student");

  log("\nClasses:");
  const cs101 = await ensureClass({
    lecturerId: ada.id,
    title: "CS101 — Intro to Algorithms",
    joinCode: "DEMK42",
  });
  const cs205 = await ensureClass({
    lecturerId: kay.id,
    title: "CS205 — Database Systems",
    joinCode: "DBSYS5",
  });
  const cs100 = await ensureClass({
    lecturerId: ada.id,
    title: "CS100 — Programming Fundamentals (Archived)",
    joinCode: "ARCH99",
    archivedAt: new Date(Date.now() - 7 * 86400000).toISOString(),
  });

  log("Enrollments:");
  for (const s of [alan, grace, margaret, barbara, donald, radia]) {
    await ensureEnrollment(cs101, s.id);
  }
  for (const s of [grace, radia, ken, adele, tim, anita]) {
    await ensureEnrollment(cs205, s.id);
  }
  await ensureEnrollment(cs100, alan.id);
  log("  + CS101: alan, grace, margaret, barbara, donald, radia");
  log("  + CS205: grace, radia, ken, adele, tim, anita");
  log("  + CS100 (archived): alan");

  log("\nCS101 quizzes:");
  const practice = await ensureQuiz({
    classId: cs101,
    createdBy: ada.id,
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

  const midterm = await ensureQuiz({
    classId: cs101,
    createdBy: ada.id,
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

  // A PAST quiz everyone took — closed, results revealed, full session history.
  const weekly3 = await ensureQuiz({
    classId: cs101,
    createdBy: ada.id,
    title: "Weekly Quiz 3 — Sorting (closed)",
    mode: "assessment",
    timeLimitSec: 420,
    status: "closed",
    questions: [
      { type: "mcq", prompt: "Which sort is stable and in-place?", options: ["Merge sort", "Insertion sort", "Heap sort", "Quick sort"], correctIndex: 1, explanation: "Insertion sort never reorders equal elements and uses O(1) extra space." },
      { type: "true_false", prompt: "Quick sort's average case is better than bubble sort's.", options: ["True", "False"], correctIndex: 0, explanation: "O(n log n) vs O(n²)." },
      { type: "mcq", prompt: "What is the worst case of quick sort?", options: ["O(n)", "O(n log n)", "O(n²)", "O(log n)"], correctIndex: 2, explanation: "Already-sorted input with a bad pivot degrades to quadratic." },
    ],
  });
  await ensureRevealed(weekly3.id);

  await ensureQuiz({
    classId: cs101,
    createdBy: ada.id,
    title: "Draft: Graph Theory (WIP)",
    mode: "practice",
    timeLimitSec: null,
    status: "draft",
    questions: [
      { type: "mcq", prompt: "A graph with no cycles is called a…", options: ["Tree", "Complete graph", "Bipartite graph", "DAG only"], correctIndex: 0, explanation: "A connected acyclic graph is a tree." },
      { type: "true_false", prompt: "A DAG can be topologically sorted.", options: ["True", "False"], correctIndex: 0, explanation: "Directed acyclic graphs always admit a topological ordering." },
    ],
  });

  log("\nCS205 quizzes:");
  await ensureQuiz({
    classId: cs205,
    createdBy: kay.id,
    title: "Practice: ER Modelling & Normalization",
    mode: "practice",
    timeLimitSec: null,
    status: "live",
    questions: [
      { type: "mcq", prompt: "Which normal form removes partial dependencies on a composite key?", options: ["1NF", "2NF", "3NF", "BCNF"], correctIndex: 1, explanation: "2NF requires every non-key attribute to depend on the WHOLE key." },
      { type: "true_false", prompt: "A foreign key can contain NULLs.", options: ["True", "False"], correctIndex: 0, explanation: "Nullable FKs model optional relationships." },
      { type: "mcq", prompt: "In an ER diagram, what does a diamond represent?", options: ["Entity", "Attribute", "Relationship", "Key"], correctIndex: 2, explanation: "Diamonds are relationships; rectangles are entities." },
    ],
  });
  await ensureQuiz({
    classId: cs205,
    createdBy: kay.id,
    title: "Assessment: SQL Practical (draft)",
    mode: "assessment",
    timeLimitSec: 900,
    status: "draft",
    questions: [
      { type: "mcq", prompt: "Which JOIN returns all rows from both sides, matching where possible?", options: ["INNER JOIN", "LEFT JOIN", "FULL OUTER JOIN", "CROSS JOIN"], correctIndex: 2, explanation: "FULL OUTER keeps unmatched rows from both tables." },
    ],
  });

  log("\nSessions (past + present):");
  // Closed weekly quiz — the whole class took it two days ago, mixed results.
  await seedSession({ quizId: weekly3.id, studentId: alan.id, mode: "assessment", correctCount: 3, totalQuestions: 3, status: "completed" });
  await seedSession({ quizId: weekly3.id, studentId: grace.id, mode: "assessment", correctCount: 3, totalQuestions: 3, status: "completed" });
  await seedSession({ quizId: weekly3.id, studentId: margaret.id, mode: "assessment", correctCount: 2, totalQuestions: 3, status: "completed" });
  await seedSession({ quizId: weekly3.id, studentId: barbara.id, mode: "assessment", correctCount: 1, totalQuestions: 3, status: "completed" });
  await seedSession({ quizId: weekly3.id, studentId: donald.id, mode: "assessment", correctCount: 3, totalQuestions: 3, status: "completed" });
  // Live midterm — early submissions so far.
  await seedSession({ quizId: midterm.id, studentId: alan.id, mode: "assessment", correctCount: 4, totalQuestions: 5, status: "completed" });
  await seedSession({ quizId: midterm.id, studentId: grace.id, mode: "assessment", correctCount: 3, totalQuestions: 5, status: "completed" });
  // Practice engagement: grace finished a run; alan has one IN PROGRESS.
  await seedSession({ quizId: practice.id, studentId: grace.id, mode: "practice", correctCount: 3, totalQuestions: 4, status: "completed" });
  await seedSession({ quizId: practice.id, studentId: alan.id, mode: "practice", correctCount: 0, totalQuestions: 4, status: "active" });

  log("\nStudent-created practice quizzes (SQ):");
  await ensureStudentQuiz({
    createdBy: alan.id,
    title: "Big-O Cheat Sheet Drill",
    description: "My revision set for the midterm — mostly complexity questions.",
    shareCode: "STUDYHARD2",
    questions: [
      { type: "mcq", prompt: "Average case of a linear search?", options: ["O(1)", "O(log n)", "O(n)", "O(n²)"], correctIndex: 2, explanation: "On average you scan half the array." },
      { type: "true_false", prompt: "Binary search works on unsorted arrays.", options: ["True", "False"], correctIndex: 1, explanation: "It relies on sorted order to halve the range." },
      { type: "mcq", prompt: "Cost of inserting at the HEAD of a linked list?", options: ["O(1)", "O(n)", "O(n log n)", "Amortized O(1)"], correctIndex: 0, explanation: "Just rewire two pointers — no shifting." },
      { type: "true_false", prompt: "Quicksort is stable.", options: ["True", "False"], correctIndex: 1, explanation: "Partitioning can reorder equal elements." },
    ],
  });
  await ensureStudentQuiz({
    createdBy: grace.id,
    title: "SQL Joins Practice",
    description: "Made this while revising for the CS205 practical. Good luck!",
    shareCode: "EXAMPREP24",
    questions: [
      { type: "mcq", prompt: "Which JOIN keeps unmatched LEFT-side rows?", options: ["INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "CROSS JOIN"], correctIndex: 1, explanation: "LEFT JOIN preserves the left table, NULL-filling the rest." },
      { type: "true_false", prompt: "CROSS JOIN produces n × m rows.", options: ["True", "False"], correctIndex: 0, explanation: "Every left row pairs with every right row." },
      { type: "mcq", prompt: "SELF JOIN is…", options: ["A syntax error", "A table joined with itself", "Two databases joined", "A view"], correctIndex: 1, explanation: "Use aliases to distinguish the two copies." },
    ],
  });
  await ensureStudentQuiz({
    createdBy: radia.id,
    title: "Packet Flow Drill",
    description: null, // real students often skip the description
    shareCode: null,    // kept private
    questions: [
      { type: "mcq", prompt: "Which layer does a router primarily operate at?", options: ["Layer 2", "Layer 3", "Layer 4", "Layer 7"], correctIndex: 1, explanation: "Routers forward based on IP (layer 3)." },
      { type: "true_false", prompt: "TCP guarantees packet order.", options: ["True", "False"], correctIndex: 0, explanation: "Sequence numbers allow reordering on arrival." },
    ],
  });
  log("  (barbara/donald/etc. haven't made any — realistic distribution)");

  log("\n== Done ==\n");
  log("Sign in at http://localhost:3000/login  (password for all: " + PASSWORD + ")");
  log("  lecturers : lecturer@innovision.test, lecturer2@innovision.test");
  log("  students  : student1@…test … student10@…test (see PEOPLE above)");
  log(`\nJoin codes : CS101=${"DEMK42"}  CS205=DBSYS5`);
  log("Shared student quizzes:");
  log("  /s/STUDYHARD2  — Big-O Cheat Sheet Drill (Alan)");
  log("  /s/EXAMPREP24  — SQL Joins Practice (Grace)");
  log("\nFace setup intentionally NOT seeded — enrollment stays a user action.\n");
}

main().catch((e) => {
  console.error("\nSEED FAILED:", e?.message ?? e);
  process.exit(1);
});
