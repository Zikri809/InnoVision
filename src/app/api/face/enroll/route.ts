import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { rateLimit } from "@/lib/classes/rate-limit";
import { EnrollSchema } from "@/lib/face/schemas";
import { MAX_FRAME_BASE64_CHARS } from "@/lib/face/constants";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import * as compreface from "@/lib/face/server/compreface-client";
import {
  checkSameOrigin,
  firstIssueMessage,
  invalidBody,
  invalidJson,
  internalError,
  jsonError,
  payloadTooLarge,
} from "@/lib/http";

export const dynamic = "force-dynamic";
// The enroll flow runs up to 9 CompreFace calls (3× detect + 3× recognize +
// 3× addSubjectExample) — give it breathing room so a slow container isn't
// platform-killed into a 504.
export const maxDuration = 20;

// Per-user rate limit on enrollments (re-enroll churn guard).
const ENROLL_RATE = { limit: 5, windowMs: 60 * 1000 };

/**
 * POST /api/face/enroll — multi-angle CompreFace enrollment (3 frames).
 *
 * Preamble: guard → CSRF → rate-limit → parse → Zod → consent pre-check →
 * CompreFace → RPC → `mapFaceError`.
 *
 * Flow (L9/L10):
 *  1. Validate 3 frames (front / left / right), each ≤ MAX_FRAME_BASE64_CHARS.
 *  2. Consent pre-check on `profiles.consent_given_at` — a non-consented
 *     student's biometric frames must NEVER be shipped to CompreFace (the RPC
 *     re-checks consent authoritatively inside the transaction).
 *  3. Per frame: CompreFace `/detect` → validate pose (front |yaw| ≤ 30°,
 *     sides 10° ≤ |yaw| ≤ 75°). Reject → 400 pose_invalid.
 *  4. Duplicate check: CompreFace `/recognize` per frame → best NON-self match
 *     (subject ≠ auth.uid()) with similarity ≥ FACE_SUSPICION_MIN (0.45,
 *     applied in the RPC). Passed to `enroll_face` as p_duplicate_*.
 *  5. Per frame: CompreFace `addSubjectExample(auth.uid(), frame)`.
 *  6. RPC `enroll_face(p_duplicate_subject, p_duplicate_similarity)` — the
 *     RPC derives status ('enrolled' | 'pending_review').
 *
 * Mappings (bullets list ONLY overrides; common keys automatic):
 *  - `consent_required` → 403
 *  - `live_assessment` → 409
 *  - `invalid_frame` → 400
 *  - `compreface_unavailable` → 503
 *  - `pose_invalid` → 400
 *  - success → 200 `{ ok: true, status: 'enrolled'|'pending_review' }`
 */
