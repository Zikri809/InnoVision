// Phase 3 security/RLS verification harness — runs against live local Supabase.
// - Admin (service-role) client for provisioning + DB assertions.
// - Authenticated clients (anon key + real user tokens) to verify RLS from the
//   attacker's actual vantage point.
// Covers gate tests:
//   D5  — answer secrecy: student SELECT questions → 0 rows, never sees correct_index
//   D6  — owner lecturer reads questions → correct_index present
//   D19 — owner creates quiz (draft), adds questions, reorders, publishes → live
//   D20 — cross-lecturer isolation (lecturer B cannot read A's quiz/questions);
//         student/lecturer-B cannot create a quiz in A's class
//   D21 — publishing an empty quiz → trigger error
//   D22 — after publish, question INSERT/UPDATE/DELETE → trigger error
//   D23 — enrolled student sees live quiz row but NOT the draft quiz;
//         unenrolled student sees nothing
//   D24 — re-open transitions (live→draft, closed→live) → trigger error
// NOT a unit test; run manually: node scripts/verify-quizzes.mjs
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
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !ANON || !SERVICE) {
  console.error("Missing .env.local keys (NEXT_PUBLIC_SUPABASE_URL / ANON / SERVICE_ROLE).");
  process.exit(1);
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const results = [];
const createdUsers = [];
let createdClassId = null;
let createdQuizIds = [];

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function createUser(email) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "hunter2!Secure",
    email_confirm: true,
    user_metadata: { full_name: email.split("@")[0] },
  });
  if (error) throw error;
  createdUsers.push(data.user.id);
  return data.user;
}

async function asUser(email) {
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({
    email,
    password: "hunter2!Secure",
  });
  if (error) throw error;
  return client;
}

async function promoteLecturer(userId) {
  const { error } = await admin
    .from("profiles")
    .update({ role: "lecturer" })
    .eq("id", userId);
  if (error) throw error;
}

const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeJoinCode() {
  let c = "";
  for (let i = 0; i < 6; i++) {
    c += JOIN_CODE_ALPHABET[Math.floor(Math.random() * JOIN_CODE_ALPHABET.length)];
  }
  return c;
}

// Re-raise PostgREST errors so a harness failure isn't silently swallowed.
function assertNoError(step, { error }) {
  if (error) throw new Error(`${step}: ${error.message}`);
}

