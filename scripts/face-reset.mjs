// Dev script to wipe all face recognition data (Supabase DB; the InsightFace
// sidecar is stateless — nothing to wipe there)
// Run: npm run face:reset [-- --remote]
//   --remote targets the hosted project (.env.production.local) — still requires
//   ALLOW_PROD_SEED=1 or an interactive confirm.
import { createClient } from "@supabase/supabase-js";
import { resolveEnv, confirmRemote } from "./lib/remote-env.mjs";

const { URL, SERVICE, isRemote } = resolveEnv(process.argv);
if (isRemote) await confirmRemote("WIPE all face-recognition data");
async function main() {
  console.log(`🧹 [face:reset] Target: ${URL}\nStarting complete face recognition cleanup...\n`);

  // 1. Clear Supabase database records
  {
    const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

    // Clear enrolled biometric samples (0039) — service_role bypasses the
    // deny-by-default RLS on profile_face_samples.
    try {
      const { error: sErr } = await admin
        .from("profile_face_samples")
        .delete()
        .neq("id", "00000000-0000-0000-0000-000000000000");
      if (sErr) {
        console.warn("  ⚠️ Could not clear profile_face_samples:", sErr.message);
      } else {
        console.log("  ✓ Cleared profile_face_samples (biometric vectors)");
      }
    } catch (err) {
      console.warn("  ⚠️ profile_face_samples wipe skipped:", err.message);
    }

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