export async function POST(request: Request) {
  const supabase = await createClient();

  const auth = await requireStudent(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`face-enroll:${auth.userId}`, ENROLL_RATE)) {
    return mapFaceError({ error: "rate_limited" }) ?? internalError("Something went wrong.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJson();
  }

  const parsed = EnrollSchema.safeParse(body);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid enrollment payload."));
  }

  // Body-size DoS guard (frameSchema caps each frame, but enforce explicitly).
  for (const frame of parsed.data.frames) {
    if (frame.length > MAX_FRAME_BASE64_CHARS) {
      return payloadTooLarge(`Frame exceeds the ${MAX_FRAME_BASE64_CHARS}-character limit.`);
    }
  }

  const [front, left, right] = parsed.data.frames;
  // Pose validation below enforces: front |yaw| ≤ 30°; sides 10° ≤ |yaw| ≤ 75°.
  const angles: { frame: string }[] = [
    { frame: front },
    { frame: left },
    { frame: right },
  ];

  // If a prior consent-revoke left a CompreFace subject pending deletion
  // (`face_deletion_pending=true` — the revoke-time CompreFace deletion never
  // ran), delete it BEFORE adding new examples. A FAILED delete must abort
  // enrollment (flag stays set for `compreface:cleanup`): adding new samples
  // on top of the undisclosed old subject would let the RPC clear the flag and
  // the revoked biometric data would never be removed.
  const { data: profileRow } = await supabase
    .from("profiles")
    .select("face_deletion_pending, face_enrollment_status, consent_given_at")
    .eq("id", auth.userId)
    .maybeSingle();

  // Privacy gate: a NON-CONSENTED student's frames must never leave the
  // server — reject BEFORE any CompreFace call (the RPC re-checks consent
  // authoritatively inside the locked transaction).
  if (!profileRow || !profileRow.consent_given_at) {
    return (
      mapFaceError({ error: "consent_required" }, { consent_required: { status: 403 } }) ??
      internalError("Something went wrong.")
    );
  }

  if (profileRow.face_deletion_pending === true) {
    const del = await compreface.deleteSubject(auth.userId);
    if ("error" in del) {
      return mapFaceError(del) ?? internalError("Could not enroll right now.");
    }
  }

  // ── Stage timing instrumentation ──────────────────────────────────────
  // Every CompreFace round-trip is measured and logged (dev console + the
  // `_timings` field on dev responses) so capture-latency complaints can be
  // attributed to a specific stage without terminal access.
  const routeStart = Date.now();
  const timings: Record<string, number> = {};
  const tick = (key: string, from: number) => {
    timings[key] = Date.now() - from;
    return timings[key];
  };

  // 1. Pose validation via CompreFace /detect (recognize with pose plugin).
  //    Skipped in E2E mock mode (marker frames OR the whole mock flag — the
  //    mock detect() returns yaw 0, which would fail every side check for a
  //    developer testing with a real webcam while the flag is on). Dev
  //    responses carry the measured yaws so a failing capture can be
  //    diagnosed from the UI error alone.
  if (!compreface.isMockMatchFrame(front) && !compreface.isMockModeEnabled()) {
    const detectStart = Date.now();
    const detections = await Promise.all(angles.map((a) => compreface.detect(a.frame)));
    timings.detectBatchMs = Date.now() - detectStart;
    const validDetections: { faces: { yaw: number }[] }[] = [];
    for (let i = 0; i < detections.length; i++) {
      const det = detections[i];
      const angleName = ["front", "left", "right"][i];
      if ("error" in det) return mapFaceError(det) ?? internalError("Something went wrong.");
      if (!det.faces || det.faces.length === 0) {
        console.error(`[enroll-timing] ${angleName}: NO FACE DETECTED after ${timings.detectBatchMs}ms batch`);
        return jsonError(
          "pose_invalid",
          process.env.NODE_ENV !== "production"
            ? `No face detected in the ${angleName} frame — retake with better light/less motion.`
            : undefined,
          400,
        );
      }
      validDetections.push(det);
    }
    const frontYaw = validDetections[0].faces[0].yaw;
    const leftYaw = validDetections[1].faces[0].yaw;
    const rightYaw = validDetections[2].faces[0].yaw;

    const yawDetail = `front=${frontYaw}° left=${leftYaw}° right=${rightYaw}° (server needs |front|≤30, sides within 10–75)`;
    console.info(`[enroll-timing] detect ${timings.detectBatchMs}ms — ${yawDetail}`);

    // Front: centered (|yaw| <= 30)
    if (Math.abs(frontYaw) > 30) {
      console.error(`[enroll-pose] FRONT out of range: ${yawDetail}`);
      return jsonError(
        "pose_invalid",
        process.env.NODE_ENV !== "production" ? `Front frame too turned: ${yawDetail}` : undefined,
        400,
      );
    }
    // Side angles: must have a clear head turn (|yaw| >= 10 and <= 75)
    if (
      Math.abs(leftYaw) < 10 ||
      Math.abs(leftYaw) > 75 ||
      Math.abs(rightYaw) < 10 ||
      Math.abs(rightYaw) > 75
    ) {
      console.error(`[enroll-pose] SIDE out of range: ${yawDetail}`);
      return jsonError(
        "pose_invalid",
        process.env.NODE_ENV !== "production" ? `Side frames need a clearer turn: ${yawDetail}` : undefined,
        400,
      );
    }
  }

  // 2. Duplicate-identity detection: best non-self match across all frames.
  //    In E2E mock mode the frame marker represents a clean self-enrollment —
  //    skip the duplicate check (the mock subject is not a real student).
  let dupSubject: string | null = null;
  let dupSimilarity = 0;
  if (!compreface.isMockMatchFrame(front) && !compreface.isMockModeEnabled()) {
    for (const [i, angle] of angles.entries()) {
      const recStart = Date.now();
      const rec = await compreface.recognize(angle.frame);
      tick(`recognize${i + 1}Ms`, recStart);
      if ("error" in rec) return mapFaceError(rec) ?? internalError("Something went wrong.");
      for (const s of rec.subjects) {
        if (s.subject !== auth.userId && s.similarity > dupSimilarity) {
          dupSubject = s.subject;
          dupSimilarity = s.similarity;
        }
      }
    }
    console.info(`[enroll-timing] recognize x3 — ${timings.recognize1Ms}/${timings.recognize2Ms}/${timings.recognize3Ms}ms, dup=${dupSubject ? `${dupSimilarity}` : "none"}`);
  }

  // 3. Add examples to the subject (multi-sample enrollment).
  // 4. Record enrollment status via the RPC (which derives enrolled/pending_review).
  //
  // ORPHAN ROLLBACK: the DB status is written LAST (authoritative). If a
  // mid-stage failure leaves examples in CompreFace without a DB status, a
  // later retry would KEEP APPENDING to the same subject. On any failure we
  // best-effort `deleteSubject(auth.uid())` so a partial/aborted enrollment
  // never leaves abandoned biometric samples behind.
  const rollback = () => void compreface.deleteSubject(auth.userId);
  try {
    for (const [i, angle] of angles.entries()) {
      const addStart = Date.now();
      const add = await compreface.addSubjectExample(auth.userId, angle.frame);
      timings[`addExample${i + 1}Ms`] = Date.now() - addStart;
      if ("error" in add) {
        rollback();
        return mapFaceError(add) ?? internalError("Something went wrong.");
      }
    }

    const rpcStart = Date.now();
    const { data, error } = await supabase.rpc("enroll_face", {
      p_duplicate_subject: dupSubject as string,
      p_duplicate_similarity: dupSimilarity,
    });
    timings.rpcMs = Date.now() - rpcStart;
    timings.totalMs = Date.now() - routeStart;
    console.info(
      `[enroll-timing] add x3 — ${timings.addExample1Ms}/${timings.addExample2Ms}/${timings.addExample3Ms}ms, rpc ${timings.rpcMs}ms, TOTAL ${timings.totalMs}ms`,
    );

    if (error) {
      rollback();
      console.error("enroll_face error:", error);
      return internalError("Could not enroll right now.");
    }

    const payload = data as Record<string, unknown> | null;

    const mapped = mapFaceError(payload, {
      consent_required: { status: 403 },
      live_assessment: { status: 409 },
    });
    if (mapped) {
      // consent_required / live_assessment → the DB rejected the enrollment;
      // the CompreFace examples just added would be orphaned → clean them up.
      rollback();
      return mapped;
    }

    if (payload?.ok === true) {
      const status = payload.status === "pending_review" ? "pending_review" : "enrolled";
      return Response.json(
        {
          ok: true,
          status,
          // Dev-only: stage timings ride along so the browser probe (or the
          // network tab) can attribute capture latency without terminal access.
          ...(process.env.NODE_ENV !== "production" ? { _timings: timings } : {}),
        },
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    rollback();
    console.error("enroll_face unexpected payload:", payload);
    return internalError("Could not enroll right now.");
  } catch {
    rollback();
    return internalError("Could not enroll right now.");
  }
}
