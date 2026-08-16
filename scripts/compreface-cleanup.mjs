// CompreFace consent-revoke cleanup — deletes CompreFace subjects for profiles
// whose consent was revoked while CompreFace was down (`face_deletion_pending =
// true`). This is the retriable deletion path (PLAN_PHASE7_COMPREFACE_MIGRATION
// L17): the revoke RPC clears the DB state + sets the flag; this script closes
// the loop once CompreFace is back.
//
// Run: node scripts/compreface-cleanup.mjs  (needs Supabase + CompreFace up)
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
const CF_BASE = env.COMPREFACE_BASE_URL ?? "http://localhost:8000";
const CF_KEY = env.COMPREFACE_API_KEY ?? "";

if (!URL || !SERVICE) {
  console.error("Missing .env.local keys (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  process.exit(1);
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

async function main() {
  const { data: pending, error } = await admin
    .from("profiles")
    .select("id")
    .eq("face_deletion_pending", true);
  if (error) {
    console.error("fetch pending:", error.message);
    process.exit(1);
  }
  console.log(`Found ${(pending ?? []).length} profile(s) with a pending CompreFace deletion.`);

  let ok = 0;
  let failed = 0;
  for (const p of pending ?? []) {
    try {
      const res = await fetch(`${CF_BASE}/api/v1/recognition/subjects/${encodeURIComponent(p.id)}`, {
        method: "DELETE",
        headers: { "x-api-key": CF_KEY },
        cache: "no-store",
      });
      // 404 = already gone → treat as success (idempotent).
      if (res.ok || res.status === 404) {
        await admin.from("profiles").update({ face_deletion_pending: false }).eq("id", p.id);
        console.log(`deleted subject ${p.id}`);
        ok++;
      } else {
        console.warn(`DELETE ${p.id} → HTTP ${res.status}`);
        failed++;
      }
    } catch (err) {
      console.warn(`DELETE ${p.id} → network error: ${err.message}`);
      failed++;
    }
  }
  console.log(`cleanup done: ${ok} deleted, ${failed} pending.`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
