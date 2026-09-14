import { createClient } from "@/lib/supabase/server";
import { requireStudent } from "@/lib/classes/guards";
import { rateLimit } from "@/lib/classes/rate-limit";
import { EnrollSchema } from "@/lib/face/schemas";
import { MAX_FRAME_BASE64_CHARS } from "@/lib/face/constants";
import { mapFaceError } from "@/lib/face/rpc-mapping";
import { selectPrimaryFace } from "@/lib/face/embedding";
import { spoofGateDecision, type SpoofFrameVerdict } from "@/lib/face/spoof";
import * as insightface from "@/lib/face/server/insightface-client";
import {
  checkSameOrigin,
  firstIssueMessage,
  invalidBody,
  internalError,
  jsonError,
  MULTIPART_OVERHEAD_BYTES,
  payloadTooLarge,
  readCappedJson,
} from "@/lib/http";

export const dynamic = "force-dynamic";
// The enroll flow runs 3 sidecar extracts in parallel (~150ms each on CPU) +
// one RPC — a single extract + overhead budget.
export const maxDuration = 20;

// Per-user rate limit on enrollments (re-enroll churn guard).
const ENROLL_RATE = { limit: 5, windowMs: 60 * 1000 };

/**
 * POST /api/face/enroll — multi-angle enrollment via the InsightFace sidecar
 * (3 frames) with Supabase-native biometric storage.
 *
 * Preamble: guard → CSRF → rate-limit → parse → Zod → consent pre-check →
 * sidecar → `enroll_face(p_samples)` RPC → `mapFaceError`.
 *
 * Flow (0039):
 *  1. Validate 3 frames (front / left / right), each ≤ MAX_FRAME_BASE64_CHARS.
 *  2. Consent pre-check on `profiles.consent_given_at` — a non-consented
 *     student's biometric frames must NEVER be shipped to the sidecar (the
 *     RPC re-checks consent authoritatively inside the locked transaction).
 *  3. Per frame: sidecar `/extract` (ONE call yields pose + embedding) →
 *     pick the primary face (largest bbox, det_score ≥ floor) → validate
 *     pose (front |yaw| ≤ 30°, sides 10° ≤ |yaw| ≤ 75°). Reject → 400
 *     pose_invalid. NO face → 400 pose_invalid. The frame-level spoof
 *     verdicts are collected and judged with the same majority policy as the
 *     verify route — a majority-spoofed capture → 400 spoof_detected (audit-3
 *     E-F7: a poisoned baseline would otherwise be planted unchecked).
 *  4. RPC `enroll_face(p_samples jsonb)` — the RPC validates the samples,
 *     runs the INTERNAL duplicate check (max cosine vs other students'
 *     samples ≥ 0.45 → 'pending_review' else 'enrolled'), stores the 3
 *     samples delete-then-insert atomically, and writes the GUC-guarded
 *     status. There is NO route-side duplicate check and NO orphan rollback:
 *     the DB write is one atomic transaction (0010's "DB write last"
 *     invariant, enforced structurally).
 *
 * Mappings (bullets list ONLY overrides; common keys automatic):
 *  - `consent_required` → 403
 *  - `live_assessment` → 409
 *  - `invalid_samples` → 400
 *  - `insightface_unavailable` → 503
 *  - `pose_invalid` → 400
 *  - `spoof_detected` → 400 (majority-spoofed capture; audit-3 E-F7)
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

  // audit-1 P1-5: pre-parse bound — EnrollSchema takes exactly 3 frames,
  // each capped at MAX_FRAME_BASE64_CHARS; oversized chunked bodies used to
  // buffer in full before the per-frame check ran.
  const ENROLL_BODY_LIMIT_BYTES =
    3 * MAX_FRAME_BASE64_CHARS + MULTIPART_OVERHEAD_BYTES;
  const body = await readCappedJson(request, ENROLL_BODY_LIMIT_BYTES);
  if (!body.ok) return body.response;

  const parsed = EnrollSchema.safeParse(body.data);
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
  const angles: { frame: string; name: string }[] = [
    { frame: front, name: "front" },
    { frame: left, name: "left" },
    { frame: right, name: "right" },
  ];

  // Privacy gate: a NON-CONSENTED student's frames must never leave the
  // server — reject BEFORE any sidecar call (the RPC re-checks consent
  // authoritatively inside the locked transaction).
  const { data: profileRow } = await supabase
    .from("profiles")
    .select("consent_given_at")
    .eq("id", auth.userId)
    .maybeSingle();
  if (!profileRow || !profileRow.consent_given_at) {
    return (
      mapFaceError({ error: "consent_required" }, { consent_required: { status: 403 } }) ??
      internalError("Something went wrong.")
    );
  }

  // ── Stage timing instrumentation ──────────────────────────────────────
  // Every sidecar round-trip is measured and logged (dev console + the
  // `_timings` field on dev responses) so capture-latency complaints can be
  // attributed to a specific stage without terminal access. NEVER log
  // embeddings or similarities (biometric derivatives).
  const routeStart = Date.now();
  const timings: Record<string, number> = {};

  // 1. One-shot extraction: pose + embedding per frame in a single call.
  //    Pose validation is skipped in E2E mock mode (the mock returns yaw 0,
  //    which would fail every side check for a developer testing with a real
  //    webcam while the flag is on). Dev responses carry the measured yaws
  //    so a failing capture can be diagnosed from the UI error alone.
  const extractStart = Date.now();
  const extracts = await Promise.all(
    angles.map((a) => insightface.extractFace(a.frame, auth.userId)),
  );
  timings.extractBatchMs = Date.now() - extractStart;

  const samples: { angle: string; embedding: number[] }[] = [];
  const yaws: string[] = [];
  // audit-3 E-F7: the sidecar's spoof verdict was previously discarded at
  // enroll, so a replay/photo could plant a poisoned BASELINE and verify-time
  // enforcement was the only line left. Collect it here and apply the same
  // majority policy the verify route uses (lib/face/spoof.ts) — a spoofed
  // capture must not become a stored identity.
  const enrollSpoofVerdicts: SpoofFrameVerdict[] = [];
  for (let i = 0; i < extracts.length; i++) {
    const ex = extracts[i];
    const angleName = angles[i].name;
    if ("error" in ex) {
      return mapFaceError(ex) ?? internalError("Something went wrong.");
    }
    enrollSpoofVerdicts.push(ex.spoof ?? null);
    const primary = selectPrimaryFace(ex.faces);
    if (!primary) {
      console.error(`[enroll-timing] ${angleName}: NO FACE DETECTED after ${timings.extractBatchMs}ms batch`);
      return jsonError(
        "pose_invalid",
        process.env.NODE_ENV !== "production"
          ? `No face detected in the ${angleName} frame — retake with better light/less motion.`
          : undefined,
        400,
      );
    }
    yaws.push(`${angleName}=${primary.yaw}°`);

    // Pose gate on the sidecar's pose regression (front centered, sides
    // turned). In mock mode the marker frames carry yaw 0 for all angles —
    // skipping keeps E2E enrollment possible (sides need 10–75°).
    if (!insightface.isMockModeEnabled()) {
      const yaw = primary.yaw;
      if (angleName === "front" && Math.abs(yaw) > 30) {
        console.error(`[enroll-pose] FRONT out of range: ${angleName}=${yaw}°`);
        return jsonError(
          "pose_invalid",
          process.env.NODE_ENV !== "production" ? `Front frame too turned: front=${yaw}°` : undefined,
          400,
        );
      }
      if (angleName !== "front" && (Math.abs(yaw) < 10 || Math.abs(yaw) > 75)) {
        console.error(`[enroll-pose] SIDE out of range: ${angleName}=${yaw}°`);
        return jsonError(
          "pose_invalid",
          process.env.NODE_ENV !== "production"
            ? `Side frames need a clearer turn: ${angleName}=${yaw}°`
            : undefined,
          400,
        );
      }
    }

    samples.push({ angle: angleName, embedding: primary.embedding });
  }
  console.info(
    `[enroll-timing] extract x3 ${timings.extractBatchMs}ms — ${yaws.join(" ")} (server needs |front|≤30, sides within 10–75)`,
  );

  // audit-3 E-F7: reject a spoofed enrollment using the SAME majority policy
  // AND the SAME enforcement switch as the verify route. Without this the
  // enrollment path had no server-side liveness at all (blink liveness is
  // client-side only, and a scripted POST bypasses it), so a replay could
  // plant the baseline that every later verify is compared against — identity
  // substitution at the root.
  //
  // Gating on FACE_SPOOF_ENFORCE (adversarial review): verify treats the flag
  // as "record-only vs enforce" because a sidecar built before the weights
  // were baked returns no verdicts. Enforcing unconditionally here would make
  // that posture inconsistent — verify would record while enroll hard-failed —
  // and a single false-positive verdict (screen glare, dim lab lighting) would
  // permanently block a student's enrollment with no env remedy.
  const enrollSpoof = spoofGateDecision(enrollSpoofVerdicts);
  if (enrollSpoof.forcedFail) {
    const spoofEnforced = process.env.FACE_SPOOF_ENFORCE === "1";
    console.error(
      spoofEnforced
        ? "enroll: spoof gate rejected the capture"
        : "enroll: spoof verdicts detected but NOT enforced (FACE_SPOOF_ENFORCE != 1)",
      { ...enrollSpoof, scores: enrollSpoofVerdicts.map((v) => v?.score ?? null) },
    );
    if (spoofEnforced) {
      return jsonError(
        "spoof_detected",
        process.env.NODE_ENV !== "production"
          ? `The capture looks like a photo or screen replay (P(real) scores: ${enrollSpoofVerdicts
              .map((v) => (v ? v.score.toFixed(2) : "n/a"))
              .join(", ")}). Use a live camera.`
          : undefined,
        400,
      );
    }
  }

  // 2. Atomic enroll: validate → internal duplicate check → delete-then-
  //    insert samples → GUC-guarded status write, all inside ONE
  //    security-definer transaction (migration 0039).
  const rpcStart = Date.now();
  const { data, error } = await supabase.rpc("enroll_face", {
    p_samples: samples,
  });
  timings.rpcMs = Date.now() - rpcStart;
  timings.totalMs = Date.now() - routeStart;
  console.info(`[enroll-timing] rpc ${timings.rpcMs}ms, TOTAL ${timings.totalMs}ms`);

  if (error) {
    console.error("enroll_face error:", error);
    return internalError("Could not enroll right now.");
  }

  const payload = data as Record<string, unknown> | null;

  const mapped = mapFaceError(payload, {
    consent_required: { status: 403 },
    live_assessment: { status: 409 },
    invalid_samples: { status: 400 },
  });
  if (mapped) {
    // consent_required / live_assessment → the DB rejected the enrollment;
    // nothing to roll back — no samples were written outside the RPC's own
    // transaction.
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

  console.error("enroll_face unexpected payload:", payload);
  return internalError("Could not enroll right now.");
}
