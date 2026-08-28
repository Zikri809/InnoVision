// Class archiving security verification harness — runs against live local Supabase.
// Clones verify-classes.mjs (env trio + target-guard + service-role + real anon
// clients + cleanup) scoped to the D26b contract:
//   - archived → hidden from student_class_view / student_quiz_view
//   - can_student_view_quiz(p_quiz_id) → false (RLS helper, migration 0017)
//   - start_quiz_session → { error: 'quiz_not_live' }
//   - join_class → { error: 'class_archived' }
//   - restore → re-exposes class + quiz + can_student_view_quiz → true
// NOT a unit test; run manually: node scripts/verify-class-archiving.mjs
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

assertLocalTarget(URL, "verify-class-archiving.mjs");

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const results = [];
const createdUsers = [];
let createdClassId = null;
let createdQuizId = null;

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

async function main() {
  // ── Provision: lecturer A, student S (enrolled), student S2 (outsider) ──
  const lecturerA = await createUser(`arcLect-${stamp}@innovision.test`);
  const studentS = await createUser(`arcStud-${stamp}@innovision.test`);
  // Created only so clientS2 has a real outsider account to auth as.
  await createUser(`arcStud2-${stamp}@innovision.test`);
  await promoteLecturer(lecturerA.id);

  const clientA = await asUser(`arcLect-${stamp}@innovision.test`);
  const clientS = await asUser(`arcStud-${stamp}@innovision.test`);
  const clientS2 = await asUser(`arcStud2-${stamp}@innovision.test`);

  // ── Class + live quiz + enrollment ────────────────────────────
  const joinCode = makeJoinCode();
  const { data: clsA, error: createErr } = await clientA
    .from("classes")
    .insert({ title: "Archive Probe Class", lecturer_id: lecturerA.id, join_code: joinCode })
    .select("id, title, join_code")
    .single();
  createdClassId = clsA?.id ?? null;
  record("A creates own class", !createErr && clsA?.id, createErr?.message ?? "");

  const { data: quiz, error: quizErr } = await admin
    .from("quizzes")
    .insert({
      class_id: clsA.id,
      title: "Archive Probe Quiz",
      mode: "practice",
      status: "draft",
      created_by: lecturerA.id,
    })
    .select("id")
    .single();
  createdQuizId = quiz?.id ?? null;
  if (quiz) {
    await admin.from("questions").insert({
      quiz_id: quiz.id,
      type: "mcq",
      prompt: "Probe?",
      options: ["A", "B"],
      correct_index: 0,
      order_index: 0,
    });
    await admin.from("quizzes").update({ status: "live" }).eq("id", quiz.id);
  }
  record("Seed live quiz in class", !quizErr && quiz?.id, quizErr?.message ?? "");

  const { data: joinOk } = await clientS.rpc("join_class", { code: joinCode });
  record("S joins active class", joinOk?.class?.id === clsA.id, JSON.stringify(joinOk));

  // Pre-archive baseline (view exposes the class + quiz; can_student_view_quiz true).
  const { data: preClassView } = await clientS
    .from("student_class_view")
    .select("id")
    .eq("id", clsA.id);
  record("Baseline: class visible in student_class_view", (preClassView ?? []).length === 1);

  const { data: preQuizView } = await clientS
    .from("student_quiz_view")
    .select("id")
    .eq("id", quiz.id);
  record("Baseline: quiz visible in student_quiz_view", (preQuizView ?? []).length === 1);

  const { data: preCanView, error: preCanErr } = await clientS.rpc("can_student_view_quiz", {
    p_quiz_id: quiz.id,
  });
  record("Baseline: can_student_view_quiz → true", preCanErr === null && preCanView === true,
    JSON.stringify({ preCanErr: preCanErr?.message, preCanView }));

  // ── Archive ───────────────────────────────────────────────────
  const { data: archCls, error: archErr } = await clientA
    .from("classes")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", clsA.id)
    .select("id, archived_at")
    .single();
  record("Archive sets archived_at", !archErr && archCls?.archived_at !== null);

  // 1. Hidden from the student views.
  const { data: sClassView } = await clientS
    .from("student_class_view")
    .select("id")
    .eq("id", clsA.id);
  record("Archived class hidden from student_class_view", (sClassView ?? []).length === 0);

  const { data: sQuizView } = await clientS
    .from("student_quiz_view")
    .select("id")
    .eq("id", quiz.id);
  record("Archived class quiz hidden from student_quiz_view", (sQuizView ?? []).length === 0);

  // 2. can_student_view_quiz helper → false.
  const { data: canView, error: canErr } = await clientS.rpc("can_student_view_quiz", {
    p_quiz_id: quiz.id,
  });
  record("can_student_view_quiz → false (archived)", canErr === null && canView === false,
    JSON.stringify(canErr?.message ?? canView));

  // 3. start_quiz_session → quiz_not_live (archived classes read as not live).
  const { data: startRes, error: startErr } = await clientS.rpc("start_quiz_session", {
    p_quiz_id: quiz.id,
  });
  record("start_quiz_session rejected (quiz_not_live)", startErr === null && startRes?.error === "quiz_not_live",
    JSON.stringify(startErr?.message ?? startRes));

  // 4. join_class → class_archived (outsider S2).
  const { data: joinArch, error: joinArchErr } = await clientS2.rpc("join_class", {
    code: joinCode,
  });
  record("join_class rejected (class_archived)", joinArchErr === null && joinArch?.error === "class_archived",
    JSON.stringify(joinArchErr?.message ?? joinArch));

  // 5. Owner still reads the class + roster (audit preservation).
  const { data: ownerRoster } = await clientA
    .from("class_enrollments")
    .select("student_id")
    .eq("class_id", clsA.id);
  record("Owner roster preserved after archive", (ownerRoster ?? []).some((r) => r.student_id === studentS.id));

  // ── Restore ───────────────────────────────────────────────────
  const { data: restCls, error: restErr } = await clientA
    .from("classes")
    .update({ archived_at: null })
    .eq("id", clsA.id)
    .select("id, archived_at")
    .single();
  record("Restore sets archived_at = null", !restErr && restCls?.archived_at === null);

  const { data: sClassView2 } = await clientS
    .from("student_class_view")
    .select("id")
    .eq("id", clsA.id);
  record("Restored class visible again in student_class_view", (sClassView2 ?? []).length === 1);

  const { data: sQuizView2 } = await clientS
    .from("student_quiz_view")
    .select("id")
    .eq("id", quiz.id);
  record("Restored quiz visible again in student_quiz_view", (sQuizView2 ?? []).length === 1);

  const { data: canView2, error: canErr2 } = await clientS.rpc("can_student_view_quiz", {
    p_quiz_id: quiz.id,
  });
  record("can_student_view_quiz → true (restored)", canErr2 === null && canView2 === true,
    JSON.stringify(canErr2?.message ?? canView2));

  // ── Summary ──────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} checks passed`);
  return passed === results.length ? 0 : 1;
}

async function cleanup() {
  try {
    if (createdQuizId) await admin.from("quizzes").delete().eq("id", createdQuizId);
    if (createdClassId) await admin.from("classes").delete().eq("id", createdClassId);
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
