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
 * Per-session clip ceiling (audit-4 P1-1): the 6/min per-USER rate limit
 * bounds request frequency but not per-session volume — a buggy retry loop
 * (or a tampered client) could otherwise push ~10 GB/hr into the bucket for
 * ONE session, each insert minting a fresh notification (the clip_id dedupe
 * key never repeats). 40 clips × ~9 MB ≈ 360 MB covers any legitimate
 * multi-incident attempt (pauses flag at 3 strikes; even adversarial
 * pause/recover cycling stays an order of magnitude below this) while capping
 * the worst-case storage and notification flood.
 */
const INCIDENT_SESSION_CLIP_CAP = 40;

async function sessionClipCount(
  admin: ReturnType<typeof createAdminClient>,
  sessionId: string,
): Promise<number | null> {
  const { count, error } = await admin
    .from("incident_clips")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId);
  if (error) {
    console.error("incident clip count error:", error);
    return null;
  }
  return count ?? 0;
}

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

  // Per-session cap (audit-4 P1-1): checked BEFORE the slow upload so a
  // saturated session is refused cheaply. A null count (count query failed)
  // fails OPEN — an outage must not block an integrity clip.
  const adminEarly = createAdminClient();
  const clipCount = await sessionClipCount(adminEarly, id);
  if (clipCount !== null && clipCount >= INCIDENT_SESSION_CLIP_CAP) {
    return Response.json(
      { error: "clip_cap_reached" },
      { status: 429, headers: { "content-type": "application/json" } },
    );
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
  // audit-2 L-10: a random suffix de-duplicates same-ms double-submits —
  // with upsert:false the loser used to 500 (clip lost) instead of storing
  // both forensic clips.
  const path = `${id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const admin = createAdminClient();

  // Per-session cap re-check (audit-4 P1-1): concurrent uploads can pass the
  // pre-upload count together — re-check after the buffer, before the storage
  // write, so the cap bounds steady-state volume (the window is narrow; a
  // final exact race is bounded by the 6/min rate limit and is benign).
  const clipCountLate = await sessionClipCount(admin, id);
  if (clipCountLate !== null && clipCountLate >= INCIDENT_SESSION_CLIP_CAP) {
    return Response.json(
      { error: "clip_cap_reached" },
      { status: 429, headers: { "content-type": "application/json" } },
    );
  }

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
    // audit-2 L-10: a failed remove used to be swallowed silently — log the
    // path so the ≤30-day SQL prune window is known to have started late.
    const { error: discardError } = await admin.storage.from("incident-footage").remove([path]);
    if (discardError) console.error("incident discard remove failed:", path, discardError);
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
      .catch(function ignoreRemoveFailure(err) {
        // audit-2 L-10: best-effort, but the failure must be visible — the
        // rowless object now lingers until the 30-day SQL prune.
        console.error("incident cleanup remove failed:", path, err);
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
