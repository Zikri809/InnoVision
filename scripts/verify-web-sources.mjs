// 0040 migration smoke (server-critic finding 4): proves the SQL behaviors
// vitest's FakeSupabase cannot — the sibling function exists, the 6-arg call
// still resolves, grants are revoked from anon, invalid web URLs are skipped,
// and replace/append sources assembly matches the route contract.
//
// Run: node scripts/verify-web-sources.mjs   (requires local supabase running;
// refuses a non-local target via assertLocalTarget — override only with
// ALLOW_PROD_SEED=1).

import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { assertLocalTarget } from "./lib/target-guard.mjs";

if (existsSync(".env.local")) loadEnv({ path: ".env.local", override: false });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !ANON || !SERVICE) {
  console.error("Set Supabase env vars (local supabase must be running).");
  process.exit(2);
}

// Service-role harness that MUTATES the target (createUser + profile/class/
// quiz inserts + RPC calls) — same guard as every sibling verify-* script.
assertLocalTarget(URL, "verify-web-sources.mjs");

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(URL, SERVICE);

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`);
  }
}

// ─── Setup: lecturer A + class + draft quiz ──────────────────────────────────
const { data: auth, error: authErr } = await admin.auth.admin.createUser({
  email: `ws-probe-${Date.now()}@innovision.test`,
  password: "Password123!",
  email_confirm: true,
});
if (authErr) {
  console.error("Could not create probe user:", authErr.message);
  process.exit(2);
}
const uid = auth.user.id;
await admin.from("profiles").upsert({ id: uid, role: "lecturer", full_name: "WS Probe" });
// Join-code alphabet per the DB CHECK (0002): exactly 6 chars from
// ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (no 0/1/I/O).
const JOIN_CODE = "WSPRBP";
const { data: cls, error: clsErr } = await admin
  .from("classes")
  .insert({ lecturer_id: uid, title: "WS Probe Class", join_code: JOIN_CODE })
  .select()
  .single();
if (clsErr) {
  console.error("Could not create class:", clsErr.message);
  process.exit(2);
}
const { data: quiz, error: quizErr } = await admin
  .from("quizzes")
  .insert({
    class_id: cls.id, title: "WS Probe Draft", mode: "practice", status: "draft",
    created_by: uid, allow_retake: false, max_attempts: 1, shuffle_questions: false,
  })
  .select()
  .single();
if (quizErr) {
  console.error("Could not create quiz:", quizErr.message);
  process.exit(2);
}

const QUESTIONS = [
  { type: "mcq", prompt: "Probe question one?", options: ["a", "b", "c"], correct_index: 0, explanation: null },
  { type: "mcq", prompt: "Probe question two?", options: ["a", "b"], correct_index: 1, explanation: null },
  { type: "true_false", prompt: "Probe statement three.", options: ["True", "False"], correct_index: 0, explanation: null },
];
const WEB_OK = [
  { kind: "web", url: "https://a.com/one", title: "Source One", retrieved_at: "2026-09-07T00:00:00Z", query: "probe" },
  { kind: "web", url: "https://b.com/two", title: "Source Two", retrieved_at: "2026-09-07T00:00:00Z", query: "probe" },
  { kind: "web", url: "javascript:alert(1)", title: "Evil", retrieved_at: "2026-09-07T00:00:00Z", query: "probe" },
];

const WEB_QUESTIONS = [...QUESTIONS];

// G1: anon grant layer — BOTH functions must deny unauthenticated EXECUTE.
const anon = createClient(URL, ANON);
{
  const { error } = await anon.rpc("save_quiz_questions", {
    p_quiz_id: quiz.id, p_title: "x", p_source_file_url: null,
    p_source_text: null, p_questions: [], p_mode: "replace",
  });
  check("G1a 6-arg anon denied (grant revoked)", error?.message.includes("permission denied"), error?.message);
  const { error: e2 } = await anon.rpc("save_quiz_questions_web", {
    p_quiz_id: quiz.id, p_title: "x", p_source_file_url: null,
    p_source_text: null, p_questions: [], p_mode: "replace", p_web_sources: null,
  });
  check("G1b web fn anon denied (grant revoked)", e2?.message.includes("permission denied"), e2?.message);
}

// Owner session for the RPC calls. The first attempt uses a placeholder email
// (the real one embeds the created timestamp) — its result is discarded; the
// block below signs in with the reconstructed address.
const sb = createClient(URL, ANON);
await sb.auth.signInWithPassword({
  email: `ws-probe-${Date.now()}@innovision.test`,
});
// The created email embeds a timestamp; re-fetch it.
{
  const email = `ws-probe-${auth.user.email.match(/(\d+)/)?.[1]}@innovision.test`;
  const { data: s, error } = await sb.auth.signInWithPassword({ email, password: "Password123!" });
  if (error) {
    console.error("Could not sign in as probe user:", error.message);
    process.exit(2);
  }
  void s;
}

// G2: authenticated owner — 6-arg replace works (legacy contract intact).
{
  const { error } = await sb.rpc("save_quiz_questions", {
    p_quiz_id: quiz.id, p_title: "WS Probe Draft", p_source_file_url: `${uid}/${quiz.id}/file.pdf`,
    p_source_text: "legacy text", p_questions: QUESTIONS, p_mode: "replace",
  });
  check("G2 6-arg replace (legacy body intact)", !error, error?.message);
  const { data: row } = await admin.from("quizzes").select("sources").eq("id", quiz.id).maybeSingle();
  const sources = row?.sources ?? [];
  check("G2b sources = legacy storage entry", sources.length === 1 && !!sources[0].storage_path, JSON.stringify(sources).slice(0, 120));
}

// G3: web replace — replaces the sources set with validated web entries only.
{
  const { error } = await sb.rpc("save_quiz_questions_web", {
    p_quiz_id: quiz.id, p_title: "WS Probe Draft", p_source_file_url: null,
    p_source_text: "web text", p_questions: WEB_QUESTIONS, p_mode: "replace",
    p_web_sources: WEB_OK,
  });
  check("G3 web replace succeeds", !error, error?.message);
  const { data: row } = await admin.from("quizzes").select("sources").eq("id", quiz.id).maybeSingle();
  const sources = row?.sources ?? [];
  check("G3b invalid URL entry skipped, 2 valid persisted",
    sources.length === 2 && sources.every((s) => s.kind === "web" && /^https?:\/\//.test(s.url)),
    JSON.stringify(sources).slice(0, 160));
}

// G4: web append — appends to the existing set (mixed shape).
{
  const { error } = await sb.rpc("save_quiz_questions_web", {
    p_quiz_id: quiz.id, p_title: null, p_source_file_url: null,
    p_source_text: "more web text", p_questions: [{ type: "mcq", prompt: "Append probe?", options: ["a", "b"], correct_index: 0, explanation: null }],
    p_mode: "append", p_web_sources: [{ kind: "web", url: "https://c.com/three", title: "Three", retrieved_at: null, query: "probe2" }],
  });
  check("G4 web append succeeds", !error, error?.message);
  const { data: row } = await admin.from("quizzes").select("sources").eq("id", quiz.id).maybeSingle();
  const sources = row?.sources ?? [];
  check("G4b sources grew to 3 (append semantics)",
    sources.length === 3 && sources[2]?.url === "https://c.com/three",
    JSON.stringify(sources.map((s) => s.url)));
}

// G5: web fn WITHOUT p_web_sources behaves like the legacy fn (web set empty
// → legacy sources branch; no crash on the null 7th arg).
{
  const { error } = await sb.rpc("save_quiz_questions_web", {
    p_quiz_id: quiz.id, p_title: "WS Probe Draft", p_source_file_url: null,
    p_source_text: "plain text", p_questions: WEB_QUESTIONS, p_mode: "replace", p_web_sources: null,
  });
  check("G5 web fn with null web_sources succeeds", !error, error?.message);
  const { data: row } = await admin.from("quizzes").select("sources").eq("id", quiz.id).maybeSingle();
  check("G5b null web set → sources cleared (replace semantics)", (row?.sources ?? []).length === 0);
}

// G6: non-array web_sources → invalid_web_sources_json (typed rejection).
{
  const { error } = await sb.rpc("save_quiz_questions_web", {
    p_quiz_id: quiz.id, p_title: "x", p_source_file_url: null,
    p_source_text: null, p_questions: WEB_QUESTIONS, p_mode: "replace",
    p_web_sources: { not: "an array" },
  });
  check("G6 non-array web_sources rejected", error?.message.includes("invalid_web_sources_json"), error?.message);
}

// ─── 0041: multi-file provenance (p_source_paths) ────────────────────────────

// H1: replace with 2 paths + web sources → BOTH file entries AND web entries
// persist (the pre-0041 CASE was either/or and dropped the web set).
{
  const { error } = await sb.rpc("save_quiz_questions_web", {
    p_quiz_id: quiz.id, p_title: "WS Probe Draft",
    p_source_file_url: `${uid}/${quiz.id}/deck1.pdf`,
    p_source_text: "multi-file text",
    p_questions: WEB_QUESTIONS, p_mode: "replace",
    p_web_sources: WEB_OK,
    p_source_paths: [`${uid}/${quiz.id}/deck1.pdf`, `${uid}/${quiz.id}/deck2.pdf`],
  });
  check("H1 multi-path + web replace succeeds", !error, error?.message);
  const { data: row } = await admin.from("quizzes").select("sources, source_file_url").eq("id", quiz.id).maybeSingle();
  const sources = row?.sources ?? [];
  const fileEntries = sources.filter((s) => s.kind === undefined && s.storage_path);
  check("H1b one file entry per path (2) + 2 valid web entries",
    fileEntries.length === 2 &&
    fileEntries[0].filename === "deck1.pdf" && fileEntries[1].filename === "deck2.pdf" &&
    sources.filter((s) => s.kind === "web").length === 2,
    JSON.stringify(sources).slice(0, 200));
  check("H1c source_file_url = primary path", row?.source_file_url === `${uid}/${quiz.id}/deck1.pdf`, row?.source_file_url);
}

// H2: append adds the new file entries beside existing ones (mixed growth).
{
  const { error } = await sb.rpc("save_quiz_questions_web", {
    p_quiz_id: quiz.id, p_title: null,
    p_source_file_url: `${uid}/${quiz.id}/deck3.pdf`,
    p_source_text: "append text",
    p_questions: [{ type: "mcq", prompt: "H2 append probe?", options: ["a", "b"], correct_index: 0, explanation: null }],
    p_mode: "append",
    p_source_paths: [`${uid}/${quiz.id}/deck3.pdf`],
  });
  check("H2 multi-path append succeeds", !error, error?.message);
  const { data: row } = await admin.from("quizzes").select("sources").eq("id", quiz.id).maybeSingle();
  const sources = row?.sources ?? [];
  check("H2b sources grew (2 files + 2 web + 1 new file = 5)",
    sources.length === 5 && sources[4]?.storage_path?.endsWith("deck3.pdf"),
    JSON.stringify(sources.map((s) => s.storage_path ?? s.url)));
}

// H3: null p_source_paths + null URL → no file entries (text-only flow stays
// chip-less); null paths + URL alone → single legacy-shape entry (fallback).
{
  const { error } = await sb.rpc("save_quiz_questions_web", {
    p_quiz_id: quiz.id, p_title: "WS Probe Draft", p_source_file_url: null,
    p_source_text: "plain text", p_questions: WEB_QUESTIONS, p_mode: "replace",
    p_web_sources: null, p_source_paths: null,
  });
  check("H3 null paths succeeds", !error, error?.message);
  const { data: row } = await admin.from("quizzes").select("sources").eq("id", quiz.id).maybeSingle();
  check("H3b text-only replace → empty sources", (row?.sources ?? []).length === 0);

  const { error: e2 } = await sb.rpc("save_quiz_questions_web", {
    p_quiz_id: quiz.id, p_title: "WS Probe Draft", p_source_file_url: `${uid}/${quiz.id}/solo.pdf`,
    p_source_text: "solo text", p_questions: WEB_QUESTIONS, p_mode: "replace",
    p_web_sources: null, p_source_paths: null,
  });
  check("H3c URL-only fallback succeeds", !e2, e2?.message);
  const { data: row2 } = await admin.from("quizzes").select("sources").eq("id", quiz.id).maybeSingle();
  const sources2 = row2?.sources ?? [];
  check("H3d URL-only → 1 legacy-shape entry", sources2.length === 1 && sources2[0].storage_path === `${uid}/${quiz.id}/solo.pdf`,
    JSON.stringify(sources2).slice(0, 120));
}

// H4: non-array p_source_paths → invalid_source_paths_json (typed rejection);
// non-text elements are skipped, not fatal.
{
  const { error } = await sb.rpc("save_quiz_questions_web", {
    p_quiz_id: quiz.id, p_title: "x", p_source_file_url: null,
    p_source_text: null, p_questions: WEB_QUESTIONS, p_mode: "replace",
    p_source_paths: { not: "an array" },
  });
  check("H4 non-array source_paths rejected", error?.message.includes("invalid_source_paths_json"), error?.message);

  const { error: e2 } = await sb.rpc("save_quiz_questions_web", {
    p_quiz_id: quiz.id, p_title: "WS Probe Draft", p_source_file_url: null,
    p_source_text: "skip-invalid text", p_questions: WEB_QUESTIONS, p_mode: "replace",
    p_source_paths: [`${uid}/${quiz.id}/good.pdf`, 42, null, ""],
  });
  check("H4b mixed-type path list succeeds", !e2, e2?.message);
  const { data: row } = await admin.from("quizzes").select("sources").eq("id", quiz.id).maybeSingle();
  const sources = row?.sources ?? [];
  check("H4c only the text path persisted", sources.length === 1 && sources[0].storage_path === `${uid}/${quiz.id}/good.pdf`,
    JSON.stringify(sources).slice(0, 120));
}

// Cleanup the probe quiz/user rows (best effort; local DB only).
await admin.from("quizzes").delete().eq("id", quiz.id);
await admin.from("classes").delete().eq("id", cls.id);
await admin.auth.admin.deleteUser(uid);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
