// Scenario seed — provisions THREE dataset sizes so the UI explorer can
// screenshot the app under realistic and extreme data loads:
//
//   first   : one brand-new student + one brand-new lecturer, zero data.
//   normal  : a normal semester — student_norm in 8 classes; lecturer_norm
//             with 5 classes × ~48 students, quizzes across the lifecycle,
//             session history on closed assessments.
//   extreme : 2-3 semesters of accumulation — lecturer_extreme with 12
//             classes (some archived) × ~45 students and a semester of
//             closed+revealed history; student_extreme enrolled in 22
//             classes spanning active + archived, with many attempts.
//
// Idempotent: existing rows are reused. Re-runs only top up what's missing.
// Run:  node scripts/seed-scenarios.mjs [first|normal|extreme|all]
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

const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !SERVICE) {
  console.error("Missing .env.local keys (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  process.exit(1);
}
const isLocalUrl = URL_.includes("localhost") || URL_.includes("127.0.0.1");
if (!isLocalUrl) {
  console.error("SAFETY GUARD: refusing to seed a remote Supabase project.");
  process.exit(1);
}

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const PASSWORD = "Password123!";
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

function code(len) {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

// ── Users (paginated lookup — listUsers caps perPage) ───────────────
const userCache = new Map();
async function loadAllUsers() {
  if (userCache.size) return userCache;
  for (let p = 1; p <= 40; p++) {
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 500, page: p });
    if (error) throw error;
    if (!data?.users?.length) break;
    for (const u of data.users) userCache.set(u.email, u);
    if (data.users.length < 500) break;
  }
  return userCache;
}

async function ensureUser({ email, name, role, matric = null }) {
  const users = await loadAllUsers();
  let user = users.get(email);
  if (!user) {
    const payload = {
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: name, ...(matric ? { matric_no: matric } : {}) },
    };
    let { data, error } = await admin.auth.admin.createUser(payload);
    // A claimed matric fails INSIDE createUser (the signup trigger writes the
    // profile row) as a generic "Database error" — retry without the matric
    // rather than aborting the whole scenario.
    if (error && /database error/i.test(error.message ?? "")) {
      ({ data, error } = await admin.auth.admin.createUser({
        ...payload,
        user_metadata: { full_name: name },
      }));
    }
    if (error && /already been registered/i.test(error.message ?? "")) {
      user = (await loadAllUsers()).get(email);
      if (!user) throw error;
    } else if (error) throw error;
    else user = data.user;
    console.log(`  + user ${email}`);
  }
  const baseProfile = { role, full_name: name };
  const withMatric = matric ? { ...baseProfile, matric_no: matric } : baseProfile;
  let { error } = await admin.from("profiles").update(withMatric).eq("id", user.id);
  if (error && /matric_no_unique|duplicate key|23505/i.test(error.message ?? "")) {
    ({ error } = await admin.from("profiles").update(baseProfile).eq("id", user.id));
  }
  if (error) throw error;
  return { id: user.id, email, name, role };
}

// Bulk student pool with unique matrics (6-digit format, prefix keeps
// scenarios/cities apart: 240xxx normal cohort, 220xxx extreme cohort).
// `count` controls the pool size — classes slide rosters out of this pool, so
// it must exceed the largest class size (55+) for believable 50-student loads.
async function ensureStudentPool(prefix, names, matricPrefix, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(
      await ensureUser({
        email: `${prefix}-s${i + 1}@scenario.test`,
        name: names[i % names.length] + (i >= names.length ? ` ${Math.floor(i / names.length) + 1}` : ""),
        role: "student",
        matric: `${matricPrefix}${String((i + 1) % 1000).padStart(3, "0")}`,
      }),
    );
  }
  return out;
}

// ── Classes / enrollments ───────────────────────────────────────────
async function ensureClass({ lecturerId, title, joinCode, archivedAt = null }) {
  const { data: found } = await admin
    .from("classes").select("id").eq("join_code", joinCode).maybeSingle();
  if (found) return found.id;
  const { data, error } = await admin
    .from("classes")
    .insert({ lecturer_id: lecturerId, title, join_code: joinCode, archived_at: archivedAt })
    .select("id").single();
  if (error) throw error;
  console.log(`  + class ${title}${archivedAt ? " [archived]" : ""}`);
  return data.id;
}

