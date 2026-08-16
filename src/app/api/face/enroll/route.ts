import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { rateLimit } from "@/lib/classes/rate-limit";
import { EnrollSchema } from "@/lib/face/schemas";
import { ENROLL_ANGLE_YAW_RANGE, MAX_FRAME_BASE64_CHARS } from "@/lib/face/constants";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import * as compreface from "@/lib/face/server/compreface-client";
import {
  checkSameOrigin,
  firstIssueMessage,
  invalidBody,
  invalidJson,
  internalError,
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
 * Preamble: guard → CSRF → rate-limit → parse → Zod → CompreFace →
 * RPC → `mapFaceError`.
 *
 * Flow (L9/L10):
 *  1. Validate 3 frames (front / left / right), each ≤ MAX_FRAME_BASE64_CHARS.
 *  2. Per frame: CompreFace `/detect` → validate pose (front |yaw|<25°,
 *     left +25..60°, right -60..-25°). Reject → 400 pose_invalid.
 *  3. Duplicate check: CompreFace `/recognize` per frame → best NON-self match
 *     (subject ≠ auth.uid()) with similarity ≥ FACE_SUSPICION_MIN (0.45,
 *     applied in the RPC). Passed to `enroll_face` as p_duplicate_*.
 *  4. Per frame: CompreFace `addSubjectExample(auth.uid(), frame)`.
 *  5. RPC `enroll_face(p_duplicate_subject, p_duplicate_similarity)` — the
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
  const SIDE = ENROLL_ANGLE_YAW_RANGE; // { min: 25, max: 60 } — the side-angle magnitude
  const angles: { frame: string; expectedYaw: { min: number; max: number } }[] = [
    { frame: front, expectedYaw: { min: -SIDE.min, max: SIDE.min } },
    { frame: left, expectedYaw: { min: SIDE.min, max: SIDE.max } },
    { frame: right, expectedYaw: { min: -SIDE.max, max: -SIDE.min } },
  ];

  // If a prior consent-revoke left a CompreFace subject pending deletion
  // (`face_deletion_pending=true` — the revoke-time CompreFace deletion never
  // ran), delete it BEFORE adding new examples. A FAILED delete must abort
  // enrollment (flag stays set for `compreface:cleanup`): adding new samples
  // on top of the undisclosed old subject would let the RPC clear the flag and
  // the revoked biometric data would never be removed.
  const { data: profileRow } = await supabase
    .from("profiles")
    .select("face_deletion_pending, face_enrollment_status")
    .eq("id", auth.userId)
    .maybeSingle();
  if (profileRow && profileRow.face_deletion_pending === true) {
    const del = await compreface.deleteSubject(auth.userId);
    if ("error" in del) {
      return mapFaceError(del) ?? internalError("Could not enroll right now.");
    }
  }

  // 1. Pose validation via CompreFace /detect. Skipped in E2E mock mode (the
  //    fake tracker returns the same marker for all angles, so yaw is 0).
  if (!compreface.isMockMatchFrame(front)) {
    for (const angle of angles) {
      const det = await compreface.detect(angle.frame);
      if ("error" in det) return mapFaceError(det) ?? internalError("Something went wrong.");
      const face = det.faces[0];
      if (!face) {
        return mapFaceError({ error: "pose_invalid" }) ?? internalError("Something went wrong.");
      }
      if (face.yaw < angle.expectedYaw.min || face.yaw > angle.expectedYaw.max) {
        return mapFaceError({ error: "pose_invalid" }) ?? internalError("Something went wrong.");
      }
    }
  }

  // 2. Duplicate-identity detection: best non-self match across all frames.
  //    In E2E mock mode the frame marker represents a clean self-enrollment —
  //    skip the duplicate check (the mock subject is not a real student).
  let dupSubject: string | null = null;
  let dupSimilarity = 0;
  if (!compreface.isMockMatchFrame(front)) {
    for (const angle of angles) {
      const rec = await compreface.recognize(angle.frame);
      if ("error" in rec) return mapFaceError(rec) ?? internalError("Something went wrong.");
      for (const s of rec.subjects) {
        if (s.subject !== auth.userId && s.similarity > dupSimilarity) {
          dupSubject = s.subject;
          dupSimilarity = s.similarity;
        }
      }
    }
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
    for (const angle of angles) {
      const add = await compreface.addSubjectExample(auth.userId, angle.frame);
      if ("error" in add) {
        rollback();
        return mapFaceError(add) ?? internalError("Something went wrong.");
      }
    }

    const { data, error } = await supabase.rpc("enroll_face", {
      p_duplicate_subject: dupSubject as string,
      p_duplicate_similarity: dupSimilarity,
    });

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
      return Response.json(
        { ok: true, status: payload.status === "pending_review" ? "pending_review" : "enrolled" },
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
