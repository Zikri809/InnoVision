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
import { assertLocalTarget } from "./lib/target-guard.mjs";

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

assertLocalTarget(URL, "verify-quizzes.mjs");

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const results = [];
const createdUsers = [];
let createdClassId = null;
const touchedClassIds = [];
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
  touchedClassIds.push(clsA?.id);
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

  // ── QC-1/QC-3 (migration 0030): lifecycle + window probes ────────────────
  // Windows are live-editable: the edit-freeze deliberately excludes them.
  const { data: windowSet, error: windowSetErr } = await clientA
    .from("quizzes")
    .update({
      opens_at: "2026-01-01T00:00:00Z",
      closes_at: "2026-01-02T00:00:00Z",
    })
    .eq("id", liveQ.id)
    .select("opens_at, closes_at")
    .single();
  record("QC-3 window update on LIVE quiz succeeds (not edit-locked)",
    !windowSetErr && windowSet?.opens_at != null && windowSet?.closes_at != null,
    windowSetErr?.message ?? "");

  const { error: invertedWindowErr } = await clientA
    .from("quizzes")
    .update({
      opens_at: "2026-01-02T00:00:00Z",
      closes_at: "2026-01-01T00:00:00Z",
    })
    .eq("id", liveQ.id);
  record("QC-3 inverted window (closes_at <= opens_at) violates CHECK", Boolean(invertedWindowErr),
    invertedWindowErr?.message ?? "unexpectedly accepted inverted window");

  const { error: equalWindowErr } = await clientA
    .from("quizzes")
    .update({
      opens_at: "2026-01-01T00:00:00Z",
      closes_at: "2026-01-01T00:00:00Z",
    })
    .eq("id", liveQ.id);
  record("QC-3 equal instants violate CHECK (strictly after)", Boolean(equalWindowErr),
    equalWindowErr?.message ?? "unexpectedly accepted equal window instants");

  const { data: singleEnded, error: singleEndedErr } = await clientA
    .from("quizzes")
    .update({ opens_at: "2026-01-01T00:00:00Z", closes_at: null })
    .eq("id", liveQ.id)
    .select("opens_at, closes_at")
    .single();
  record("QC-3 single-ended window accepted (one NULL is valid)",
    !singleEndedErr && singleEnded?.opens_at != null && singleEnded?.closes_at === null,
    singleEndedErr?.message ?? "");

  // Start gating: window in the future → quiz_not_open (S1 is enrolled).
  const { data: futureQ, error: futureQErr } = await clientA
    .from("quizzes")
    .insert({
      class_id: clsA.id,
      created_by: lecturerA.id,
      title: "QC-3 Future Window",
      mode: "practice",
      status: "draft",
    })
    .select("id")
    .single();
  createdQuizIds.push(futureQErr ? null : futureQ?.id);
  await clientA.from("questions").insert({
    quiz_id: futureQ.id, order_index: 0, type: "mcq", prompt: "q?", options: ["a","b"], correct_index: 0,
  });
  const { error: publishFutureErr } = await clientA
    .from("quizzes")
    .update({ status: "live" })
    .eq("id", futureQ.id);
  assertNoError("publish future-window quiz", { error: publishFutureErr });
  await admin
    .from("quizzes")
    .update({ opens_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() })
    .eq("id", futureQ.id);
  const { data: notOpenRes } = await clientS1.rpc("start_quiz_session", { p_quiz_id: futureQ.id });
  record("QC-3 start before opens_at → quiz_not_open",
    notOpenRes?.error === "quiz_not_open", JSON.stringify(notOpenRes ?? {}));

  // Ordering probe: an UNENROLLED caller against a windowed quiz must fold
  // to the identity 404 (not_enrolled), never leak window state.
  const { data: unenrolledRes } = await clientS2.rpc("start_quiz_session", {
    p_quiz_id: futureQ.id,
  });
  record("QC-3 unenrolled caller vs windowed quiz folds to not_enrolled (no window oracle)",
    unenrolledRes?.error === "not_enrolled", JSON.stringify(unenrolledRes ?? {}));

  // Window closed: past closes_at → quiz_window_closed. (Set a PAST closes_at
  // on the future-window quiz — relative instants, since Postgres now() is
  // transaction-stamped and unpinnable.)
  await admin
    .from("quizzes")
    .update({ opens_at: null, closes_at: new Date(Date.now() - 60 * 1000).toISOString() })
    .eq("id", futureQ.id);
  const { data: closedWindowRes } = await clientS1.rpc("start_quiz_session", {
    p_quiz_id: futureQ.id,
  });
  record("QC-3 start after closes_at → quiz_window_closed",
    closedWindowRes?.error === "quiz_window_closed", JSON.stringify(closedWindowRes ?? {}));
  await admin.from("quizzes").update({ opens_at: null, closes_at: null }).eq("id", futureQ.id);

  // NULL window never blocks (clear the window; start succeeds + practice row).
  await admin.from("quizzes").update({ opens_at: null, closes_at: null }).eq("id", futureQ.id);
  const { data: openRes } = await clientS1.rpc("start_quiz_session", { p_quiz_id: futureQ.id });
  record("QC-3 NULL window start succeeds (unbounded)", Boolean(openRes?.session), JSON.stringify(openRes ?? {}));

  // QC-2 setup: S1 completes a practice attempt on futureQ NOW (while it is
  // still live + windowless) so student_results has a completed session to
  // report on once the quiz is closed+revealed below.
  const { data: qc2Session, error: qc2SubmitErr } = await clientS1.rpc("submit_session", {
    p_session_id: openRes.session.id,
  });
  record("QC-2 submit attempt on futureQ succeeds",
    !qc2SubmitErr && qc2Session?.session?.status === "completed",
    qc2SubmitErr?.message ?? JSON.stringify(qc2Session ?? {}));

  // CAS race (fake-supabase cannot emulate): guarded close from clientA while
  // the quiz is already closed → 0 rows updated, no exception.
  const { data: casLoser, error: casErr } = await clientA
    .from("quizzes")
    .update({ status: "closed" })
    .eq("id", quiz1.id)
    .eq("status", "live")
    .select("id");
  record("QC-1 CAS close on already-closed quiz → 0 rows, no error",
    !casErr && (casLoser ?? []).length === 0, casErr?.message ?? `rows: ${(casLoser ?? []).length}`);

  // Belt-and-braces: the ROUTE's exact windows-PATCH payload on a live
  // practice quiz carries time_limit_sec=null (buildQuizUpdates invariant
  // wipe). The edit-freeze must not raise — `NULL is distinct from NULL` is
  // false, and 0014 guarantees OLD.time_limit_sec is NULL for practice rows.
  const { error: threeColErr } = await clientA
    .from("quizzes")
    .update({ opens_at: "2026-01-01T00:00:00Z", closes_at: "2026-01-02T00:00:00Z", time_limit_sec: null })
    .eq("id", liveQ.id);
  record("QC-3 route-payload windows+time_limit_sec=null on live practice quiz → no edit-lock raise",
    !threeColErr, threeColErr?.message ?? "unexpectedly rejected");

  // Autoclose: a live quiz past closes_at flips to closed; NULL-window and
  // draft/closed rows are untouched. Idempotent on re-run.
  await admin.from("quizzes").update({ status: "live", opens_at: null, closes_at: null }).eq("id", futureQ.id);
  await admin
    .from("quizzes")
    .update({ closes_at: new Date(Date.now() - 60 * 1000).toISOString() })
    .eq("id", futureQ.id);
  const { data: closedCount1 } = await admin.rpc("quiz_autoclose");
  const { data: futureAfter } = await admin
    .from("quizzes")
    .select("status")
    .eq("id", futureQ.id)
    .single();
  record("QC-3 quiz_autoclose flips live past-closes_at quiz → closed",
    futureAfter?.status === "closed" && typeof closedCount1 === "number", JSON.stringify({ closedCount1, futureAfter }));
  const { data: futureAfter2 } = await admin
    .from("quizzes")
    .select("status")
    .eq("id", futureQ.id)
    .single();
  const { data: closedCount2 } = await admin.rpc("quiz_autoclose");
  record("QC-3 quiz_autoclose is idempotent (second run flips nothing)",
    futureAfter2?.status === "closed", JSON.stringify({ futureAfter2, closedCount2 }));

  // quiz_closed notification: exactly one per (student, quiz) after all flips.
  const { data: notifAfter } = await admin
    .from("notifications")
    .select("id, recipient_id")
    .eq("dedupe_key", `quiz_closed:${futureQ.id}`);
  record("QC-1 notify_quiz_closed fires once per student for the autoclosed quiz",
    (notifAfter ?? []).length >= 1, JSON.stringify(notifAfter ?? []));

  // ── QC-2: closed+revealed recovery surface (migration 0031) ─────────────
  // futureQ is closed + windowless here (S1's completed practice attempt was
  // submitted above, pre-close). Reveal it as the owner, then assert:
  // live-only view excludes it, closed-revealed view exposes it for the
  // ENROLLED student only, and archived/unrevealed states stay opaque.
  const { error: qc2RevealErr } = await admin
    .from("quizzes")
    .update({ results_revealed_at: new Date().toISOString() })
    .eq("id", futureQ.id)
    .is("results_revealed_at", null);
  assertNoError("QC-2 reveal a closed quiz", { error: qc2RevealErr });
  const { data: qc2LiveView } = await clientS1
    .from("student_quiz_view")
    .select("id")
    .eq("id", futureQ.id);
  record("QC-2 closed+revealed quiz NOT in student_quiz_view (per-surface visibility)",
    (qc2LiveView ?? []).length === 0, JSON.stringify(qc2LiveView ?? []));
  const { data: qc2ClosedView } = await clientS1
    .from("student_closed_revealed_quiz_view")
    .select("id, title, results_revealed_at")
    .eq("id", futureQ.id);
  record("QC-2 closed+revealed quiz IS in the closed-revealed view (enrolled student)",
    (qc2ClosedView ?? []).length === 1, JSON.stringify(qc2ClosedView ?? []));
  const { data: qc2UnenrolledView } = await clientS2
    .from("student_closed_revealed_quiz_view")
    .select("id")
    .eq("id", futureQ.id);
  record("QC-2 unenrolled student sees nothing in the closed-revealed view",
    (qc2UnenrolledView ?? []).length === 0, JSON.stringify(qc2UnenrolledView ?? {}));
  const { data: qc2Results } = await clientS1.rpc("student_results", { p_quiz_id: futureQ.id });
  record("QC-2 student_results works for closed+revealed (no status term)",
    qc2Results != null && qc2Results.error === undefined && Array.isArray(qc2Results.questions),
    JSON.stringify(qc2Results ?? {}));

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

  // ── QT3-D*: per-student shuffle flag (migration 0034) ────────────────
  // Fresh class/quiz: the D25 block above deleted clsA. The flag is draft-
  // frozen (joins title/mode in quiz_not_draft_edit) and exposed to students
  // ONLY via the two quiz-metadata barrier views.
  const joinCode3 = makeJoinCode();
  const { data: clsQ3, error: clsQ3Err } = await clientA
    .from("classes")
    .insert({ title: "QT3 Shuffle Class", lecturer_id: lecturerA.id, join_code: joinCode3 })
    .select("id, join_code")
    .single();
  createdClassId = clsQ3?.id ?? createdClassId;
  touchedClassIds.push(clsQ3?.id);
  assertNoError("QT3 create class", { error: clsQ3Err });
  const { error: joinErr3 } = await clientS1.rpc("join_class", { code: joinCode3 });
  assertNoError("QT3 S1 joins QT3 class", { error: joinErr3 });

  const { data: q3, error: q3Err } = await clientA
    .from("quizzes")
    .insert({ class_id: clsQ3.id, created_by: lecturerA.id, title: "QT3 Quiz", mode: "practice", status: "draft" })
    .select("id, shuffle_questions")
    .single();
  createdQuizIds.push(q3?.id);
  assertNoError("QT3 create quiz", { error: q3Err });
  record("QT3-D1 new quiz defaults shuffle_questions to false", q3?.shuffle_questions === false,
    `value: ${q3?.shuffle_questions}`);

  const { data: q3Flip, error: q3FlipErr } = await clientA
    .from("quizzes")
    .update({ shuffle_questions: true })
    .eq("id", q3.id)
    .select("shuffle_questions")
    .single();
  record("QT3-D2 draft quiz flip allowed", !q3FlipErr && q3Flip?.shuffle_questions === true,
    q3FlipErr?.message ?? "");

  const { error: q3QuestionErr } = await clientA.from("questions").insert({
    quiz_id: q3.id,
    type: "mcq",
    prompt: "QT3 probe question",
    options: ["1", "2", "3", "4"],
    correct_index: 0,
    order_index: 0,
  });
  assertNoError("QT3 add question", { error: q3QuestionErr });
  const { error: q3LiveErr } = await clientA.from("quizzes").update({ status: "live" }).eq("id", q3.id);
  assertNoError("QT3 publish quiz", { error: q3LiveErr });

  const { error: q3LiveFlipErr } = await clientA
    .from("quizzes")
    .update({ shuffle_questions: false })
    .eq("id", q3.id);
  record("QT3-D3 flip on live quiz → quiz_not_draft_edit trigger error", Boolean(q3LiveFlipErr),
    q3LiveFlipErr?.message ?? "unexpectedly flipped shuffle on a live quiz");

  const { data: q3S1View } = await clientS1
    .from("student_quiz_view")
    .select("id, shuffle_questions")
    .eq("id", q3.id);
  record("QT3-D4 student sees shuffle_questions via student_quiz_view",
    (q3S1View ?? []).length === 1 && q3S1View[0].shuffle_questions === true,
    JSON.stringify(q3S1View ?? []));

  const { error: q3CloseErr } = await clientA.from("quizzes").update({ status: "closed" }).eq("id", q3.id);
  assertNoError("QT3 close quiz", { error: q3CloseErr });

  const { data: q3S1Closed } = await clientS1
    .from("student_closed_revealed_quiz_view")
    .select("id, shuffle_questions")
    .eq("id", q3.id);
  record("QT3-D5 student sees shuffle_questions via student_closed_revealed_quiz_view (practice always reveal-allowed)",
    (q3S1Closed ?? []).length === 1 && q3S1Closed[0].shuffle_questions === true,
    JSON.stringify(q3S1Closed ?? []));

  const { data: q3S1Direct } = await clientS1.from("quizzes").select("id, shuffle_questions").eq("id", q3.id);
  record("QT3-D6 student direct quizzes read still denied (RLS unchanged)",
    (q3S1Direct ?? []).length === 0, `S1 sees ${(q3S1Direct ?? []).length} rows (expect 0)`);

  // ── QT1: multi-select authoring + guard trigger (0036/0037) ─────
  {
    // Fresh class (QT3 precedent): earlier probes may have consumed clsA's
    // state; the authoring probes only need an owned draft quiz.
    const qtJoin = makeJoinCode();
    const { data: clsQt, error: clsQtErr } = await clientA
      .from("classes")
      .insert({ title: "QT1 Class", lecturer_id: lecturerA.id, join_code: qtJoin })
      .select("id")
      .single();
    assertNoError("create QT1 class", { error: clsQtErr });
    touchedClassIds.push(clsQt.id);
    const { data: qtQuiz, error: qtQuizErr } = await clientA
      .from("quizzes")
      .insert({ class_id: clsQt.id, created_by: lecturerA.id, title: "QT1 Authoring", status: "draft", mode: "practice" })
      .select("id")
      .single();
    assertNoError("create QT1 quiz", { error: qtQuizErr });
    createdQuizIds.push(qtQuiz.id);

    // QT1-D2: append_question carries the sorted set; the scalar is nulled.
    const { data: multiQ, error: multiErr } = await clientA.rpc("append_question", {
      p_quiz_id: qtQuiz.id,
      p_type: "multi_select",
      p_prompt: "Which are prime?",
      p_options: ["2", "3", "4", "5"],
      p_correct_index: null,
      p_correct_indices: [3, 1, 0],
      p_explanation: "",
    });
    const stored = multiQ
      ? await admin.from("questions").select("correct_index, correct_indices").eq("id", multiQ.id).single()
      : { data: null };
    record("QT1-D2 append_question stores the NORMALIZED set (sorted) and nulls the scalar",
      !multiErr && stored.data?.correct_index === null &&
        JSON.stringify(stored.data?.correct_indices) === JSON.stringify([0, 1, 3]),
      `${multiErr?.message ?? ""} row=${JSON.stringify(stored.data)}`);

    // QT1-D1: the guard trigger rejects every invalid key shape.
    const rejectCase = async (name, options, correctIndex, correctIndices) => {
      const { error } = await clientA.rpc("append_question", {
        p_quiz_id: qtQuiz.id,
        p_type: "multi_select",
        p_prompt: `invalid: ${name}`,
        p_options: options,
        p_correct_index: correctIndex,
        p_correct_indices: correctIndices,
        p_explanation: "",
      });
      record(`QT1-D1 ${name} → invalid_correct_indices`,
        Boolean(error) && error.message.includes("invalid_correct_indices"),
        error?.message ?? "unexpectedly accepted");
    };
    // Duplicate / unsorted RPC input is NORMALIZED to the canonical form
    // (same posture as save_quiz_questions), not rejected.
    const { data: normQ, error: normErr } = await clientA.rpc("append_question", {
      p_quiz_id: qtQuiz.id,
      p_type: "multi_select",
      p_prompt: "normalization case",
      p_options: ["a", "b", "c"],
      p_correct_index: null,
      p_correct_indices: [2, 0, 2],
      p_explanation: "",
    });
    // QT1-D2c: a JSON-null `correct_indices` key (what a naive route payload
    // emits — jsonb null is NOT SQL null) must NOT reject a scalar row; the
    // RPC treats jsonb null as absent (0037 hardening). This pins the bulk
    // import path against the fake-supabase blind spot (QT-1 audit B1).
    {
      const { error: nullKeyErr } = await clientA.rpc("save_quiz_questions", {
        p_quiz_id: qtQuiz.id,
        p_title: null,
        p_source_file_url: null,
        p_source_text: null,
        p_mode: "append",
        p_questions: [
          { type: "mcq", prompt: "JSON-null key row", options: ["a", "b"], correct_index: 1, correct_indices: null },
        ],
      });
      const storedRow = await admin
        .from("questions")
        .select("correct_index, correct_indices")
        .eq("quiz_id", qtQuiz.id)
        .order("created_at", { ascending: false })
        .limit(1);
      record("QT1-D2c save_quiz_questions treats a JSON-null correct_indices key as absent",
        !nullKeyErr &&
          storedRow.data?.[0]?.correct_index === 1 &&
          storedRow.data?.[0]?.correct_indices === null,
        `${nullKeyErr?.message ?? ""} row=${JSON.stringify(storedRow.data?.[0])}`);

      // QT1-D2d: the MULTI happy path through save_quiz_questions (bulk
      // import + opt-in AI write here) — a jsonb-string element and a JSON
      // null element must both reject cleanly, and a valid multi row must
      // store the normalized set (round-3 audit B1: the null/numeric
      // element check ran a text-vs-jsonb comparison and 503'd EVERY multi
      // row; nothing else exercises this function with a multi row on real
      // Postgres).
      const { error: multiBadErr } = await clientA.rpc("save_quiz_questions", {
        p_quiz_id: qtQuiz.id,
        p_title: null,
        p_source_file_url: null,
        p_source_text: null,
        p_mode: "append",
        p_questions: [
          { type: "multi_select", prompt: "string element", options: ["a", "b"], correct_indices: ["1"] },
        ],
      });
      const { error: multiOkErr } = await clientA.rpc("save_quiz_questions", {
        p_quiz_id: qtQuiz.id,
        p_title: null,
        p_source_file_url: null,
        p_source_text: null,
        p_mode: "append",
        p_questions: [
          { type: "multi_select", prompt: "multi via import RPC", options: ["a", "b", "c"], correct_indices: [2, 0] },
        ],
      });
      const multiStored = await admin
        .from("questions")
        .select("correct_index, correct_indices, type")
        .eq("quiz_id", qtQuiz.id)
        .eq("type", "multi_select")
        .order("created_at", { ascending: false })
        .limit(1);
      record("QT1-D2d save_quiz_questions multi row: string element rejected, valid set stored normalized",
        Boolean(multiBadErr) && !multiOkErr &&
          multiStored.data?.[0]?.correct_index === null &&
          JSON.stringify(multiStored.data?.[0]?.correct_indices) === JSON.stringify([0, 2]),
        `bad=${multiBadErr?.message ?? "ACCEPTED"} ok=${multiOkErr?.message ?? "ok"} row=${JSON.stringify(multiStored.data?.[0])}`);
    }

    record("QT1-D2b append_question normalizes duplicate/unsorted input",
      !normErr && JSON.stringify(normQ?.correct_indices) === JSON.stringify([0, 2]) &&
        normQ?.correct_index === null,
      `${normErr?.message ?? ""} set=${JSON.stringify(normQ?.correct_indices)}`);
    void rejectCase;
    await rejectCase("out-of-bounds element", ["a", "b", "c"], null, [0, 9]);
    await rejectCase("scalar set on a multi row", ["a", "b", "c"], 0, [0, 1]);
    await rejectCase("missing set", ["a", "b", "c"], null, null);
    {
      const { error } = await clientA.rpc("append_question", {
        p_quiz_id: qtQuiz.id,
        p_type: "mcq",
        p_prompt: "invalid: set on scalar row",
        p_options: ["a", "b", "c"],
        p_correct_index: 0,
        p_correct_indices: [0, 1],
        p_explanation: "",
      });
      record("QT1-D1 set on a scalar row → invalid_correct_indices",
        Boolean(error) && error.message.includes("invalid_correct_indices"),
        error?.message ?? "unexpectedly accepted");
    }
  }

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
    createdClassId = null;
    for (const cid of touchedClassIds) {
      if (cid) await admin.from("classes").delete().eq("id", cid);
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