async function main() {
  // ── Provision: lecturer A, lecturer B, students S1 (enrolled), S2 (not) ──
  const lecturerA = await createUser(`quizA-${stamp}@innovision.test`);
  const lecturerB = await createUser(`quizB-${stamp}@innovision.test`);
  const studentS1 = await createUser(`quizS1-${stamp}@innovision.test`);
  await createUser(`quizS2-${stamp}@innovision.test`);
  await promoteLecturer(lecturerA.id);
  await promoteLecturer(lecturerB.id);

  const clientA = await asUser(`quizA-${stamp}@innovision.test`);
  const clientB = await asUser(`quizB-${stamp}@innovision.test`);
  const clientS1 = await asUser(`quizS1-${stamp}@innovision.test`);
  const clientS2 = await asUser(`quizS2-${stamp}@innovision.test`);

  // ── Lecturer A creates a class ───────────────────────────────
  const joinCode = makeJoinCode();
  const { data: clsA, error: createErr } = await clientA
    .from("classes")
    .insert({ title: "A's Quiz Class", lecturer_id: lecturerA.id, join_code: joinCode })
    .select("id, title, join_code")
    .single();
  createdClassId = clsA?.id ?? null;
  record("A creates own class", !createErr && clsA?.id, createErr?.message ?? "");

  // ── S1 enrolls via the join RPC (only enrollment path) ────────
  const { error: joinErr } = await clientS1.rpc("join_class", { code: joinCode });
  record("S1 joins class via RPC", !joinErr, joinErr?.message ?? "");

  // ── M-1: enrolled student cannot read join_code from `classes` ──
  // The classes SELECT policy is now owner-only; students read
  // student_class_view (id/title/created_at). Direct `classes` access must
  // yield 0 rows, and the view must NOT expose join_code.
  const { data: s1DirectClasses } = await clientS1
    .from("classes")
    .select("id, join_code")
    .eq("id", clsA.id);
  record("M-1 student direct classes read (join_code) denied", (s1DirectClasses ?? []).length === 0,
    `S1 sees ${(s1DirectClasses ?? []).length} direct class rows (expect 0)`);

  const { data: s1View } = await clientS1
    .from("student_class_view")
    .select("id, title, created_at")
    .eq("id", clsA.id);
  const viewOk =
    (s1View ?? []).length === 1 &&
    s1View[0].id === clsA.id &&
    !("join_code" in s1View[0]) &&
    !("lecturer_id" in s1View[0]);
  record("M-1 student view exposes id/title only (no join_code)", Boolean(viewOk),
    JSON.stringify(s1View ?? []));

  // ── D19: A creates a draft quiz ──────────────────────────────
  const { data: quiz1, error: quizErr } = await clientA
    .from("quizzes")
    .insert({
      class_id: clsA.id,
      created_by: lecturerA.id,
      title: "D19 Quiz",
      mode: "practice",
      status: "draft",
    })
    .select("id, title, status")
    .single();
  createdQuizIds.push(quiz1?.id);
  record("D19 A creates draft quiz", !quizErr && quiz1?.status === "draft", quizErr?.message ?? "");

  // ── D5: student sees 0 question rows before questions exist ──
  const { data: s1Questions0 } = await clientS1
    .from("questions")
    .select("*")
    .eq("quiz_id", quiz1.id);
  record("D5 student sees 0 question rows (empty quiz)", (s1Questions0 ?? []).length === 0);

  // ── D19: A adds 3 questions ──────────────────────────────────
  const questions = [
    { order_index: 0, type: "mcq", prompt: "Q1", options: ["a", "b"], correct_index: 0 },
    { order_index: 1, type: "mcq", prompt: "Q2", options: ["x", "y", "z"], correct_index: 2 },
    { order_index: 2, type: "true_false", prompt: "Q3", options: ["True", "False"], correct_index: 1 },
  ];
  const added = [];
  for (const q of questions) {
    const { data, error } = await clientA
      .from("questions")
      .insert({ quiz_id: quiz1.id, ...q })
      .select("id, order_index, correct_index")
      .single();
    assertNoError("insert question", { error });
    added.push(data);
  }
  record("D19 A adds 3 questions", added.length === 3, JSON.stringify(added.map((a) => a.order_index)));

  // ── D5: student reads questions → 0 rows (answer secrecy) ────
  const { data: s1Questions } = await clientS1
    .from("questions")
    .select("*")
    .eq("quiz_id", quiz1.id);
  record("D5 student SELECT questions → 0 rows", (s1Questions ?? []).length === 0,
    `S1 sees ${(s1Questions ?? []).length} (expect 0)`);

  // ── D6: owner reads questions → correct_index present ────────
  const { data: aQuestions, error: aQErr } = await clientA
    .from("questions")
    .select("id, correct_index")
    .eq("quiz_id", quiz1.id)
    .order("order_index");
  record("D6 owner reads questions with correct_index", !aQErr && (aQuestions ?? []).length === 3
    && aQuestions.every((q) => typeof q.correct_index === "number"),
    JSON.stringify(aQuestions ?? []));

  // ── D20: lecturer B cannot read A's quiz or questions ────────
  const { data: bQuiz } = await clientB.from("quizzes").select("id").eq("id", quiz1.id).maybeSingle();
  record("D20 lecturer B cannot read A's quiz", bQuiz === null);

  const { data: bQuestions } = await clientB.from("questions").select("*").eq("quiz_id", quiz1.id);
  record("D20 lecturer B cannot read A's questions", (bQuestions ?? []).length === 0);

  // ── D20: student/lecturer B cannot create a quiz in A's class ──
  const { error: s1Create } = await clientS1
    .from("quizzes")
    .insert({ class_id: clsA.id, created_by: studentS1.id, title: "Hacked", status: "draft" });
  record("D20 student cannot create quiz in A's class", Boolean(s1Create), s1Create?.message ?? "unexpectedly succeeded");

  const { error: bCreate } = await clientB
    .from("quizzes")
    .insert({ class_id: clsA.id, created_by: lecturerB.id, title: "Hacked", status: "draft" });
  record("D20 lecturer B cannot create quiz in A's class", Boolean(bCreate), bCreate?.message ?? "unexpectedly succeeded");

  // ── D19: reorder_questions RPC ───────────────────────────────
  const reversed = [...added].reverse().map((q) => q.id);
  const { error: reorderErr } = await clientA.rpc("reorder_questions", {
    p_quiz_id: quiz1.id,
    p_ordered_ids: reversed,
  });
  record("D19 reorder_questions succeeds", !reorderErr, reorderErr?.message ?? "");

  const { data: reordered } = await clientA
    .from("questions")
    .select("id, order_index")
    .eq("quiz_id", quiz1.id)
    .order("order_index");
  const reorderOk =
    reordered?.length === 3 &&
    reordered[0].id === reversed[0] &&
    reordered[2].id === reversed[2];
  record("D19 reorder renumbers correctly", Boolean(reorderOk), JSON.stringify(reordered ?? []));

  // ── D32: concurrent append_question serializes order_index ──
  // The advisory lock must ensure N concurrent appends to the same draft quiz
  // produce exactly 0..N-1 with no duplicates. Fire them in parallel through
  // the security-definer RPC (the real path the route uses).
  const { data: concQ } = await clientA
    .from("quizzes")
    .insert({ class_id: clsA.id, created_by: lecturerA.id, title: "Concurrent", status: "draft" })
    .select("id")
    .single();
  createdQuizIds.push(concQ?.id);
  const CONCURRENT = 8;
  const appendResults = await Promise.all(
    Array.from({ length: CONCURRENT }, (_, i) =>
      clientA.rpc("append_question", {
        p_quiz_id: concQ.id,
        p_type: "mcq",
        p_prompt: `Concurrent Q${i}`,
        p_options: ["a", "b"],
        p_correct_index: 0,
        p_explanation: "",
      }),
    ),
  );
  const appendErrors = appendResults.filter((r) => r.error);
  const { data: concQuestions } = await clientA
    .from("questions")
    .select("order_index")
    .eq("quiz_id", concQ.id);
  const indexes = (concQuestions ?? []).map((q) => q.order_index).sort((a, b) => a - b);
  const unique = new Set(indexes);
  record("D32 concurrent append_question → unique order_index 0..N-1",
    appendErrors.length === 0 &&
      indexes.length === CONCURRENT &&
      unique.size === CONCURRENT &&
      indexes[0] === 0 &&
      indexes[indexes.length - 1] === CONCURRENT - 1,
    `errors=${appendErrors.length} indexes=${JSON.stringify(indexes)}`);

  // ── D33: DB length/distinctness backstops (defense-in-depth) ──
  // The triggers must reject out-of-range data even via direct SQL (a non-Zod
  // path like P4 AI generation reaching the DB directly). Use a fresh draft
  // quiz so the draft-only trigger doesn't interfere.
  const { data: backstopQ } = await clientA
    .from("quizzes")
    .insert({ class_id: clsA.id, created_by: lecturerA.id, title: "Backstop", status: "draft" })
    .select("id")
    .single();
  createdQuizIds.push(backstopQ?.id);

  const tooLongOption = "x".repeat(501);
  const { error: optTooLongErr } = await clientA
    .from("questions")
    .insert({ quiz_id: backstopQ.id, order_index: 0, type: "mcq", prompt: "long option", options: [tooLongOption, "b"], correct_index: 0 });
  record("D33 option > 500 chars → trigger error", Boolean(optTooLongErr), optTooLongErr?.message ?? "unexpectedly inserted");

  const { error: explTooLongErr } = await clientA
    .from("questions")
    .insert({ quiz_id: backstopQ.id, order_index: 1, type: "mcq", prompt: "long explanation", options: ["a", "b"], correct_index: 0, explanation: "y".repeat(2001) });
  record("D33 explanation > 2000 chars → trigger error", Boolean(explTooLongErr), explTooLongErr?.message ?? "unexpectedly inserted");

  const { error: dupOptionErr } = await clientA
    .from("questions")
    .insert({ quiz_id: backstopQ.id, order_index: 2, type: "mcq", prompt: "dup", options: ["Yes", "yes"], correct_index: 0 });
  record("D33 case-insensitive duplicate options → trigger error", Boolean(dupOptionErr), dupOptionErr?.message ?? "unexpectedly inserted");

  const { error: dupTrimErr } = await clientA
    .from("questions")
    .insert({ quiz_id: backstopQ.id, order_index: 3, type: "mcq", prompt: "dup trim", options: ["  a  ", "a"], correct_index: 0 });
  record("D33 whitespace-duplicate options → trigger error", Boolean(dupTrimErr), dupTrimErr?.message ?? "unexpectedly inserted");

  const { error: emptyOptErr } = await clientA
    .from("questions")
    .insert({ quiz_id: backstopQ.id, order_index: 4, type: "mcq", prompt: "empty", options: ["", "b"], correct_index: 0 });
  record("D33 empty-after-trim option → trigger error", Boolean(emptyOptErr), emptyOptErr?.message ?? "unexpectedly inserted");

  // Sanity: a valid insert on the same backstop quiz still succeeds.
  const { error: validBackstopErr } = await clientA
    .from("questions")
    .insert({ quiz_id: backstopQ.id, order_index: 5, type: "true_false", prompt: "ok", options: ["True", "False"], correct_index: 0 });
  record("D33 valid question still inserts on backstop quiz", !validBackstopErr, validBackstopErr?.message ?? "");

  // ── D21: publishing an empty quiz → trigger error ────────────
  const { data: emptyQuiz } = await clientA
    .from("quizzes")
    .insert({ class_id: clsA.id, created_by: lecturerA.id, title: "Empty", status: "draft" })
    .select("id")
    .single();
  createdQuizIds.push(emptyQuiz?.id);
  const { error: publishEmptyErr } = await clientA
    .from("quizzes")
    .update({ status: "live" })
    .eq("id", emptyQuiz.id);
  record("D21 publishing empty quiz → trigger error", Boolean(publishEmptyErr),
    publishEmptyErr?.message ?? "unexpectedly published");

  // ── D19: publish the real quiz → live ────────────────────────
  const { data: published, error: publishErr } = await clientA
    .from("quizzes")
    .update({ status: "live" })
    .eq("id", quiz1.id)
    .select("id, status")
    .single();
  record("D19 publish quiz → live", !publishErr && published?.status === "live", publishErr?.message ?? "");

  // ── D5 (post-publish): student still sees 0 question rows ────
  // The strongest answer-secrecy assertion: even with the quiz LIVE, the
  // student's SELECT on questions must return 0 rows (no read policy at all).
  const { data: s1PostLive } = await clientS1
    .from("questions")
    .select("*")
    .eq("quiz_id", quiz1.id);
  record("D5 student SELECT questions → 0 rows even after publish", (s1PostLive ?? []).length === 0,
    `S1 sees ${(s1PostLive ?? []).length} after publish (expect 0)`);

  // ── D22: after publish, question INSERT/UPDATE/DELETE blocked ──
  const { error: insErr } = await clientA
    .from("questions")
    .insert({ quiz_id: quiz1.id, order_index: 9, type: "mcq", prompt: "Late", options: ["a", "b"], correct_index: 0 });
  record("D22 question INSERT after publish → trigger error", Boolean(insErr), insErr?.message ?? "unexpectedly inserted");

  const { error: updErr } = await clientA
    .from("questions")
    .update({ prompt: "Edited" })
    .eq("id", added[0].id);
  record("D22 question UPDATE after publish → trigger error", Boolean(updErr), updErr?.message ?? "unexpectedly updated");

  const { error: delErr } = await clientA
    .from("questions")
    .delete()
    .eq("id", added[0].id);
  record("D22 question DELETE after publish → trigger error", Boolean(delErr), delErr?.message ?? "unexpectedly deleted");

  // ── D24: re-open transitions blocked ─────────────────────────
  // NOTE: D23 (student visibility) runs FIRST while the quiz is still live —
  // the state-machine tests below close it.

  // ── D23: enrolled student sees live quiz, not draft quiz ─────
  // Students read quizzes via student_quiz_view (MED-1) — the `quizzes` table
  // is owner-only now, so a direct student read must return 0 rows.
  const { data: s1DirectQuiz } = await clientS1.from("quizzes").select("id").eq("id", quiz1.id);
  record("D23 student direct quizzes read denied (MED-1)", (s1DirectQuiz ?? []).length === 0,
    `S1 sees ${(s1DirectQuiz ?? []).length} direct quiz rows (expect 0)`);

  const { data: s1ViewQuiz } = await clientS1
    .from("student_quiz_view")
    .select("id, title, mode, status, time_limit_sec, class_id, created_at")
    .eq("id", quiz1.id);
  const s1ViewQuizOk =
    (s1ViewQuiz ?? []).length === 1 &&
    !("source_file_url" in s1ViewQuiz[0]) &&
    !("created_by" in s1ViewQuiz[0]);
  record("D23 enrolled student sees live quiz via view (no source_file_url/created_by)",
    Boolean(s1ViewQuizOk), JSON.stringify(s1ViewQuiz ?? []));

  const { data: s1Draft } = await clientS1
    .from("student_quiz_view")
    .select("id")
    .eq("id", emptyQuiz.id);
  record("D23 enrolled student does NOT see draft quiz", (s1Draft ?? []).length === 0);

  const { data: s2View } = await clientS2
    .from("student_quiz_view")
    .select("id")
    .eq("id", quiz1.id);
  record("D23 unenrolled student sees nothing via view", (s2View ?? []).length === 0);

  // ── MED-2: cannot insert a live/closed quiz via direct SQL ──
  const { error: insertLiveErr } = await clientA
    .from("quizzes")
    .insert({ class_id: clsA.id, created_by: lecturerA.id, title: "Live Hack", status: "live" });
  record("MED-2 insert with status=live → trigger error", Boolean(insertLiveErr),
    insertLiveErr?.message ?? "unexpectedly inserted live quiz");

  // ── MED-3: lecturer cannot read student face enrollment status ──
  // (Round-2/CompreFace: `face_embedding` was dropped; the sensitive marker is
  // now `face_enrollment_status`. The roster view replaced the broad profiles
  // policy; direct profiles SELECT is self-only, so a lecturer sees 0 rows.)
  const { data: aProfileRead } = await clientA
    .from("profiles")
    .select("id, full_name, face_enrollment_status")
    .eq("id", studentS1.id);
  record("MED-3 lecturer cannot read student profile/enrollment-status", (aProfileRead ?? []).length === 0,
    `A sees ${(aProfileRead ?? []).length} profile rows (expect 0)`);

  const { data: aRoster } = await clientA
    .from("student_roster_view")
    .select("student_id, full_name")
    .eq("class_id", clsA.id);
  record("MED-3 lecturer roster view shows names only", (aRoster ?? []).some((r) => r.student_id === studentS1.id)
    && !("face_enrollment_status" in (aRoster?.[0] ?? {})),
    JSON.stringify(aRoster ?? []));

  const { error: liveToDraftErr } = await clientA
    .from("quizzes")
    .update({ status: "draft" })
    .eq("id", quiz1.id);
  record("D24 live→draft → trigger error", Boolean(liveToDraftErr), liveToDraftErr?.message ?? "unexpectedly reopened");

  const { data: closedQuiz, error: closeErr } = await clientA
    .from("quizzes")
    .update({ status: "closed" })
    .eq("id", quiz1.id)
    .select("id, status")
    .single();
  record("D19/D24 live→closed allowed", !closeErr && closedQuiz?.status === "closed", closeErr?.message ?? "");

  const { error: closedToLiveErr } = await clientA
    .from("quizzes")
    .update({ status: "live" })
    .eq("id", quiz1.id);
  record("D24 closed→live → trigger error", Boolean(closedToLiveErr), closedToLiveErr?.message ?? "unexpectedly reopened");

  // ── HIGH-1 (round-2): question cannot be moved off a live quiz ──
  // quiz1 is closed at this point; move-check uses a fresh live quiz.
  const { data: liveQ } = await clientA
    .from("quizzes")
    .insert({ class_id: clsA.id, created_by: lecturerA.id, title: "Move Target", status: "draft" })
    .select("id")
    .single();
  const { data: draftQ } = await clientA
    .from("quizzes")
    .insert({ class_id: clsA.id, created_by: lecturerA.id, title: "Move Source", status: "draft" })
    .select("id")
    .single();
  createdQuizIds.push(liveQ?.id, draftQ?.id);
  // Add the question FIRST (empty publish is blocked), then publish live.
  const { data: mvQ } = await clientA
    .from("questions")
    .insert({ quiz_id: liveQ.id, order_index: 0, type: "mcq", prompt: "move me", options: ["a", "b"], correct_index: 0 })
    .select("id")
    .single();
  const { error: pubLiveErr } = await clientA
    .from("quizzes")
    .update({ status: "live" })
    .eq("id", liveQ.id);
  assertNoError("publish move-target quiz", { error: pubLiveErr });
  const { error: moveErr } = await clientA
    .from("questions")
    .update({ quiz_id: draftQ.id })
    .eq("id", mvQ.id);
  record("HIGH-1 moving question off live quiz → trigger error", Boolean(moveErr),
    moveErr?.message ?? "unexpectedly moved question off live quiz");

  // ── MED-4 (round-3): metadata edit-lock on live/closed quizzes ──
  // A live quiz's title/mode/time_limit must be immutable even via direct SQL
  // (route enforces draft-only; the DB trigger is the backstop).
  const { error: metaEditErr } = await clientA
    .from("quizzes")
    .update({ title: "Tampered" })
    .eq("id", liveQ.id);
  record("MED-4 editing live quiz metadata → trigger error", Boolean(metaEditErr),
    metaEditErr?.message ?? "unexpectedly edited live quiz metadata");

  const { error: modeEditErr } = await clientA
    .from("quizzes")
    .update({ mode: "assessment" })
    .eq("id", liveQ.id);
  record("MED-4b editing live quiz mode → trigger error", Boolean(modeEditErr),
    modeEditErr?.message ?? "unexpectedly edited live quiz mode");

  const { error: timeEditErr } = await clientA
    .from("quizzes")
    .update({ time_limit_sec: 3600 })
    .eq("id", liveQ.id);
  record("MED-4b editing live quiz time_limit_sec → trigger error", Boolean(timeEditErr),
    timeEditErr?.message ?? "unexpectedly edited live quiz time limit");

  // ── D26: quizzes_practice_untimed CHECK constraint (INSERT) ──
  const { error: insertPracticeTimedErr } = await clientA
    .from("quizzes")
    .insert({
      class_id: clsA.id,
      created_by: lecturerA.id,
      title: "Illegal Practice Timed",
      mode: "practice",
      time_limit_sec: 600,
      status: "draft",
    });
  record("D26 INSERT practice with time_limit_sec violates CHECK", Boolean(insertPracticeTimedErr),
    insertPracticeTimedErr?.message ?? "unexpectedly allowed practice quiz with time_limit_sec");

  // ── D27: quizzes_practice_untimed CHECK constraint (UPDATE) ──
  const { error: updatePracticeTimedErr } = await clientA
    .from("quizzes")
    .update({ mode: "practice", time_limit_sec: 1200 })
    .eq("id", draftQ.id);
  record("D27 UPDATE draft to practice with time_limit_sec violates CHECK", Boolean(updatePracticeTimedErr),
    updatePracticeTimedErr?.message ?? "unexpectedly updated practice quiz with time_limit_sec");

  // ── D28: quizzes_time_limit_sec_check (bounds 1..7200) ──
  const { error: insertOverMaxTimeErr } = await clientA
    .from("quizzes")
    .insert({
      class_id: clsA.id,
      created_by: lecturerA.id,
      title: "Illegal Over-Max Timed",
      mode: "assessment",
      time_limit_sec: 7201,
      status: "draft",
    });
  record("D28 INSERT assessment with time_limit_sec > 7200 violates CHECK", Boolean(insertOverMaxTimeErr),
    insertOverMaxTimeErr?.message ?? "unexpectedly allowed assessment quiz with time_limit_sec > 7200");

  const { error: insertZeroTimeErr } = await clientA
    .from("quizzes")
    .insert({
      class_id: clsA.id,
      created_by: lecturerA.id,
      title: "Illegal Zero Timed",
      mode: "assessment",
      time_limit_sec: 0,
      status: "draft",
    });
  record("D28b INSERT assessment with time_limit_sec = 0 violates CHECK", Boolean(insertZeroTimeErr),
    insertZeroTimeErr?.message ?? "unexpectedly allowed assessment quiz with time_limit_sec = 0");

  // ── MED-4c: metadata edit-lock on CLOSED quizzes ──────────────
  const { error: closedMetaEditErr } = await clientA
    .from("quizzes")
    .update({ title: "Tampered Closed Title" })
    .eq("id", quiz1.id); // quiz1 was closed at line 444
  record("MED-4c editing closed quiz metadata → trigger error", Boolean(closedMetaEditErr),
    closedMetaEditErr?.message ?? "unexpectedly edited closed quiz metadata");

  // ── D28c/D28d: Valid min (1s) and max (7200s) bounds succeed on DB INSERT ──
  const { data: minTimedQ, error: minTimedErr } = await clientA
    .from("quizzes")
    .insert({
      class_id: clsA.id,
      created_by: lecturerA.id,
      title: "Valid Min Timed (1s)",
      mode: "assessment",
      time_limit_sec: 1,
      status: "draft",
    })
    .select("id, time_limit_sec")
    .single();
  createdQuizIds.push(minTimedQ?.id);
  record("D28c INSERT assessment with time_limit_sec = 1 succeeds", !minTimedErr && minTimedQ?.time_limit_sec === 1,
    minTimedErr?.message ?? "");

  const { data: maxTimedQ, error: maxTimedErr } = await clientA
    .from("quizzes")
    .insert({
      class_id: clsA.id,
      created_by: lecturerA.id,
      title: "Valid Max Timed (7200s)",
      mode: "assessment",
      time_limit_sec: 7200,
      status: "draft",
    })
    .select("id, time_limit_sec")
    .single();
  createdQuizIds.push(maxTimedQ?.id);
  record("D28d INSERT assessment with time_limit_sec = 7200 succeeds", !maxTimedErr && maxTimedQ?.time_limit_sec === 7200,
    maxTimedErr?.message ?? "");

  // ── D25 (H1 regression): deleting a quiz WITH questions succeeds ──
  // Regression for the cascade-delete trigger bug: questions_draft_only used to
  // raise "quiz_not_found" during ON DELETE CASCADE because the parent quiz is
  // already gone when the child trigger fires. A quiz with questions must be
  // deletable; a class containing one must be deletable too.
  const { data: delQuiz, error: delQuizErr } = await clientA
    .from("quizzes")
    .delete()
    .eq("id", quiz1.id)
    .select("id");
  record("D25 delete quiz with questions succeeds", !delQuizErr && delQuiz?.length === 1,
    delQuizErr?.message ?? `deleted ${delQuiz?.length ?? 0}`);

  const { data: delClass, error: delClassErr } = await clientA
    .from("classes")
    .delete()
    .eq("id", clsA.id)
    .select("id");
  record("D25 delete class with quizzes/questions succeeds", !delClassErr && delClass?.length === 1,
    delClassErr?.message ?? `deleted ${delClass?.length ?? 0}`);

  // ── Summary ──────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} checks passed`);
  return passed === results.length ? 0 : 1;
}

async function cleanup() {
  try {
    for (const qid of createdQuizIds) {
      if (qid) await admin.from("quizzes").delete().eq("id", qid);
    }
    if (createdClassId) {
      await admin.from("classes").delete().eq("id", createdClassId);
    }
    for (const uid of createdUsers) {
      await admin.auth.admin.deleteUser(uid);
    }
  } catch (err) {
    console.warn("Cleanup warning:", err.message);
  }
}

main()
  .then(async (code) => {
    await cleanup();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("Fatal:", err);
    await cleanup();
    process.exit(1);
  });
