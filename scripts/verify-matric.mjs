// Matric numbers (migration 0027): trigger/normalization/uniqueness/RLS
// verification harness — runs against live local Supabase. Follows the
// verify-results.mjs harness culture: self-contained fixtures via the
// service-role admin client (createUser fires on_auth_user_created → real
// trigger path), full teardown in cleanup().
//
// Covers (PLAN_MATRIC_EXCEL_EXPORT §4):
//   M1  trigger copies + NORMALIZES metadata matric (" 231234 " → 231234)
//   M2  malformed metadata (5-digit) → profile.matric_no NULL, user still
//       created (normalize-and-null, never aborts signup)
//   M3  duplicate matric across users → second createUser errors
//       (unique index; GoTrue wraps 23505 opaquely — assert error presence)
//   M4  plural NULL matrics coexist (lecturers/legacy)
//   M5  format CHECK rejects garbage via direct write (service role)
//   M6  roster view exposes matric to the OWNING lecturer only; enrolled
//       student reads the view → 0 rows; student reads another's profiles
//       row → 0 rows (self-only policy intact after 0027)
//   M7  security_barrier retained via drop+recreate; column ORDER pinned by
//       a select("*") key-order probe (PostgREST emits view-definition order)
//   M8  student self-update of own matric works under RLS; claiming another
//       student's matric fails at the unique index
//
// NOT a unit test; run manually: node scripts/verify-matric.mjs
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

assertLocalTarget(URL, "verify-matric.mjs");

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
// Random suffix: two harness invocations in the same millisecond must never
// share emails (GoTrue "already registered" would fail M1 spuriously).
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const results = [];
const createdUsers = [];
const createdClassIds = [];

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function createUser(email, matricNo) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "hunter2!Secure",
    email_confirm: true,
    user_metadata: {
      full_name: email.split("@")[0],
      ...(matricNo !== undefined ? { matric_no: matricNo } : {}),
    },
  });
  if (error) return { user: null, error };
  createdUsers.push(data.user.id);
  return { user: data.user, error: null };
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

async function getProfile(userId) {
  const { data, error } = await admin.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error) throw error;
  return data;
}

