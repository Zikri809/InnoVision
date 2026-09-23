import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireLecturer } from "@/lib/classes/guards";
import { rateLimit } from "@/lib/classes/rate-limit";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import {
  checkSameOrigin,
  firstIssueMessage,
  internalError,
  invalidBody,
  readCappedJson,
} from "@/lib/http";

export const dynamic = "force-dynamic";

// Per-lecturer review budget. Adjudicating a cohort's duplicate flags is a
// few dozen clicks; 30/min leaves room for a correction pass while bounding a
// scripted loop (mirrors the override route).
const REVIEW_RATE = { limit: 30, windowMs: 60 * 1000 };

/**
 * audit-5 M4: `decision` selects the RPC. approve → `approve_face_enrollment`
 * (0062 §6), reject → `reject_face_enrollment` (0010). Both are
 * lecturer-of-a-class-the-student-is-in only (single no-oracle 404) and
 * audited (`face_enroll_approved` / `face_enroll_rejected`).
 */
const ReviewSchema = z.object({
  studentId: z.string().uuid("studentId must be a valid UUID."),
  decision: z.enum(["approve", "reject"], {
    message: "decision must be 'approve' or 'reject'.",
  }),
});

/**
 * POST /api/face/enrollments/review — lecturer adjudicates a pending_review
 * (duplicate-detected) face enrollment.
 *
 * The dead end this closes (audit-5 M4): `reject_face_enrollment` existed
 * since 0010 but had NO route/UI caller, so a duplicate-flagged student could
 * never start an assessment (the start gate blocks pending_review), could
 * never verify (record_face_check gate 8), and re-enrolling re-flagged them.
 * Approve clears the flag (the samples are already stored); reject clears the
 * status so the student re-enrolls (and the dup scan will flag them again if
 * the face really is a duplicate — the lecturer's call).
 *
 * Preamble (house order): guard → CSRF → rate-limit → capped body → Zod → RPC.
 *
 * Mappings:
 *  - `not_owner` → 404 (no oracle: a foreign student id is indistinguishable
 *    from a missing one)
 *  - `not_pending` → 409 (approve of a non-pending enrollment — the student
 *    was already adjudicated or never enrolled)
 *  - transport error → 503
 *  - success → 200 `{ ok: true, status }`
 */
export async function POST(request: Request) {
  const supabase = await createClient();

  const auth = await requireLecturer(supabase);
  if (!auth.ok) return auth.response;

  const originError = checkSameOrigin(request);
  if (originError) return originError;

  if (!rateLimit(`face-enroll-review:${auth.userId}`, REVIEW_RATE)) {
    return mapFaceError({ error: "rate_limited" }) ?? internalError("Something went wrong.");
  }

  const body = await readCappedJson(request);
  if (!body.ok) return body.response;

  const parsed = ReviewSchema.safeParse(body.data);
  if (!parsed.success) {
    return invalidBody(firstIssueMessage(parsed.error.issues, "Invalid review payload."));
  }

  const { studentId, decision } = parsed.data;

  const { data, error } = await supabase.rpc(
    decision === "approve" ? "approve_face_enrollment" : "reject_face_enrollment",
    { p_student_id: studentId },
  );

  if (error) {
    console.error("face enrollment review error:", error);
    return internalError("Could not save the review right now.");
  }

  const payload = data as Record<string, unknown> | null;

  const mapped = mapFaceError(payload, {
    not_pending: { status: 409 },
  });
  if (mapped) return mapped;

  if (payload?.ok === true) {
    return NextResponse.json(
      { ok: true, status: decision === "approve" ? "enrolled" : null },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  console.error("face enrollment review unexpected payload:", payload);
  return internalError("Could not save the review right now.");
}