async function ensureEnrollments(classId, studentIds) {
  const rows = studentIds.map((sid) => ({ class_id: classId, student_id: sid }));
  const { error } = await admin
    .from("class_enrollments").upsert(rows, { onConflict: "class_id,student_id" });
  if (error) throw error;
}

// ── Quizzes / questions ─────────────────────────────────────────────
async function ensureQuiz({ classId, createdBy, title, mode, timeLimitSec, status, questions, revealed = false }) {
  let { data: quiz } = await admin
    .from("quizzes").select("id, status").eq("class_id", classId).eq("title", title).maybeSingle();
  if (!quiz) {
    const { data, error } = await admin
      .from("quizzes")
      .insert({ class_id: classId, created_by: createdBy, title, mode, time_limit_sec: timeLimitSec })
      .select("id, status").single();
    if (error) throw error;
    quiz = data;
  }
  const { count } = await admin
    .from("questions").select("id", { count: "exact", head: true }).eq("quiz_id", quiz.id);
  if ((count ?? 0) === 0 && questions?.length) {
    await admin.from("questions").insert(
      questions.map((q, i) => ({
        quiz_id: quiz.id, order_index: i, type: q.type, prompt: q.prompt,
        options: q.options, correct_index: q.correctIndex, explanation: q.explanation ?? null,
      })),
    );
  }
  if (quiz.status === "draft" && (status === "live" || status === "closed")) {
    await admin.from("quizzes").update({ status: "live" }).eq("id", quiz.id);
    quiz.status = "live";
  }
  if (status === "closed" && quiz.status !== "closed") {
    await admin.from("quizzes").update({ status: "closed" }).eq("id", quiz.id);
    quiz.status = "closed";
  }
  if (revealed) {
    await admin.from("quizzes")
      .update({ results_revealed_at: new Date().toISOString() })
      .eq("id", quiz.id).is("results_revealed_at", null);
  }
  return quiz.id;
}

// ── Sessions (bulk per quiz) ────────────────────────────────────────
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Seed completed sessions for a subset of the class roster.
 * participants: [{ id, correct, wrongOffset, focusPauses, advisories }]
 */
async function seedCompletedSessions({ quizId, mode, startedDaysAgo, participants }) {
  const { data: qs } = await admin
    .from("questions").select("id, correct_index, options")
    .eq("quiz_id", quizId).order("order_index");
  const papers = qs ?? [];
  const existing = new Set();
  for (const part of chunk(participants, 100)) {
    const { data: found } = await admin
      .from("quiz_sessions").select("id, student_id")
      .eq("quiz_id", quizId).in("student_id", part.map((p) => p.id));
    for (const s of found ?? []) existing.add(s.student_id);
  }
  const fresh = participants.filter((p) => !existing.has(p.id));
  if (!fresh.length) return;

  const sessionRows = fresh.map((p, i) => {
    const startMs = Date.now() - startedDaysAgo * 86400000 + (i % 45) * 60000;
    const endMs = startMs + (5 + (i % 9)) * 60000;
    return {
      quiz_id: quizId, student_id: p.id, mode, status: "completed",
      score: p.correct, submitted_at: new Date(endMs).toISOString(),
      started_at: new Date(startMs).toISOString(), last_activity_at: new Date(endMs).toISOString(),
      focus_pause_count: p.focusPauses ?? 0,
    };
  });
  const inserted = [];
  for (const part of chunk(sessionRows, 200)) {
    const { data, error } = await admin.from("quiz_sessions").insert(part).select("id, student_id");
    if (error) throw error;
    inserted.push(...data);
  }

  const byStudent = new Map(fresh.map((p) => [p.id, p]));
  const answerRows = [];
  const advisoryRows = [];
  for (const s of inserted) {
    const p = byStudent.get(s.student_id);
    const off = p.wrongOffset ?? 0;
    const nCorrect = Math.max(0, Math.min(p.correct, papers.length));
    // The LAST nCorrect slots (rotated by off) are answered correctly so the
    // selected index, is_correct flag, and the session score all agree.
    const correctSlots = new Set(
      papers.map((_, i) => i).filter((i) => {
        const rotated = (i + off) % papers.length;
        return rotated >= papers.length - nCorrect;
      }),
    );
    papers.forEach((q, i) => {
      const len = Array.isArray(q.options) && q.options.length > 1 ? q.options.length : 2;
      const isCorrect = correctSlots.has(i);
      answerRows.push({
        session_id: s.id, question_id: q.id,
        selected_index: isCorrect ? q.correct_index : (q.correct_index + 1 + (i % (len - 1))) % len,
        is_correct: isCorrect,
      });
    });
    (p.advisories ?? []).forEach((adv_type, i) => {
      advisoryRows.push({
        session_id: s.id, adv_type,
        first_seen_at: new Date(Date.now() - startedDaysAgo * 86400000).toISOString(),
        last_seen_at: new Date(Date.now() - startedDaysAgo * 86400000 + 600000).toISOString(),
        occurrences: 1 + ((i + off) % 3),
      });
    });
  }
  for (const part of chunk(answerRows, 500)) {
    const { error } = await admin.from("session_answers").insert(part);
    if (error) throw error;
  }
  if (advisoryRows.length) {
    for (const part of chunk(advisoryRows, 200)) {
      const { error } = await admin.from("session_advisories").upsert(part, { onConflict: "session_id,adv_type" });
      if (error) throw error;
    }
  }
  console.log(`    + ${inserted.length} completed sessions (${answerRows.length} answers)`);
}