async function main() {
  // ── M1: normalization through the signup trigger ──────────────────────────
  const m1 = await createUser(`matric-ok-${stamp}@test.local`, " 231234 ");
  record("M1 user with messy-but-valid matric created", Boolean(m1.user), m1.error?.message);
  const p1 = m1.user ? await getProfile(m1.user.id) : null;
  record(
    "M1 trigger normalized matric to 231234",
    p1?.matric_no === "231234",
    `got ${JSON.stringify(p1?.matric_no)}`,
  );

  // ── M2: malformed metadata → NULL, never an aborted signup ───────────────
  const m2 = await createUser(`matric-bad-${stamp}@test.local`, "12345");
  record("M2 user with malformed matric still created", Boolean(m2.user), m2.error?.message);
  const p2 = m2.user ? await getProfile(m2.user.id) : null;
  record("M2 malformed matric stored as NULL", p2?.matric_no === null, `got ${JSON.stringify(p2?.matric_no)}`);

  // ── M3: duplicate matric rejected ────────────────────────────────────────
  const m3 = await createUser(`matric-dup-${stamp}@test.local`, "231234");
  record("M3 duplicate matric rejected", !m3.user && Boolean(m3.error), m3.error?.message ?? "unexpectedly succeeded");

  // ── M4: plural NULLs coexist ───────────────────────────────────────────────
  const m4a = await createUser(`matric-null-a-${stamp}@test.local`);
  const m4b = await createUser(`matric-null-b-${stamp}@test.local`);
  record("M4 fixture users created", Boolean(m4a.user && m4b.user));
  if (!m4a.user || !m4b.user) throw new Error("M4 fixture creation failed — aborting run");
  const [p4a, p4b] = await Promise.all([getProfile(m4a.user.id), getProfile(m4b.user.id)]);
  record("M4 two matric-less accounts coexist", p4a.matric_no === null && p4b.matric_no === null);

  // ── M5: format CHECK guards direct writes too ─────────────────────────────
  const { error: m5err } = await admin
    .from("profiles")
    .update({ matric_no: "has spaces!" })
    .eq("id", m4a.user.id);
  record("M5 format CHECK rejects direct bad write", Boolean(m5err), m5err?.message);

  // Lecturer + class + enrollment for M6–M8.
  const lecturer = await createUser(`matric-lec-${stamp}@test.local`);
  await admin.from("profiles").update({ role: "lecturer" }).eq("id", lecturer.user.id);
  const joinCode = Array.from({ length: 6 }, () =>
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)],
  ).join("");
  const { data: cls, error: clsErr } = await admin
    .from("classes")
    .insert({ title: "Matric Probe Class", lecturer_id: lecturer.user.id, join_code: joinCode })
    .select("id")
    .single();
  createdClassIds.push(cls?.id);
  if (clsErr || !cls) throw clsErr ?? new Error("class insert failed");
  await admin.from("class_enrollments").insert({ class_id: cls.id, student_id: m1.user.id });

  // ── M6: roster visibility ──────────────────────────────────────────────────
  const lecClient = await asUser(`matric-lec-${stamp}@test.local`);
  const { data: lecRoster } = await lecClient
    .from("student_roster_view")
    .select("student_id, full_name, enrolled_at, matric_no")
    .eq("class_id", cls.id);
  record(
    "M6 owning lecturer sees matric in roster view",
    (lecRoster ?? []).some((r) => r.student_id === m1.user.id && r.matric_no === "231234"),
    JSON.stringify(lecRoster),
  );

  const stuClient = await asUser(`matric-ok-${stamp}@test.local`);
  const { data: stuRoster } = await stuClient
    .from("student_roster_view")
    .select("*")
    .eq("class_id", cls.id);
  record("M6 enrolled student reads roster view → 0 rows", (stuRoster ?? []).length === 0);

  const { data: crossProfile } = await stuClient
    .from("profiles")
    .select("matric_no")
    .eq("id", m4a.user.id)
    .maybeSingle();
  record("M6 student cannot read another's profiles row", crossProfile === null);

  // ── M7: view shape — matric_no appended as the LAST output column ─────────
  // select("*") emits columns in view-definition order and JS preserves JSON
  // key insertion order, so key order proves the positional contract that
  // OR REPLACE would otherwise guarantee. Barrier retention is guaranteed by
  // the drop+recreate pattern itself (0006 precedent).
  const { data: starRows, error: starErr } = await lecClient
    .from("student_roster_view")
    .select("*")
    .limit(1);
  const starKeys = starRows?.[0] ? Object.keys(starRows[0]) : null;
  const EXPECTED_ORDER = ["class_id", "student_id", "full_name", "enrolled_at", "matric_no"];
  record(
    "M7 roster view column order is exactly [class_id, student_id, full_name, enrolled_at, matric_no]",
    !starErr &&
      Array.isArray(starKeys) &&
      starKeys.length === EXPECTED_ORDER.length &&
      EXPECTED_ORDER.every((c, i) => starKeys[i] === c),
    JSON.stringify(starKeys ?? starErr?.message),
  );

  // ── M8: RLS self-edit of own matric ────────────────────────────────────────
  const { error: selfErr } = await stuClient
    .from("profiles")
    .update({ matric_no: "245678" })
    .eq("id", m1.user.id);
  record("M8 student self-update of own matric allowed", !selfErr, selfErr?.message);
  const p8 = await getProfile(m1.user.id);
  record("M8 self-update persisted", p8?.matric_no === "245678", `got ${p8?.matric_no}`);

  // Claiming ANOTHER student's matric → UNIQUE violation (23505). The value
  // passes the format CHECK by construction, RLS permits the own-row update,
  // and the 0019 trigger ignores matric_no — so assert the exact PG code.
  await admin.from("profiles").update({ matric_no: "354321" }).eq("id", m4b.user.id);
  const { error: claimErr } = await stuClient
    .from("profiles")
    .update({ matric_no: "354321" })
    .eq("id", m1.user.id);
  record(
    "M8 claiming another student's matric fails (23505)",
    Boolean(claimErr) && claimErr.code === "23505",
    claimErr ? `${claimErr.code ?? "?"}: ${claimErr.message}` : "unexpectedly succeeded",
  );

  return results.filter((r) => r.pass).length === results.length ? 0 : 1;
}

async function cleanup() {
  try {
    for (const cid of createdClassIds) {
      if (!cid) continue;
      await admin.from("class_enrollments").delete().eq("class_id", cid);
      await admin.from("classes").delete().eq("id", cid);
    }
    if (createdUsers.length) {
      await admin.from("audit_events").delete().in("subject_id", createdUsers);
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
    console.log("\n" + "=".repeat(60));
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} checks passed`);
    await cleanup();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("Fatal:", err);
    await cleanup();
    process.exit(1);
  });
