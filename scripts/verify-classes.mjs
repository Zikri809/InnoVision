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

  // ── D8: student sees 1 class after joining; roster visible to A ──
  const { data: sClassesAfter } = await clientS.from("classes").select("id").eq("id", clsA.id);
  record("D8 student sees enrolled class", (sClassesAfter ?? []).length === 1);

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