/** A couple of in-progress sessions so dashboards show live states. */
async function seedActiveSessions({ quizId, mode, studentIds }) {
  for (const sid of studentIds) {
    const { data: existing } = await admin
      .from("quiz_sessions").select("id")
      .eq("quiz_id", quizId).eq("student_id", sid).eq("mode", mode).maybeSingle();
    if (existing) continue;
    await admin.from("quiz_sessions").insert({
      quiz_id: quizId, student_id: sid, mode, status: "active",
      started_at: new Date(Date.now() - 12 * 60000).toISOString(),
      last_activity_at: new Date(Date.now() - 3 * 60000).toISOString(),
    });
  }
}

// ── Question banks (small deterministic pools per topic) ────────────
function q(mcqPrompt, options, correctIndex, explanation) {
  return { type: "mcq", prompt: mcqPrompt, options, correctIndex, explanation };
}
function tf(prompt, correctIndex, explanation) {
  return { type: "true_false", prompt, options: ["True", "False"], correctIndex, explanation };
}
const BANK = {
  algorithms: [
    q("Which sorting algorithm repeatedly swaps neighbours that are out of order?", ["Merge sort", "Bubble sort", "Selection sort", "Heap sort"], 1, "Bubbling the largest value to the end each pass."),
    tf("Merge sort needs extra memory for merging.", 0, "The merge step uses a temporary buffer."),
    q("Binary search requires the list to be…", ["Unsorted", "Sorted", "Unique", "Numeric"], 1, "Halving only works on sorted order."),
    q("Big-O of quicksort on average?", ["O(n)", "O(n log n)", "O(n²)", "O(log n)"], 1, "Random pivots halve the range on average."),
    tf("A priority queue pops the most urgent item first.", 0, "It orders by priority, not arrival."),
  ],
  databases: [
    q("Which JOIN keeps unmatched LEFT-side rows?", ["INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "CROSS JOIN"], 1, "LEFT JOIN preserves the left table."),
    tf("A foreign key can be NULL.", 0, "Nullable FKs model optional relationships."),
    q("Which normal form removes partial dependencies?", ["1NF", "2NF", "3NF", "BCNF"], 1, "2NF requires dependence on the whole key."),
    q("What does a diamond represent in an ER diagram?", ["Entity", "Attribute", "Relationship", "Key"], 2, "Diamonds are relationships."),
    tf("An index speeds up writes.", 1, "Indexes trade write cost for read speed."),
  ],
  networks: [
    q("Which layer does a router operate at?", ["Layer 2", "Layer 3", "Layer 4", "Layer 7"], 1, "Routers forward based on IP."),
    tf("TCP guarantees packet order.", 0, "Sequence numbers allow reordering."),
    q("CSMA/CD is used in…", ["Wi-Fi", "Classic Ethernet", "Bluetooth", "Fibre"], 1, "Wired Ethernet collides and backs off."),
    q("DNS mainly resolves…", ["MAC addresses", "Names to IPs", "Ports", "Routes"], 1, "Names to addresses."),
    tf("UDP is connectionless.", 0, "No handshake, no ordering."),
  ],
  web: [
    q("Which HTTP status is 'Not Found'?", ["301", "404", "500", "200"], 1, "404 = resource missing."),
    tf("CSS flexbox lays out along one axis.", 0, "Flex is one-dimensional; grid is two."),
    q("Which method is idempotent?", ["POST", "GET", "PATCH", "CONNECT"], 1, "GET never mutates."),
    q("React keys help with…", ["Styling", "Reconciliation", "Routing", "Storage"], 1, "Keys map children across renders."),
    tf("localStorage persists across tabs.", 0, "Same-origin tabs share it."),
  ],
  ai: [
    q("Gradient descent minimises…", ["Accuracy", "The loss", "The epochs", "Learning rate"], 1, "Steps follow the negative gradient."),
    tf("Overfitting means poor test performance.", 0, "Memorised training noise."),
    q("Which is a tree ensemble?", ["SVM", "Random Forest", "K-means", "PCA"], 1, "Bagged decision trees."),
    q("ReLU outputs…", ["-1..1", "max(0, x)", "logits", "probabilities"], 1, "Rectified linear unit."),
    tf("Dropout is used at inference time.", 1, "It is training-only regularisation."),
  ],
  maths: [
    q("Derivative of x² is…", ["x", "2x", "x²/2", "2"], 1, "Power rule."),
    tf("A matrix times its transpose is symmetric.", 0, "AᵀA is always symmetric."),
    q("P(A∪B) equals…", ["P(A)+P(B)", "P(A)+P(B)−P(A∩B)", "P(A)P(B)", "1−P(A)"], 1, "Inclusion-exclusion."),
    q("Eigenvalues satisfy…", ["Av=λv", "A+v=0", "Aᵀ=λA", "v=λA"], 0, "Definition of eigenvectors."),
    tf("Integration is the inverse of differentiation.", 0, "Fundamental theorem of calculus."),
  ],
  security: [
    q("Hashing passwords should use…", ["MD5", "bcrypt/Argon2", "SHA1", "Base64"], 1, "Slow, salted KDFs resist brute force."),
    tf("HTTPS encrypts the URL path.", 0, "The path is encrypted; the domain leaks via DNS/SNI."),
    q("SQL injection is prevented by…", ["Escaping quotes", "Parameterised queries", "Hiding errors", "WAF only"], 1, "Parameters separate code from data."),
    q("2FA adds…", ["A second password", "A second factor", "Longer sessions", "Faster login"], 1, "Something you have / are."),
    tf("Salt must be secret.", 1, "Salt only needs to be unique per user."),
  ],
  os: [
    q("A deadlock requires…", ["One process", "Circular wait", "Preemption", "Spooling"], 1, "Four Coffman conditions include circular wait."),
    tf("Paging eliminates external fragmentation.", 0, "Fixed-size frames avoid it."),
    q("A mutex is used for…", ["Scheduling", "Mutual exclusion", "Paging", "Caching"], 1, "Locking a critical section."),
    q("Context switches happen between…", ["Threads", "Disks", "Pages", "Buses"], 0, "The kernel swaps register state."),
    tf("SSDs have seek time like HDDs.", 1, "No moving heads."),
  ],
};
const TOPICS = Object.keys(BANK);
function pickQuestions(topic, n) {
  const bank = BANK[topic] ?? BANK.algorithms;
  return bank.slice(0, n);
}

// Names cycle realistically (Malaysian university register).
const NAMES = [
  "Muhammad Danish", "Nur Aisyah", "Lim Wei Jian", "Tan Mei Mei", "Arjun Kumar",
  "Siti Zubaidah", "Ahmad Firdaus", "Priya Nair", "Chong Kah Meng", "Nurul Huda",
  "Farhan Iqbal", "Michelle Lee", "Hafiz Rahman", "Devi Shetty", "Wong Kar Wai",
  "Aina Sofea", "Gopal Krishnan", "Nabilah Zain", "Kevin Fernandez", "Chloe Tan",
  "Zulkifli Osman", "Rajeswari Devi", "Adam Mikhail", "Intan Suraya", "Marcus Yeo",
  "Fatimah Az-zahra", "Loke Yuen Yow", "Sarah Jane", "Amir Hakim", "Grace Lau",
];

// ════════════════════════════════════════════════════════════════════
// SCENARIO: FIRST — brand-new accounts, zero data
// ════════════════════════════════════════════════════════════════════
async function seedFirst() {
  console.log("\n== SCENARIO first — empty accounts ==");
  await ensureUser({ email: "first-student@scenario.test", name: "Aisyah Karim", role: "student", matric: "290001" });
  await ensureUser({ email: "first-lecturer@scenario.test", name: "Dr. Halim Osman", role: "lecturer" });
  console.log("  first-time accounts ready");
}

// ════════════════════════════════════════════════════════════════════
// SCENARIO: NORMAL — a realistic current semester
// ════════════════════════════════════════════════════════════════════
async function seedNormal() {
  console.log("\n== SCENARIO normal — normal semester load ==");

  const lecturer = await ensureUser({ email: "norm-lecturer@scenario.test", name: "Dr. Farah Omar", role: "lecturer" });
  const lecturer2 = await ensureUser({ email: "norm-lecturer2@scenario.test", name: "Dr. Rajesh Kumar", role: "lecturer" });
  const student = await ensureUser({ email: "norm-student@scenario.test", name: "Muhammad Danish", role: "student", matric: "240001" });

  // Cohort pool shared across classes (a real cohort takes many courses).
  const pool = await ensureStudentPool("norm", NAMES, "240", 60);
  console.log(`  pool: ${pool.length} students`);

  // 5 classes for the main lecturer, 3 for the second (student enrolls in 8).
  const courseDefs = [
    { title: "CS201 — Data Structures", topic: "algorithms", lecturer, size: 48 },
    { title: "CS202 — Database Systems", topic: "databases", lecturer, size: 52 },
    { title: "CS203 — Operating Systems", topic: "os", lecturer, size: 45 },
    { title: "CS204 — Computer Networks", topic: "networks", lecturer, size: 50 },
    { title: "CS205 — Web Programming", topic: "web", lecturer, size: 46 },
    { title: "CS206 — Intro to AI", topic: "ai", lecturer: lecturer2, size: 44 },
    { title: "MA201 — Discrete Maths", topic: "maths", lecturer: lecturer2, size: 55 },
    { title: "CS207 — Cybersecurity Basics", topic: "security", lecturer: lecturer2, size: 47 },
  ];

  const classIds = [];
  for (let i = 0; i < courseDefs.length; i++) {
    const def = courseDefs[i];
    console.log(`  ${def.title}`);
    const classId = await ensureClass({ lecturerId: def.lecturer.id, title: def.title, joinCode: code(6) });
    classIds.push(classId);

    // Roster: the pool slides across classes so shared students are realistic.
    const roster = [];
    for (let k = 0; k < def.size; k++) roster.push(pool[(k + i * 7) % pool.length]);
    const uniqueRoster = [...new Map(roster.map((r) => [r.id, r])).values()];
    await ensureEnrollments(classId, uniqueRoster.map((r) => r.id));
    if (!uniqueRoster.find((r) => r.id === student.id)) {
      await ensureEnrollments(classId, [student.id]);
      uniqueRoster.push(student);
    }

    // Lifecycle per class: practice(live) + assessment(live) + assessment(closed, revealed) + draft
    const topic = def.topic;
    const practiceId = await ensureQuiz({
      classId, createdBy: def.lecturer.id, title: `Practice: ${def.title.split("—")[1]?.trim() ?? topic} drills`,
      mode: "practice", timeLimitSec: null, status: "live", questions: pickQuestions(topic, 4),
    });
    const liveId = await ensureQuiz({
      classId, createdBy: def.lecturer.id, title: `Assessment: ${def.title.split("—")[1]?.trim() ?? topic} midterm`,
      mode: "assessment", timeLimitSec: 900, status: "live", questions: pickQuestions(topic, 5),
    });
    const closedId = await ensureQuiz({
      classId, createdBy: def.lecturer.id, title: `Weekly Quiz 1 — ${def.title.split("—")[1]?.trim() ?? topic} (closed)`,
      mode: "assessment", timeLimitSec: 600, status: "closed", questions: pickQuestions(topic, 4), revealed: true,
    });
    await ensureQuiz({
      classId, createdBy: def.lecturer.id, title: `Draft: ${def.title.split("—")[1]?.trim() ?? topic} finals (WIP)`,
      mode: "assessment", timeLimitSec: 1200, status: "draft", questions: pickQuestions(topic, 2),
    });

    // Session history on the closed quiz: ~75% participation, varied scores.
    const total = pickQuestions(topic, 4).length;
    const participants = uniqueRoster
      .filter((r) => r.id !== student.id)
      .filter((_, k) => k % 4 !== 3) // a quarter of the class skipped it
      .map((r, k) => ({
        id: r.id,
        correct: [4, 3, 3, 2, 4, 1, 3, 2][k % 8],
        wrongOffset: k,
        focusPauses: k % 9 === 0 ? 2 : 0,
        advisories: k % 11 === 0 ? ["looked_away"] : k % 13 === 0 ? ["voice_activity"] : [],
      }));
    await seedCompletedSessions({ quizId: closedId, mode: "assessment", startedDaysAgo: 6 + i, participants });
    // The scenario student did some, skipped some (variety of card states).
    if (i % 2 === 0) {
      await seedCompletedSessions({
        quizId: closedId, mode: "assessment", startedDaysAgo: 6 + i,
        participants: [{ id: student.id, correct: 3, wrongOffset: 2, focusPauses: 0, advisories: [] }],
      });
    }
    // Live assessment: early birds have submitted; a couple still in progress.
    await seedCompletedSessions({
      quizId: liveId, mode: "assessment", startedDaysAgo: 0.2,
      participants: uniqueRoster.slice(0, 6).filter((r) => r.id !== student.id).map((r, k) => ({
        id: r.id, correct: 3 + (k % 3), wrongOffset: k, focusPauses: 0, advisories: [],
      })),
    });
    await seedActiveSessions({ quizId: liveId, mode: "assessment", studentIds: uniqueRoster.slice(6, 8).map((r) => r.id) });
    await seedActiveSessions({ quizId: practiceId, mode: "practice", studentIds: [uniqueRoster[9].id] });
  }

  // Student-created quizzes for the scenario student.
  const { data: sq } = await admin.from("student_quizzes")
    .select("id").eq("created_by", student.id).eq("title", "CS201 revision drill").maybeSingle();
  if (!sq) {
    const { data: created, error } = await admin.from("student_quizzes")
      .insert({ created_by: student.id, title: "CS201 revision drill", description: "Sharing with the study group before the midterm." })
      .select("id").single();
    if (!error) {
      await admin.from("student_quizzes").update({ share_code: code(10) }).eq("id", created.id);
      await admin.from("student_quiz_questions").insert([
        { quiz_id: created.id, order_index: 0, type: "mcq", prompt: "Stack order of operations is…", options: ["FIFO", "LIFO", "Random", "Priority"], correct_index: 1, explanation: "Last in, first out." },
        { quiz_id: created.id, order_index: 1, type: "true_false", prompt: "Binary search needs sorted input.", options: ["True", "False"], correct_index: 0, explanation: "Halving requires order." },
      ]);
    }
  }
  console.log("  normal scenario ready");
}

// ════════════════════════════════════════════════════════════════════
// SCENARIO: EXTREME — 2-3 semesters of accumulation
// ════════════════════════════════════════════════════════════════════
async function seedExtreme() {
  console.log("\n== SCENARIO extreme — multi-semester accumulation ==");

  const lecturer = await ensureUser({ email: "extreme-lecturer@scenario.test", name: "Prof. Lim Chee Seng", role: "lecturer" });
  const student = await ensureUser({ email: "extreme-student@scenario.test", name: "Nurul Huda", role: "student", matric: "220001" });

  const pool = await ensureStudentPool("extreme", NAMES, "220", 60);
  console.log(`  pool: ${pool.length} students`);

  // 12 classes across 3 semesters: 4 archived (past), 8 active.
  const semesterTags = [
    { tag: "2024 Session 1", archived: true, daysAgo: 300 },
    { tag: "2024 Session 2", archived: true, daysAgo: 150 },
    { tag: "2025 Session 1", archived: false, daysAgo: 40 },
  ];
  const topics = TOPICS;
  const classRefs = [];
  for (let i = 0; i < 12; i++) {
    const sem = semesterTags[Math.floor(i / 4)];
    const topic = topics[i % topics.length];
    const title = `${topic.toUpperCase()} ${200 + i} — ${topic} ${sem.tag}`;
    console.log(`  ${title}`);
    const classId = await ensureClass({
      lecturerId: lecturer.id, title, joinCode: code(6),
      archivedAt: sem.archived ? new Date(Date.now() - sem.daysAgo * 86400000).toISOString() : null,
    });
    const size = 42 + ((i * 5) % 18); // 42..59
    const roster = [];
    for (let k = 0; k < size; k++) roster.push(pool[(k + i * 11) % pool.length]);
    const uniqueRoster = [...new Map(roster.map((r) => [r.id, r])).values()];
    if (i < 9) uniqueRoster.push(student); // the scenario student took 9 of them
    await ensureEnrollments(classId, uniqueRoster.map((r) => r.id));

    const closedId = await ensureQuiz({
      classId, createdBy: lecturer.id, title: `Final assessment — ${topic}`,
      mode: "assessment", timeLimitSec: 900, status: "closed", questions: pickQuestions(topic, 5), revealed: true,
    });
    await ensureQuiz({
      classId, createdBy: lecturer.id, title: `Weekly quiz — ${topic} basics (closed)`,
      mode: "assessment", timeLimitSec: 600, status: "closed", questions: pickQuestions(topic, 4),
    });
    if (!sem.archived) {
      await ensureQuiz({
        classId, createdBy: lecturer.id, title: `Assessment: ${topic} midterm`,
        mode: "assessment", timeLimitSec: 900, status: "live", questions: pickQuestions(topic, 5),
      });
      await ensureQuiz({
        classId, createdBy: lecturer.id, title: `Practice: ${topic} warm-ups`,
        mode: "practice", timeLimitSec: null, status: "live", questions: pickQuestions(topic, 4),
      });
    }

    // History: heavy participation on the closed final (~70%).
    const participants = uniqueRoster
      .filter((r) => r.id !== student.id)
      .filter((_, k) => k % 10 !== 3)
      .map((r, k) => ({
        id: r.id,
        correct: [5, 4, 4, 3, 2, 5, 4, 1][k % 8],
        wrongOffset: k,
        focusPauses: k % 7 === 0 ? 1 : 0,
        advisories: k % 9 === 0 ? ["looked_away"] : [],
      }));
    await seedCompletedSessions({ quizId: closedId, mode: "assessment", startedDaysAgo: sem.daysAgo, participants });
    if (uniqueRoster.includes(student)) {
      await seedCompletedSessions({
        quizId: closedId, mode: "assessment", startedDaysAgo: sem.daysAgo,
        participants: [{ id: student.id, correct: 4, wrongOffset: 3, focusPauses: 0, advisories: [] }],
      });
    }
    classRefs.push(classId);
  }
  console.log("  extreme scenario ready");
}

// ── Main ────────────────────────────────────────────────────────────
const which = (process.argv[2] ?? "all").toLowerCase();
try {
  if (which === "first" || which === "all") await seedFirst();
  if (which === "normal" || which === "all") await seedNormal();
  if (which === "extreme" || which === "all") await seedExtreme();
  console.log("\nDone. Accounts use password: " + PASSWORD);
  console.log("  first   : first-student@scenario.test / first-lecturer@scenario.test");
  console.log("  normal  : norm-student@scenario.test / norm-lecturer@scenario.test (+ norm-lecturer2)");
  console.log("  extreme : extreme-student@scenario.test / extreme-lecturer@scenario.test");
} catch (e) {
  console.error("\nSEED FAILED:", e?.message ?? e);
  process.exit(1);
}
