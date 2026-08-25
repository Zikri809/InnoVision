// Demo seed — provisions a REALISTIC semester of InnoVision usage so every
// screen can be clicked through with believable data:
//   • 2 lecturers, 10 students with local-flavoured names (varied engagement:
//     some do everything, some only play shared quizzes, some never attempt)
//   • 3 classes: two active (different courses), one archived
//   • Lecturer quizzes across the full lifecycle: draft → live → CLOSED with
//     historical sessions + revealed results (a past weekly quiz)
//   • EASY, natural-sounding questions (intro-course register, mostly recall
//     with one stretch item per set) so demos click through believably
//   • Session spread: staggered start times/durations, scores with wrong
//     answers scattered across the paper, an ACTIVE practice session
//   • Integrity traces on past assessments: focus pauses + advisories
//     (looked_away / voice_activity) populate the results-dashboard chips
//   • Student-created PRACTICE quizzes (the SQ feature): some SHARED via
//     /s/<code> links, some kept private — as real students would use them
//
// NOTE: idempotent = existing rows are REUSED, not rewritten. Changing the
// question text here does NOT update quizzes that were seeded before (their
// sessions/answers reference the old rows). For a clean slate:
//   supabase db reset && npm run seed:demo
//
// Face setup is intentionally NOT seeded (biometric enrollment stays a
// deliberate user action).
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
  { email: "lecturer@innovision.test", name: "Dr. Farah Omar", role: "lecturer" },
  { email: "lecturer2@innovision.test", name: "Dr. Rajesh Kumar", role: "lecturer" },
  { email: "student1@innovision.test", name: "Muhammad Danish", role: "student", matric: "231201" },
  { email: "student2@innovision.test", name: "Nur Aisyah", role: "student", matric: "231202" },
  { email: "student3@innovision.test", name: "Lim Wei Jian", role: "student", matric: "231203" },
  { email: "student4@innovision.test", name: "Tan Mei Mei", role: "student", matric: "231204" },
  { email: "student5@innovision.test", name: "Arjun Kumar", role: "student", matric: "231205" },
  { email: "student6@innovision.test", name: "Siti Zubaidah", role: "student", matric: "231206" },
  { email: "student7@innovision.test", name: "Ahmad Firdaus", role: "student", matric: "231207" },
  { email: "student8@innovision.test", name: "Priya Nair", role: "student", matric: "231208" },
  { email: "student9@innovision.test", name: "Chong Kah Meng", role: "student", matric: "231209" },
  { email: "student10@innovision.test", name: "Nurul Huda", role: "student", matric: "231210" },
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

async function ensureUser({ email, name, role, matric }) {
  const existing = (await listAllUsers()).find((u) => u.email === email);
  let user = existing;
  if (!user) {
    const payload = {
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: name, ...(matric ? { matric_no: matric } : {}) },
    };
    let { data, error } = await admin.auth.admin.createUser(payload);
    // Same collision guard as the profile repair below: never let one claimed
    // matric abort the whole demo provisioning.
    if (error && /duplicate key|matric_no_unique|23505/i.test(error.message ?? "")) {
      log(`  ⚠ matric ${matric} already claimed — creating ${email} without it`);
      ({ data, error } = await admin.auth.admin.createUser({
        ...payload,
        user_metadata: { full_name: name },
      }));
    }
    if (error) throw error;
    user = data.user;
    log(`  + created user ${email}`);
  } else {
    log(`  = reusing user ${email}`);
    // Ensure password is known & confirmed (idempotent re-runs).
    await admin.auth.admin.updateUserById(user.id, { password: PASSWORD, email_confirm: true });
  }

  // Ensure profile role + name + matric (the signup trigger creates a
  // 'student' row; promote lecturers via service role, bypassing RLS). The
  // matric repair here is what gives EXISTING demo DBs their matrics — the
  // createUser metadata alone only covers fresh databases (idempotent re-runs).
  // A claimed matric (real user got there first) must never abort the whole
  // seed: retry once WITHOUT the matric and carry on.
  const baseProfile = { role, full_name: name };
  const withMatric = matric ? { ...baseProfile, matric_no: matric } : baseProfile;
  let { error } = await admin.from("profiles").update(withMatric).eq("id", user.id);
  if (error && /duplicate key|matric_no_unique|23505/i.test(error.message ?? "")) {
    log(`  ⚠ matric ${matric} already claimed by another account — skipping for ${email}`);
    ({ error } = await admin.from("profiles").update(baseProfile).eq("id", user.id));
  }
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
/**
 * Seed one attempt. `opts`:
 *  - startedMinutesAgo / durationMin → realistic, spread-out timestamps
 *    (a class never submits in the same minute).
 *  - wrongOffset shifts WHICH questions were answered wrongly so two students
 *    with the same score don't have identical answer sheets.
 *  - focusPauses / advisories populate the integrity chips on the results
 *    dashboard (looked_away etc.) — believable proctoring traces.
 */
