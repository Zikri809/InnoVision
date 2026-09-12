import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStudent } from "@/lib/classes/guards";
import { isUuid } from "@/lib/classes/roster";
import { rateLimit } from "@/lib/classes/rate-limit";
import { MAX_INCIDENT_BYTES } from "@/lib/face/constants";
import {
  checkSameOrigin,
  internalError,
  invalidBody,
  MULTIPART_OVERHEAD_BYTES,
  notFound,
  payloadTooLarge,
  readCappedFormData,
} from "@/lib/http";

export const dynamic = "force-dynamic";
// A ~5-minute WebM at 250 kbps is ≈9 MB; give the upload + storage write room.
export const maxDuration = 60;

const INCIDENT_RATE = { limit: 6, windowMs: 60 * 1000 };

/**
 * POST /api/sessions/[id]/incident — upload a ring-buffer clip (video+audio
 * WebM) captured BEFORE an integrity incident (paused / flagged /
 * unavailable).
 *
 * Privacy contract: the client holds footage in memory and uploads ONLY on
 * incidents — a clean session never sends a byte. The route stores the blob
 * in the PRIVATE `incident-footage` bucket (no client policies — access is
 * exclusively route-mediated via the service-role key) and records the
 * `incident_clips` row the lecturer results view lists.
 */
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient();
  const { id } = await params;

  if (!isUuid(id)) return notFound();

  const auth = await requireStudent(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`session-incident:${auth.userId}`, INCIDENT_RATE)) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { "content-type": "application/json" } },
    );
  }

  // Owner + assessment + still-collectable status check through the USER
  // session (RLS-scoped) — the admin client below must never be the
  // ownership authority. Completed/closed quizzes stop accepting clips
  // (post-submit storage-bloat channel).
  const { data: session } = await supabase
    .from("quiz_sessions")
    .select("id, mode, student_id, status")
    .eq("id", id)
    .maybeSingle();
  if (!session || session.student_id !== auth.userId) return notFound();
  if (session.mode !== "assessment") {
    return invalidBody("Incident clips are only recorded for assessments.");
  }
  if (!["active", "paused", "flagged"].includes(session.status as string)) {
    return invalidBody("This session no longer accepts incident clips.");
  }

  // audit-1 P1-5: STREAM-SAFE cap. formData() buffers the whole multipart
  // body, and the old content-length pre-check was spoofable (chunked
  // transfers carry no header) — a lying request could buffer gigabytes
  // before the per-file size check ever ran. The capped reader pipes the
  // body through a counting stream that aborts at the limit.
  const formRead = await readCappedFormData(
    request,
    MAX_INCIDENT_BYTES + MULTIPART_OVERHEAD_BYTES,
  );
  if (!formRead.ok) return formRead.response;
  const form = formRead.form;

  const clip = form.get("clip");
  const reason = String(form.get("reason") ?? "unknown").slice(0, 40);
  const durationMsRaw = Number(form.get("durationMs") ?? 0);
  const recordedFromRaw = String(form.get("recordedFrom") ?? "");
  if (!(clip instanceof Blob)) {
    return invalidBody("A `clip` file is required.");
  }
  if (clip.size === 0) return invalidBody("The clip is empty.");
  if (clip.size > MAX_INCIDENT_BYTES) {
    return payloadTooLarge(`Clip exceeds the ${MAX_INCIDENT_BYTES}-byte limit.`);
  }
  const durationMs = Number.isFinite(durationMsRaw)
    ? Math.max(0, Math.min(Math.round(durationMsRaw), 3_600_000))
    : 0;
  const fromMs = Date.parse(recordedFromRaw);

  const buffer = Buffer.from(await clip.arrayBuffer());
  // Magic-byte sniff (not the client-declared MIME): arbitrary bytes must not
  // land in storage as "video". WebM/EBML starts 0x1A45DFA3; MP4 has a "ftyp"
  // box at offset 4. Anything else is rejected — a mislabeled payload would
  // otherwise be stored and served as a video that never plays.
  const isWebm =
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3;
  const isMp4 =
    buffer.length >= 8 &&
    buffer.toString("latin1", 4, 8) === "ftyp";
  if (!isWebm && !isMp4) {
    return invalidBody("The clip is not a recognized video container.");
  }
  // Trust the ACTUAL container the browser produced (Safari → mp4 when WebM
  // is unsupported); storing mp4 bytes under a .webm path breaks playback.
  const ext = isMp4 ? "mp4" : "webm";
  const contentType = isMp4 ? "video/mp4" : "video/webm";
  const path = `${id}/${Date.now()}.${ext}`;
  const admin = createAdminClient();

  const { error: uploadError } = await admin.storage
    .from("incident-footage")
    .upload(path, buffer, { contentType, upsert: false });
  if (uploadError) {
    console.error("incident upload error:", uploadError);
    return internalError("Could not store the incident clip right now.");
  }

  // audit-1 P1-4 (TOCTOU): the collectable-status gate ran BEFORE the slow
  // multipart buffer + storage upload (seconds of wall clock, maxDuration
  // 60). Re-select through the USER client now — if the session stopped
  // collecting in that window (submit / reset / removal), discard the
  // freshly-uploaded object and refuse; post-submit clips must not land.
  const { data: recheck } = await supabase
    .from("quiz_sessions")
    .select("student_id, mode, status")
    .eq("id", id)
    .maybeSingle();
  const stillCollectable =
    recheck &&
    recheck.student_id === auth.userId &&
    recheck.mode === "assessment" &&
    ["active", "paused", "flagged"].includes(recheck.status as string);
  if (!stillCollectable) {
    // Orphan cleanup (best-effort, same posture as the insert-failure arm).
    await admin.storage.from("incident-footage").remove([path]);
    return invalidBody("This session no longer accepts incident clips.");
  }

  const { error: insertError } = await admin.from("incident_clips").insert({
    session_id: id,
    storage_path: path,
    reason,
    duration_ms: durationMs,
    recorded_from: Number.isFinite(fromMs) ? new Date(fromMs).toISOString() : undefined,
  });
  if (insertError) {
    // Best-effort orphan cleanup — metadata rows drive lecturer visibility,
    // so an unlisted object is dead weight. (Named handler so the function
    // registers on the coverage report too — a bare `() => {}` is a second
    // anonymous function the per-file gate has to chase.)
    await admin.storage
      .from("incident-footage")
      .remove([path])
      .catch(function ignoreRemoveFailure() {
        /* cleanup is best-effort — the 503 below is the operator signal */
      });
    console.error("incident insert error:", insertError);
    return internalError("Could not store the incident clip right now.");
  }

  return Response.json(
    { ok: true },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

type Params = { params: Promise<{ id: string }> };
