// Security verification harness — runs against live local Supabase.
// - Admin (service-role) client for provisioning + DB assertions.
// - Authenticated client (anon key + real user token) to verify RLS from the
//   attacker's actual vantage point (what an end user can do).
// NOT a unit test; run manually: node scripts/verify-security.mjs
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

assertLocalTarget(URL, "verify-security.mjs");

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const results = [];

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function createUser(email) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "hunter2!Secure",
    email_confirm: true,
  });
  if (error) throw error;
  // createUser returns the full user object on success — no need to re-query
  // listUsers (which can race with local auth eventual consistency).
  return data.user;
}

// ── TEST 1: signup claiming role=lecturer must yield a STUDENT profile ──
{
  const email = `attacker-${stamp}@innovision.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "hunter2!Secure",
    email_confirm: true,
    user_metadata: { role: "lecturer", full_name: "Evil Hacker" }, // attacker-controlled
  });
  if (error) {
    record("1 signup with role=lecturer → student", false, error.message);
  } else {
    const u = data.user;
    const { data: prof } = await admin.from("profiles").select("role, full_name").eq("id", u.id).single();
    record("1 signup with role=lecturer → student", prof?.role === "student", `got role=${prof?.role} (expect student)`);
  }
}

// ── TEST 2: a STUDENT (authenticated, real token) cannot update their own role ──
{
  const email = `student-upd-${stamp}@innovision.test`;
  const u = await createUser(email);
  // Real end-user client: anon key + the user's session token
  const userClient = createClient(URL, ANON, { auth: { persistSession: false } });
  await userClient.auth.signInWithPassword({ email, password: "hunter2!Secure" });
  const { error } = await userClient
    .from("profiles")
    .update({ role: "lecturer" })
    .eq("id", u.id);
  record("2 student self-upgrade to lecturer blocked", Boolean(error), error?.message ?? "unexpectedly succeeded");
}

// ── TEST 3: a STUDENT cannot insert a profile row for another user ──
{
  const email = `student-ins-${stamp}@innovision.test`;
  await createUser(email);
  const victim = (await admin.auth.admin.listUsers()).data.users.find((x) => x.email !== email);
  const userClient = createClient(URL, ANON, { auth: { persistSession: false } });
  await userClient.auth.signInWithPassword({ email, password: "hunter2!Secure" });
  const { error } = await userClient
    .from("profiles")
    .insert({ id: victim.id, role: "student" });
  record("3 student arbitrary-insert blocked", Boolean(error), error?.message ?? "unexpectedly succeeded");
}

console.log("\n" + "=".repeat(60));
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