async function seedSession({
  quizId,
  studentId,
  mode,
  correctCount,
  totalQuestions,
  status,
  startedMinutesAgo = 2 * 24 * 60,
  durationMin = 12,
  wrongOffset = 0,
  focusPauses = 0,
  advisories = [],
}) {
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
  const startMs = Date.now() - startedMinutesAgo * 60000;
  const endMs = startMs + durationMin * 60000;
  const { data: session, error } = await admin
    .from("quiz_sessions")
    .insert({
      quiz_id: quizId,
      student_id: studentId,
      mode,
      status,
      score: submitted ? correctCount : null,
      submitted_at: submitted ? new Date(endMs).toISOString() : null,
      started_at: new Date(startMs).toISOString(),
      last_activity_at: new Date(submitted ? endMs : Date.now() - 5 * 60000).toISOString(),
      focus_pause_count: focusPauses,
    })
    .select("id")
    .single();
  if (error) throw error;

  if (submitted) {
    // Insert answers: exactly correctCount correct, spread across the paper
    // (wrongOffset rotates which questions miss) instead of a flat prefix.
    const { data: qs, error: qErr } = await admin
      .from("questions")
      .select("id, correct_index, options")
      .eq("quiz_id", quizId)
      .order("order_index", { ascending: true });
    if (qErr) throw qErr;
    const papers = (qs ?? []).slice(0, totalQuestions);
    const wrongSlots = new Set(
      papers.map((_, i) => i).filter((i) => i < papers.length - correctCount)
        .map((i) => (i + wrongOffset) % papers.length),
    );
    const answers = papers.map((q, i) => {
      const len = Array.isArray(q.options) && q.options.length > 1 ? q.options.length : 2;
      const correct = !wrongSlots.has(i);
      // Deterministic distractor pick — never collides with the right index.
      const wrongIndex = (q.correct_index + 1 + (i % (len - 1))) % len;
      return {
        session_id: session.id,
        question_id: q.id,
        selected_index: correct ? q.correct_index : wrongIndex,
        is_correct: correct,
      };
    });
    if (answers.length) {
      const { error: aErr } = await admin.from("session_answers").insert(answers);
      if (aErr) throw aErr;
    }
  }

  // Proctoring traces: advisory rows are unique per (session, type).
  if (advisories.length) {
    const seen = new Date(startMs + 5 * 60000).toISOString();
    const rows = advisories.map((adv_type, i) => ({
      session_id: session.id,
      adv_type,
      first_seen_at: seen,
      last_seen_at: new Date(startMs + (8 + i * 2) * 60000).toISOString(),
      occurrences: 1 + ((i + wrongOffset) % 3),
    }));
    await admin.from("session_advisories").upsert(rows, { onConflict: "session_id,adv_type" });
  }

  log(
    `  + seeded ${status} ${mode} session (score ${correctCount}/${totalQuestions}` +
      `${focusPauses ? `, ${focusPauses} focus pauses` : ""}${advisories.length ? `, advisories: ${advisories.join("+")}` : ""})`,
  );
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
  const [farah, rajesh] = people.filter((p) => p.role === "lecturer");
  const [danish, aisyah, weijian, meimei, arjun, siti, firdaus, priya, kahmeng, nurul] =
    people.filter((p) => p.role === "student");

  log("\nClasses:");
  const cs101 = await ensureClass({
    lecturerId: farah.id,
    title: "CS101 — Intro to Algorithms",
    joinCode: "DEMK42",
  });
  const cs205 = await ensureClass({
    lecturerId: rajesh.id,
    title: "CS205 — Database Systems",
    joinCode: "DBSYS5",
  });
  const cs100 = await ensureClass({
    lecturerId: farah.id,
    title: "CS100 — Programming Fundamentals (Archived)",
    joinCode: "ARCH99",
    archivedAt: new Date(Date.now() - 7 * 86400000).toISOString(),
  });

  log("Enrollments:");
  for (const s of [danish, aisyah, weijian, meimei, arjun, siti]) {
    await ensureEnrollment(cs101, s.id);
  }
  for (const s of [aisyah, siti, firdaus, priya, kahmeng, nurul]) {
    await ensureEnrollment(cs205, s.id);
  }
  await ensureEnrollment(cs100, danish.id);
  log("  + CS101: danish, aisyah, weijian, meimei, arjun, siti");
  log("  + CS205: aisyah, siti, firdaus, priya, kahmeng, nurul");
  log("  + CS100 (archived): danish");

  log("\nCS101 quizzes:");
  const practice = await ensureQuiz({
    classId: cs101,
    createdBy: farah.id,
    title: "Practice: Data Structures Basics",
    mode: "practice",
    timeLimitSec: null,
    status: "live",
    questions: [
      { type: "mcq", prompt: "You are lining up for lunch. Which data structure models this — first person in line is served first?", options: ["Stack", "Queue", "Tree", "Graph"], correctIndex: 1, explanation: "A queue serves items in arrival order (FIFO) — just like a lunch line." },
      { type: "mcq", prompt: "A pile of plates where you always take the top one is a…", options: ["Queue", "Linked List", "Stack", "Heap"], correctIndex: 2, explanation: "Last plate on is the first off — that's LIFO, the stack." },
      { type: "true_false", prompt: "A stack lets you remove items from both ends.", options: ["True", "False"], correctIndex: 1, explanation: "A stack only touches ONE end (the top); that's what makes it a stack." },
      { type: "mcq", prompt: "Searching a SORTED list by repeatedly halving it is called…", options: ["Linear search", "Binary search", "Bubble search", "Hashing"], correctIndex: 1, explanation: "Halving the range each step is binary search — O(log n)." },
    ],
  });

  const midterm = await ensureQuiz({
    classId: cs101,
    createdBy: farah.id,
    title: "Assessment: Midterm — Algorithms",
    mode: "assessment",
    timeLimitSec: 600,
    status: "live",
    questions: [
      { type: "mcq", prompt: "Which sorting algorithm repeatedly swaps neighbouring items that are out of order?", options: ["Merge sort", "Insertion sort", "Bubble sort", "Selection sort"], correctIndex: 2, explanation: "Bubbling the largest value to the end each pass = bubble sort." },
      { type: "true_false", prompt: "For large lists, merge sort is usually faster than bubble sort.", options: ["True", "False"], correctIndex: 0, explanation: "O(n log n) beats O(n²) once lists get big." },
      { type: "true_false", prompt: "Binary search works on any list, sorted or not.", options: ["True", "False"], correctIndex: 1, explanation: "Halving only finds the target if the list is sorted." },
      { type: "mcq", prompt: "Which data structure processes the MOST urgent item first?", options: ["Queue", "Priority queue", "Stack", "Array"], correctIndex: 1, explanation: "A priority queue pops by importance, not arrival order." },
      { type: "true_false", prompt: "A hash table lookup takes the same time even when nearly full.", options: ["True", "False"], correctIndex: 1, explanation: "More collisions as it fills up → slower lookups. That's why tables resize." },
    ],
  });

  // A PAST quiz everyone took — closed, results revealed, full session history.
  const weekly3 = await ensureQuiz({
    classId: cs101,
    createdBy: farah.id,
    title: "Weekly Quiz 3 — Sorting (closed)",
    mode: "assessment",
    timeLimitSec: 420,
    status: "closed",
    questions: [
      { type: "mcq", prompt: "Which sorting algorithm is usually taught FIRST because it's the most intuitive?", options: ["Quick sort", "Insertion sort", "Heap sort", "Radix sort"], correctIndex: 1, explanation: "Insertion sort mirrors how you sort playing cards in your hand." },
      { type: "true_false", prompt: "Insertion sort is quick when the list is ALREADY almost sorted.", options: ["True", "False"], correctIndex: 0, explanation: "Nearly-sorted input needs almost no shifting — O(n)-ish." },
      { type: "mcq", prompt: "Which of these has the SLOWEST average performance on big random lists?", options: ["Merge sort", "Quick sort", "Bubble sort", "Heap sort"], correctIndex: 2, explanation: "Bubble sort's O(n²) comparisons crawl on large lists." },
    ],
  });
  await ensureRevealed(weekly3.id);

  await ensureQuiz({
    classId: cs101,
    createdBy: farah.id,
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
    createdBy: rajesh.id,
    title: "Practice: ER Modelling & Normalization",
    mode: "practice",
    timeLimitSec: null,
    status: "live",
    questions: [
      { type: "mcq", prompt: "In an ER diagram, what does a diamond represent?", options: ["Entity", "Attribute", "Relationship", "Key"], correctIndex: 2, explanation: "Diamonds are relationships; rectangles are entities." },
      { type: "true_false", prompt: "A foreign key column can be empty (NULL).", options: ["True", "False"], correctIndex: 0, explanation: "Nullable FKs model optional relationships — e.g. an employee with no manager yet." },
      { type: "mcq", prompt: "Which normal form removes partial dependencies on a composite key?", options: ["1NF", "2NF", "3NF", "BCNF"], correctIndex: 1, explanation: "2NF requires every non-key attribute to depend on the WHOLE key." },
    ],
  });
  await ensureQuiz({
    classId: cs205,
    createdBy: rajesh.id,
    title: "Assessment: SQL Practical (draft)",
    mode: "assessment",
    timeLimitSec: 900,
    status: "draft",
    questions: [
      { type: "mcq", prompt: "Which JOIN returns all rows from both sides, matching where possible?", options: ["INNER JOIN", "LEFT JOIN", "FULL OUTER JOIN", "CROSS JOIN"], correctIndex: 2, explanation: "FULL OUTER keeps unmatched rows from both tables." },
    ],
  });

  log("\nSessions (past + present):");
  // Closed weekly quiz — the class took it two days ago, staggered starts and
  // mixed results. A couple of believable proctoring traces on the weaker runs.
  await seedSession({ quizId: weekly3.id, studentId: danish.id, mode: "assessment", correctCount: 3, totalQuestions: 3, status: "completed", startedMinutesAgo: 2 * 24 * 60, durationMin: 6 });
  await seedSession({ quizId: weekly3.id, studentId: aisyah.id, mode: "assessment", correctCount: 3, totalQuestions: 3, status: "completed", startedMinutesAgo: 2 * 24 * 60 + 9, durationMin: 7 });
  await seedSession({ quizId: weekly3.id, studentId: weijian.id, mode: "assessment", correctCount: 2, totalQuestions: 3, status: "completed", startedMinutesAgo: 2 * 24 * 60 + 17, durationMin: 11, wrongOffset: 1, advisories: ["voice_activity"] });
  await seedSession({ quizId: weekly3.id, studentId: meimei.id, mode: "assessment", correctCount: 1, totalQuestions: 3, status: "completed", startedMinutesAgo: 2 * 24 * 60 + 26, durationMin: 13, wrongOffset: 2, focusPauses: 2, advisories: ["looked_away"] });
  await seedSession({ quizId: weekly3.id, studentId: arjun.id, mode: "assessment", correctCount: 3, totalQuestions: 3, status: "completed", startedMinutesAgo: 2 * 24 * 60 + 38, durationMin: 5 });
  // Live midterm — early submissions so far.
  await seedSession({ quizId: midterm.id, studentId: danish.id, mode: "assessment", correctCount: 4, totalQuestions: 5, status: "completed", startedMinutesAgo: 26 * 60, durationMin: 9, wrongOffset: 1 });
  await seedSession({ quizId: midterm.id, studentId: aisyah.id, mode: "assessment", correctCount: 3, totalQuestions: 5, status: "completed", startedMinutesAgo: 25 * 60, durationMin: 10, wrongOffset: 3 });
  // Practice engagement: aisyah finished a run yesterday; danish has one IN PROGRESS right now.
  await seedSession({ quizId: practice.id, studentId: aisyah.id, mode: "practice", correctCount: 3, totalQuestions: 4, status: "completed", startedMinutesAgo: 27 * 60, durationMin: 8, wrongOffset: 1 });
  await seedSession({ quizId: practice.id, studentId: danish.id, mode: "practice", correctCount: 0, totalQuestions: 4, status: "active", startedMinutesAgo: 15 });

  log("\nStudent-created practice quizzes (SQ):");
  await ensureStudentQuiz({
    createdBy: danish.id,
    title: "Big-O Cheat Sheet Drill",
    description: "My revision set for the midterm — mostly the basics.",
    shareCode: "STUDYHARD2",
    questions: [
      { type: "mcq", prompt: "Average case of a linear search?", options: ["O(1)", "O(log n)", "O(n)", "O(n²)"], correctIndex: 2, explanation: "On average you scan half the array." },
      { type: "true_false", prompt: "Binary search works on unsorted arrays.", options: ["True", "False"], correctIndex: 1, explanation: "It relies on sorted order to halve the range." },
      { type: "mcq", prompt: "Cost of inserting at the HEAD of a linked list?", options: ["O(1)", "O(n)", "O(n log n)", "Amortized O(1)"], correctIndex: 0, explanation: "Just rewire two pointers — no shifting." },
      { type: "true_false", prompt: "Quicksort is stable.", options: ["True", "False"], correctIndex: 1, explanation: "Partitioning can reorder equal elements." },
    ],
  });
  await ensureStudentQuiz({
    createdBy: aisyah.id,
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
    createdBy: siti.id,
    title: "Packet Flow Drill",
    description: null, // real students often skip the description
    shareCode: null,    // kept private
    questions: [
      { type: "mcq", prompt: "Which layer does a router primarily operate at?", options: ["Layer 2", "Layer 3", "Layer 4", "Layer 7"], correctIndex: 1, explanation: "Routers forward based on IP (layer 3)." },
      { type: "true_false", prompt: "TCP guarantees packet order.", options: ["True", "False"], correctIndex: 0, explanation: "Sequence numbers allow reordering on arrival." },
    ],
  });
  log("  (meimei/arjun/etc. haven't made any — realistic distribution)");

  log("\n== Done ==\n");
  log("Sign in at http://localhost:3000/login  (password for all: " + PASSWORD + ")");
  log("  lecturers : lecturer@innovision.test, lecturer2@innovision.test");
  log("  students  : student1@…test … student10@…test (see PEOPLE above)");
  log(`\nJoin codes : CS101=${"DEMK42"}  CS205=DBSYS5`);
  log("\nShared student quizzes:");
  log("  /s/STUDYHARD2  — Big-O Cheat Sheet Drill (Danish)");
  log("  /s/EXAMPREP24  — SQL Joins Practice (Aisyah)");
  log("\nFace setup intentionally NOT seeded — enrollment stays a user action.\n");
}

main().catch((e) => {
  console.error("\nSEED FAILED:", e?.message ?? e);
  process.exit(1);
});
