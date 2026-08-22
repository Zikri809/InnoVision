// Dev script to wipe all face recognition data (CompreFace + Supabase DB)
// Run: npm run face:reset
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalTarget } from "./lib/target-guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env.local");

let env = {};
if (fs.existsSync(envPath)) {
  env = fs
    .readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.trim().startsWith("#"))
    .reduce((acc, l) => {
      const idx = l.indexOf("=");
      if (idx > 0) acc[l.slice(0, idx).trim()] = l.slice(idx + 1).trim();
      return acc;
    }, {});
}

const URL = env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:58021";
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const CF_BASE = env.COMPREFACE_BASE_URL || process.env.COMPREFACE_BASE_URL || "http://localhost:8000";
const CF_KEY = env.COMPREFACE_API_KEY || process.env.COMPREFACE_API_KEY || "";

async function main() {
  console.log("🧹 [face:reset] Starting complete face recognition cleanup...\n");

  // 1. Clear CompreFace subjects & image collections
  if (CF_KEY) {
    console.log(`Connecting to CompreFace at ${CF_BASE}...`);
    try {
      const res = await fetch(`${CF_BASE}/api/v1/recognition/subjects`, {
        headers: { "x-api-key": CF_KEY },
        cache: "no-store",
      });
      if (res.ok) {
        const json = await res.json();
        const subjects = json.subjects || [];
        console.log(`Found ${subjects.length} subject(s) in CompreFace.`);
        for (const s of subjects) {
          const delRes = await fetch(`${CF_BASE}/api/v1/recognition/subjects/${encodeURIComponent(s)}`, {
            method: "DELETE",
            headers: { "x-api-key": CF_KEY },
            cache: "no-store",
          });
          console.log(`  - Deleted subject '${s}' (HTTP ${delRes.status})`);
        }
      } else {
        console.warn(`  ⚠️ CompreFace returned status ${res.status}`);
      }
    } catch (err) {
      console.warn(`  ⚠️ Could not connect to CompreFace (${err.message}). Skipping CompreFace wipe.`);
    }
  } else {
    console.log("  ℹ️ COMPREFACE_API_KEY not set. Skipping CompreFace API calls.");
  }

  // 2. Clear Supabase database records
  if (SERVICE) {
    console.log(`\nConnecting to Supabase at ${URL}...`);
    const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

    // Clear face_checks table
    try {
      const { error: cErr } = await admin
        .from("face_checks")
        .delete()
        .neq("id", "00000000-0000-0000-0000-000000000000");
      if (cErr) {
        console.warn("  ⚠️ Could not clear face_checks:", cErr.message);
      } else {
        console.log("  ✓ Cleared face_checks verification logs");
      }
    } catch (err) {
      console.warn("  ⚠️ face_checks wipe skipped:", err.message);
    }

    // Clear integrity-suite artifacts: advisories + incident clips (+ storage)
    try {
      const { error: aErr } = await admin
        .from("session_advisories")
        .delete()
        .neq("id", "00000000-0000-0000-0000-000000000000");
      console.log(aErr ? `  ⚠️ Could not clear session_advisories: ${aErr.message}` : "  ✓ Cleared session_advisories");
    } catch (err) {
      console.warn("  ⚠️ session_advisories wipe skipped:", err.message);
    }
    try {
      const { data: clips } = await admin
        .from("incident_clips")
        .select("id, storage_path")
        .neq("id", "00000000-0000-0000-0000-000000000000");
      if (clips && clips.length > 0) {
        const paths = clips.map((c) => c.storage_path);
        const { error: rmErr } = await admin.storage.from("incident-footage").remove(paths);
        if (rmErr) console.warn("  ⚠️ Storage remove failed:", rmErr.message);
        const { error: dErr } = await admin
          .from("incident_clips")
          .delete()
          .neq("id", "00000000-0000-0000-0000-000000000000");
        console.log(dErr ? `  ⚠️ Could not clear incident_clips: ${dErr.message}` : `  ✓ Cleared ${clips.length} incident clip(s) + storage objects`);
      } else {
        console.log("  ✓ No incident clips to clear");
      }
    } catch (err) {
      console.warn("  ⚠️ incident_clips wipe skipped:", err.message);
    }

    // Reset focus-loss counters on live sessions
    try {
      const { error: fErr } = await admin
        .from("quiz_sessions")
        .update({ focus_pause_count: 0 })
        .neq("id", "00000000-0000-0000-0000-000000000000");
      console.log(fErr ? `  ⚠️ Could not reset focus_pause_count: ${fErr.message}` : "  ✓ Reset focus_pause_count");
    } catch {
      /* column may predate the migration — non-fatal */
    }

    // Reset profile face fields
    try {
      const { error: pErr } = await admin
        .from("profiles")
        .update({
          consent_given_at: null,
          face_deletion_pending: false,
        })
        .neq("id", "00000000-0000-0000-0000-000000000000");
      if (pErr) {
        console.warn("  ⚠️ Could not update profile consents:", pErr.message);
      } else {
        console.log("  ✓ Reset profile consent flags");
      }
    } catch (err) {
      console.warn("  ⚠️ profile consent reset skipped:", err.message);
    }
  }

  console.log("\n✨ [face:reset] Done! All face recognition traces have been reset.");
}

main();
