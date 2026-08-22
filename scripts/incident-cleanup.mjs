// Incident-footage retention cleanup — deletes incident_clips rows AND their
// private Storage objects older than N days (default 30).
//
// Usage:
//   node scripts/incident-cleanup.mjs [--days 30] [--dry-run] [--remote]
//
// Reads .env.local (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).
// Companion to the SQL prune_expired_incident_clips() (migration 0020):
// storage.objects deletion from SQL needs cross-schema ownership this script
// handles cleanly through the Storage API instead. Cron-friendly.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env.local");
const args = process.argv.slice(2);
const daysIdx = args.indexOf("--days");
const DAYS = daysIdx >= 0 ? Number(args[daysIdx + 1]) || 30 : 30;
const DRY = args.includes("--dry-run");
const REMOTE = args.includes("--remote");

if (!fs.existsSync(envPath)) {
  console.error("Missing .env.local — cannot read Supabase keys.");
  process.exit(1);
}
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
if (!URL || !SERVICE) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  process.exit(1);
}
const isLocal = /localhost|127\.0\.0\.1/.test(URL);
if (!isLocal && !REMOTE) {
  console.error(`Refusing non-local target ${URL} without --remote.`);
  process.exit(1);
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const cutoff = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString();

const { data: clips, error } = await admin
  .from("incident_clips")
  .select("id, storage_path, recorded_to")
  .lt("recorded_to", cutoff)
  .limit(10_000);

if (error) {
  console.error("Query failed:", error.message);
  process.exit(1);
}

console.log(
  `${DRY ? "[dry-run] " : ""}incident clips older than ${DAYS}d (recorded_to < ${cutoff}): ${(clips ?? []).length}`,
);

let removed = 0;
for (const clip of clips ?? []) {
  if (!DRY) {
    const { error: rmError } = await admin.storage.from("incident-footage").remove([clip.storage_path]);
    if (rmError) {
      // 404-class failures are fine (object already gone) — still drop the row.
      console.warn(`  storage remove failed for ${clip.storage_path}: ${rmError.message}`);
    }
    const { error: delError } = await admin.from("incident_clips").delete().eq("id", clip.id);
    if (delError) {
      console.error(`  row delete failed for ${clip.id}: ${delError.message}`);
      continue;
    }
  }
  removed++;
}
console.log(`${DRY ? "Would delete" : "Deleted"} ${removed} clip(s).`);
