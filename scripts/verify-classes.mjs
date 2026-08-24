// Phase 2 security verification harness — runs against live local Supabase.
// - Admin (service-role) client for provisioning + DB assertions.
// - Authenticated clients (anon key + real user tokens) to verify RLS from the
//   attacker's actual vantage point.
// Covers gate tests:
//   D8  — cross-lecturer isolation (lecturer B cannot read lecturer A's classes)
//   D12 — quiz-sources storage: owner reads own file; others denied
// plus join RPC idempotency/role checks and escalation probes.
// NOT a unit test; run manually: node scripts/verify-classes.mjs
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

assertLocalTarget(URL, "verify-classes.mjs");

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const results = [];
// Track resources created by this run so we can clean them up at the end
// (avoid leaving users/classes/storage objects behind on re-runs).
const createdUsers = [];
let createdClassId = null;
let createdFilePath = null;

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
  // createUser returns the full user object on success — no need to re-query
  // listUsers (which can race with local auth eventual consistency).
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
  // Mirrors the invite-code path: service-role promotion (bypasses RLS).
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
  // ── Provision: lecturer A, lecturer B, student S ─────────────
  const lecturerA = await createUser(`lectA-${stamp}@innovision.test`);
  const lecturerB = await createUser(`lectB-${stamp}@innovision.test`);
  const studentS = await createUser(`studS-${stamp}@innovision.test`);
  await promoteLecturer(lecturerA.id);
  await promoteLecturer(lecturerB.id);

  const clientA = await asUser(`lectA-${stamp}@innovision.test`);
  const clientB = await asUser(`lectB-${stamp}@innovision.test`);
  const clientS = await asUser(`studS-${stamp}@innovision.test`);

  // ── Lecturer A creates a class ───────────────────────────────
  const joinCode = makeJoinCode();
  const { data: clsA, error: createErr } = await clientA
    .from("classes")
    .insert({ title: "A's Class", lecturer_id: lecturerA.id, join_code: joinCode })
    .select("id, title, join_code")
    .single();
  createdClassId = clsA?.id ?? null;
  record("A creates own class", !createErr && clsA?.id, createErr?.message ?? "");

  // ── D8: lecturer B cannot read A's class ─────────────────────
  // Filter by A's lecturer_id (isolation is per-lecturer), not global zero —
  // other dev/test data in the DB shouldn't make this fail.
  const { data: bClasses, error: bErr } = await clientB
    .from("classes")
    .select("*")
    .eq("lecturer_id", lecturerA.id);
  record("D8 B sees 0 of A's classes", bErr === null && (bClasses ?? []).length === 0,
    `B sees ${(bClasses ?? []).length} of A's classes (expect 0)`);

  const { data: bSingle } = await clientB.from("classes").select("id").eq("id", clsA.id).maybeSingle();
  record("D8 B direct read of A's class denied", bSingle === null);

  // ── D8: student S sees 0 classes before joining (secrecy) ────
  const { data: sClassesBefore } = await clientS.from("classes").select("*");
  record("D8 student sees 0 unenrolled classes", (sClassesBefore ?? []).length === 0,
    `S sees ${(sClassesBefore ?? []).length} (expect 0)`);

  // ── Join RPC: student joins by code ──────────────────────────
  const { data: joinOk, error: joinErr } = await clientS.rpc("join_class", { code: joinCode });
  record("join_class valid code → class", joinErr === null && joinOk?.class?.id === clsA.id,
    JSON.stringify(joinErr?.message ?? joinOk));

  // ── Join idempotency: re-join → already_enrolled ─────────────
  const { data: joinAgain, error: joinAgainErr } = await clientS.rpc("join_class", { code: joinCode });
  record("join_class re-join → already_enrolled",
    joinAgainErr === null && joinAgain?.error === "already_enrolled",
    JSON.stringify(joinAgainErr?.message ?? joinAgain));

  // ── Join: wrong code → invalid_code ──────────────────────────
  const { data: joinBad, error: joinBadErr } = await clientS.rpc("join_class", { code: "ZZZZZZ" });
  record("join_class bad code → invalid_code",
    joinBadErr === null && joinBad?.error === "invalid_code",
    JSON.stringify(joinBadErr?.message ?? joinBad));

  // ── Join: lecturer B → not_student ───────────────────────────
  const { data: joinLect, error: joinLectErr } = await clientB.rpc("join_class", { code: joinCode });
  record("join_class lecturer → not_student",
    joinLectErr === null && joinLect?.error === "not_student",
    JSON.stringify(joinLectErr?.message ?? joinLect));

  // ── D8: student sees enrolled class via the join_code-free view; roster ──
  // The `classes` table is owner-only now (M-1 join-code secrecy) — a student
  // must NOT read it directly, but MUST see the enrolled class through
  // student_class_view.
  const { data: sClassesDirect } = await clientS.from("classes").select("id").eq("id", clsA.id);
  record("D8 student direct classes read denied (M-1)", (sClassesDirect ?? []).length === 0,
    `S sees ${(sClassesDirect ?? []).length} direct rows (expect 0)`);

  const { data: sClassesAfter } = await clientS
    .from("student_class_view")
    .select("id")
    .eq("id", clsA.id);
  record("D8 student sees enrolled class via view", (sClassesAfter ?? []).length === 1,
    `S sees ${(sClassesAfter ?? []).length} via view (expect 1)`);

  const { data: aRoster } = await clientA
    .from("class_enrollments")
    .select("student_id")
    .eq("class_id", clsA.id);
  record("D8 lecturer A sees roster with student", (aRoster ?? []).some((r) => r.student_id === studentS.id));

  // ── Escalation: student direct-insert enrollment → denied ────
  const { error: escalInsert } = await clientS
    .from("class_enrollments")
    .insert({ class_id: clsA.id, student_id: studentS.id });
  record("Escalation student direct-insert enrollment denied", Boolean(escalInsert),
    escalInsert?.message ?? "unexpectedly succeeded");

  // ── Escalation: student creates a class → denied ─────────────
  const { error: escalCreate } = await clientS
    .from("classes")
    .insert({ title: "Hacked", lecturer_id: studentS.id, join_code: makeJoinCode() });
  record("Escalation student creates class denied", Boolean(escalCreate),
    escalCreate?.message ?? "unexpectedly succeeded");

  // ── Escalation: lecturer A transfers class to B → denied (WITH CHECK) ──
  const { error: escalTransfer } = await clientA
    .from("classes")
    .update({ lecturer_id: lecturerB.id })
    .eq("id", clsA.id);
  record("Escalation owner transfers class denied", Boolean(escalTransfer),
    escalTransfer?.message ?? "unexpectedly succeeded");

  // ── Class Archiving & Dispute Audit Preservation Checks ──────
  // 1. Lecturer A archives the class
  const { data: archCls, error: archErr } = await clientA
    .from("classes")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", clsA.id)
    .select("id, archived_at")
    .single();
  record("Archive class sets archived_at", !archErr && archCls?.archived_at !== null);

  // 2. Dispute audit check: Lecturer A can still see the roster of the archived class
  const { data: archRoster, error: archRosterErr } = await clientA
    .from("class_enrollments")
    .select("student_id")
    .eq("class_id", clsA.id);
  record(
    "Dispute audit: roster preserved after class archived",
    !archRosterErr && (archRoster ?? []).some((r) => r.student_id === studentS.id)
  );

  // 3. Enrolled student S can no longer see the archived class in student_class_view
  const { data: sArchView } = await clientS
    .from("student_class_view")
    .select("id")
    .eq("id", clsA.id);
  record("Archived class hidden from student_class_view", (sArchView ?? []).length === 0);

  // 4. Dedicated Archive Page Query: Lecturer A sees archived class
  const { data: archPageList, error: archPageErr } = await clientA
    .from("classes")
    .select("id, title, join_code, created_at, archived_at")
    .eq("lecturer_id", lecturerA.id)
    .not("archived_at", "is", null)
    .order("archived_at", { ascending: false });
  record(
    "Dedicated archive query returns archived class",
    !archPageErr && (archPageList ?? []).some((c) => c.id === clsA.id)
  );

  // 5. Cross-lecturer isolation on dedicated archive query
  const { data: bArchList } = await clientB
    .from("classes")
    .select("id")
    .eq("lecturer_id", lecturerB.id)
    .not("archived_at", "is", null);
  record(
    "Dedicated archive query lecturer isolation (B sees 0 of A's archived classes)",
    (bArchList ?? []).every((c) => c.id !== clsA.id)
  );

  // 6. Active Dashboard Query: Excluded from active classes list
  const { data: activeList } = await clientA
    .from("classes")
    .select("id")
    .eq("lecturer_id", lecturerA.id)
    .is("archived_at", null);
  record(
    "Active dashboard query excludes archived class",
    (activeList ?? []).every((c) => c.id !== clsA.id)
  );

  // 7. Archived exact count query (used for UI header badge)
  const { count: archCount } = await clientA
    .from("classes")
    .select("id", { count: "exact", head: true })
    .eq("lecturer_id", lecturerA.id)
    .not("archived_at", "is", null);
  record("Archived exact count query returns 1", archCount === 1);

  // 8. Quiz Secrecy & Session Start Prevention on Archived Class
  const { data: archQuiz } = await admin
    .from("quizzes")
    .insert({
      class_id: clsA.id,
      title: "Archived Class Quiz",
      mode: "practice",
      status: "draft",
      created_by: lecturerA.id,
    })
    .select("id")
    .single();

  if (archQuiz) {
    await admin.from("questions").insert({
      quiz_id: archQuiz.id,
      type: "mcq",
      prompt: "Sample Question?",
      options: ["A", "B", "C", "D"],
      correct_index: 0,
      order_index: 0,
    });
    await admin
      .from("quizzes")
      .update({ status: "live" })
      .eq("id", archQuiz.id);
  }

  const { data: sQuizView } = await clientS
    .from("student_quiz_view")
    .select("id")
    .eq("id", archQuiz?.id);
  record(
    "Quizzes of archived class hidden from student_quiz_view",
    (sQuizView ?? []).length === 0
  );

  const { data: startArchQuiz, error: startArchQuizErr } = await clientS.rpc(
    "start_quiz_session",
    { p_quiz_id: archQuiz.id }
  );
  record(
    "start_quiz_session rejected on archived class quiz (quiz_not_live)",
    startArchQuizErr === null && startArchQuiz?.error === "quiz_not_live"
  );

  // 9. New student S2 cannot join an archived class (RPC returns class_archived)
  await createUser(`studS2-${stamp}@innovision.test`);
  const clientS2 = await asUser(`studS2-${stamp}@innovision.test`);
  const { data: joinArchived, error: joinArchivedErr } = await clientS2.rpc("join_class", { code: joinCode });
  record(
    "join_class rejected on archived class (class_archived)",
    joinArchivedErr === null && joinArchived?.error === "class_archived",
    JSON.stringify(joinArchivedErr?.message ?? joinArchived)
  );

  // 10. Cross-lecturer isolation: Lecturer B cannot unarchive Lecturer A's class
  const { data: bUnarch } = await clientB
    .from("classes")
    .update({ archived_at: null })
    .eq("id", clsA.id)
    .select("id");
  record("Lecturer B cannot unarchive A's class (RLS)", (bUnarch ?? []).length === 0);

  // 11. Restoration: Lecturer A restores the class
  const { data: restCls, error: restErr } = await clientA
    .from("classes")
    .update({ archived_at: null })
    .eq("id", clsA.id)
    .select("id, archived_at")
    .single();
  record("Restore class sets archived_at = null", !restErr && restCls?.archived_at === null);

  // 12. Student S immediately sees the restored class again in view
  const { data: sRestView } = await clientS
    .from("student_class_view")
    .select("id")
    .eq("id", clsA.id);
  record("Restored class visible again in student_class_view", (sRestView ?? []).length === 1);

  // 13. Student S2 can now successfully join restored class
  const { data: joinPostRest, error: joinPostRestErr } = await clientS2.rpc(
    "join_class",
    { code: joinCode }
  );
  record(
    "join_class succeeds after class restored (student S2)",
    joinPostRestErr === null && joinPostRest?.class?.id === clsA.id
  );

  // 14. Restored quiz visible again in student_quiz_view
  const { data: sQuizViewRest } = await clientS
    .from("student_quiz_view")
    .select("id")
    .eq("id", archQuiz.id);
  record(
    "Quizzes visible again in student_quiz_view after restoration",
    (sQuizViewRest ?? []).length === 1
  );

  // Cleanup test quiz
  await admin.from("quizzes").delete().eq("id", archQuiz.id);

  // ── D12: storage isolation ───────────────────────────────────
  // Service-role upload into A's folder (owner=NULL → foldername-keyed policy).
  const filePath = `${lecturerA.id}/sample.pdf`;
  createdFilePath = filePath;
  const { error: upErr } = await admin.storage
    .from("quiz-sources")
    .upload(filePath, new Blob(["dummy"], { type: "application/pdf" }), {
      contentType: "application/pdf",
      upsert: true,
    });
  record("D12 service-role upload into A's folder", !upErr, upErr?.message ?? "");

  const { data: dA } = await clientA.storage.from("quiz-sources").download(filePath);
  record("D12 A downloads own file", Boolean(dA));

  const { error: dBErr } = await clientB.storage.from("quiz-sources").download(filePath);
  record("D12 B download denied", Boolean(dBErr), dBErr?.message ?? "unexpectedly succeeded");

  const { error: dSErr } = await clientS.storage.from("quiz-sources").download(filePath);
  record("D12 student download denied", Boolean(dSErr), dSErr?.message ?? "unexpectedly succeeded");

  const { error: signedErr } = await clientB.storage
    .from("quiz-sources")
    .createSignedUrl(filePath, 60);
  record("D12 B signed-URL denied", Boolean(signedErr), signedErr?.message ?? "unexpectedly succeeded");

  const { error: upStudentErr } = await clientS.storage
    .from("quiz-sources")
    .upload(`${lecturerA.id}/evil.pdf`, new Blob(["x"]), { upsert: true });
  record("D12 student upload into A's folder denied", Boolean(upStudentErr),
    upStudentErr?.message ?? "unexpectedly succeeded");

  const { data: bucket } = await admin.storage.getBucket("quiz-sources");
  record("D12 bucket is private", bucket?.public === false, `public=${bucket?.public}`);

  // ── Summary ──────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} checks passed`);
  return passed === results.length ? 0 : 1;
}

async function cleanup() {
  // Best-effort cleanup so re-runs start from a clean slate.
  try {
    if (createdFilePath) {
      await admin.storage.from("quiz-sources").remove([createdFilePath]);
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
