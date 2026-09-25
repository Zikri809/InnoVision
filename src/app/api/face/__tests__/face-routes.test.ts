import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { FakeSupabase, makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { _resetRateLimiter, _seedRateLimit } from "@/lib/classes/rate-limit";
import * as enrollRoute from "@/app/api/face/enroll/route";
import * as verifyRoute from "@/app/api/face/verify/route";
import * as selfRecoverRoute from "@/app/api/face/self-recover/route";
import * as consentRoute from "@/app/api/face/consent/route";
import * as unlockRoute from "@/app/api/face/unlock/route";
import * as exemptRoute from "@/app/api/sessions/[id]/exempt-face/route";
import * as pauseRoute from "@/app/api/sessions/[id]/pause/route";
import * as sessionAdvisoryRoute from "@/app/api/sessions/[id]/advisory/route";
import * as sessionGetRoute from "@/app/api/sessions/[id]/route";
import * as healthRoute from "@/app/api/face/health/route";
import { EMBEDDING_DIMS } from "@/lib/face/embedding";

const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
// Counts admin `from().update()` calls — the verify route's ONLY admin-table
// write is the face_verify_attempted_at touch, so this pins exactly when the
// outage-claim exemption stamp fires (stale-nonce replays must NOT stamp).
const adminTouchCount: { current: number } = { current: 0 };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

// 0045 P0-1: the verify route reads the HMAC secret through the admin
// client's service_role-only getter. Unit tests pin the route's proof
// plumbing (secret fetch + mint + arg pass-through) with a deterministic
// secret; the FakeSupabase record_face_check stub ignores the proof value.
// audit-2 C-02: the route also touches quiz_sessions.face_verify_attempted_at
// through the admin client (fire-and-forget) — the mock resolves it silently.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (name: string) =>
      name === "get_verify_proof_secret"
        ? Promise.resolve({ data: "unit-test-verify-proof-secret", error: null })
        : Promise.resolve({ data: null, error: { message: `unexpected admin rpc: ${name}` } }),
    from: () => {
      adminTouchCount.current += 1;
      return {
        update: () => ({
          eq: () => Promise.resolve({ data: null, error: null }),
        }),
      };
    },
  }),
}));

// Mock the InsightFace client so unit tests never touch Docker. Tests control
// the responses via the mutable `insightfaceMock`.
const insightfaceMock = {
  extractFace: vi.fn(),
  health: vi.fn(),
  isMockMatchFrame: (f: string) => f.includes("FAKE_FRAME_MATCH"),
  isMockMismatchFrame: (f: string) => f.includes("FAKE_FRAME_MISMATCH"),
  isMockModeEnabled: () => process.env.FACE_MOCK_ENABLED === "1",
};
vi.mock("@/lib/face/server/insightface-client", () => ({
  extractFace: (...a: unknown[]) => insightfaceMock.extractFace(...a),
  health: (...a: unknown[]) => insightfaceMock.health(...a),
  isMockMatchFrame: (f: string) => f.includes("FAKE_FRAME_MATCH"),
  isMockMismatchFrame: (f: string) => f.includes("FAKE_FRAME_MISMATCH"),
  isMockModeEnabled: () => process.env.FACE_MOCK_ENABLED === "1",
}));

const enroll = enrollRoute;
const verify = verifyRoute;
const selfRecover = selfRecoverRoute;
const consent = consentRoute;
const unlock = unlockRoute;
const exempt = exemptRoute;
const pause = pauseRoute;
const sessionGet = sessionGetRoute;
const health = healthRoute;

const QUIZ_C = "00000000-0000-4000-8000-00000000000c";
const SESSION_ID = "00000000-0000-4000-8000-0000000000aa";
const STUDENT_ID = "00000000-0000-4000-8000-0000000000ff";
const LECTURER_ID = "00000000-0000-4000-8000-00000000000a";
const NONCE = "11111111-1111-4111-8111-111111111111";

const MATCH_FRAME = "data:image/jpeg;base64,FAKE_FRAME_MATCH";
// Enroll frames carry the MATCH marker so the route's mock-aware pose-skip
// path is exercised (mirrors the E2E fake tracker).
const FRONT_FRAME = "data:image/jpeg;base64,FAKE_FRAME_MATCH_FRONT";
const LEFT_FRAME = "data:image/jpeg;base64,FAKE_FRAME_MATCH_LEFT";
const RIGHT_FRAME = "data:image/jpeg;base64,FAKE_FRAME_MATCH_RIGHT";

/** Deterministic 512-vector for tests (unit norm). */
function testVector(seed: number): number[] {
  const v = new Array(EMBEDDING_DIMS).fill(0);
  v[seed % EMBEDDING_DIMS] = 1;
  return v;
}
const SELF_VECTOR = testVector(7);

/** The default mock extraction: one high-confidence centered face. */
function mockFace(embedding: number[] = SELF_VECTOR) {
  return {
    embedding,
    yaw: 0,
    pitch: 0,
    roll: 0,
    det_score: 0.99,
    bbox: [160, 96, 480, 432] as [number, number, number, number],
  };
}

function req(body?: unknown, init?: RequestInit): Request {
  return new Request("http://localhost", {
    method: init?.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function verifyReq(overrides?: Record<string, unknown>) {
  return req({
    frames: [MATCH_FRAME],
    trigger: "periodic",
    nonce: NONCE,
    sessionId: SESSION_ID,
    ...overrides,
  });
}

/** Seed the student's biometric baseline (what enroll would have stored). */
function seedBaseline(ctx: ReturnType<typeof makeOwnerContext>, uid = STUDENT_ID, embedding = SELF_VECTOR) {
  ctx.client.tables["profile_face_samples"] = [
    { id: "s1", profile_id: uid, angle: "front", embedding, created_at: "2026-01-01T00:00:00Z" },
    { id: "s2", profile_id: uid, angle: "left", embedding, created_at: "2026-01-01T00:00:00Z" },
    { id: "s3", profile_id: uid, angle: "right", embedding, created_at: "2026-01-01T00:00:00Z" },
  ];
}

/** A live assessment context with the student enrolled + consented + seeded. */
function faceContext(opts?: {
  status?: string;
  enrolled?: boolean;
  consented?: boolean;
  faceExempt?: boolean;
  seedSession?: boolean;
  withBaseline?: boolean;
}) {
  const ctx = makeOwnerContext({ quizStatus: "live" });
  const quizRow = ctx.client.tables["quizzes"]![0];
  quizRow.mode = "assessment";
  ctx.client.setUser(STUDENT_ID, "student");
  ctx.client.seedProfile({
    id: STUDENT_ID,
    role: "student",
    consent_given_at: opts?.consented === false ? null : "2026-01-01T00:00:00Z",
    face_enrollment_status: opts?.enrolled === false ? null : "enrolled",
  });
  if (opts?.seedSession !== false) {
    ctx.client.seedSession({
      id: SESSION_ID,
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "assessment",
      status: opts?.status ?? "active",
      verify_nonce: NONCE,
      face_exempt: opts?.faceExempt ?? false,
      face_fail_streak: 0,
    });
  }
  if (opts?.withBaseline !== false) {
    seedBaseline(ctx);
  }
  fakeHolder.current = ctx.client;
  return ctx;
}

function lecturerContext() {
  const ctx = makeOwnerContext({ quizStatus: "live" });
  const quizRow = ctx.client.tables["quizzes"]![0];
  quizRow.mode = "assessment";
  ctx.client.seedSession({
    id: SESSION_ID,
    quiz_id: QUIZ_C,
    student_id: STUDENT_ID,
    mode: "assessment",
    status: "flagged",
    verify_nonce: NONCE,
  });
  fakeHolder.current = ctx.client;
  return ctx;
}

beforeAll(() => {
  // The InsightFace client is module-mocked; these env vars are not strictly
  // needed for the mocked path but keep the routes' env reads from throwing.
  process.env.INSIGHTFACE_BASE_URL = "http://localhost:8000";
  process.env.FACE_MOCK_ENABLED = "1";
});

afterAll(() => {
  delete process.env.INSIGHTFACE_BASE_URL;
  delete process.env.FACE_MOCK_ENABLED;
});

beforeEach(() => {
  fakeHolder.current = undefined;
  adminTouchCount.current = 0;
  _resetRateLimiter();
  vi.clearAllMocks();
  // Default InsightFace behavior: match frame → one self face, health ok.
  insightfaceMock.extractFace.mockImplementation(async () => ({
    faces: [mockFace()],
  }));
  insightfaceMock.health.mockResolvedValue(true);
});

describe("I1 — enroll requires consent", () => {
  it("returns 403 consent_required when consent is null", async () => {
    faceContext({ consented: false, seedSession: false });
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("consent_required");
    // Frames must never reach the sidecar for a non-consented student.
    expect(insightfaceMock.extractFace).not.toHaveBeenCalled();
  });
});

describe("I2 — enroll stores 3 samples + sets enrolled status", () => {
  it("returns 200 { ok:true, status:enrolled } and writes the samples", async () => {
    const ctx = faceContext({ seedSession: false, withBaseline: false });
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("enrolled");
    expect(insightfaceMock.extractFace).toHaveBeenCalledTimes(3);
    const samples = ctx.client.tables["profile_face_samples"]!;
    expect(samples).toHaveLength(3);
    expect(new Set(samples.map((s) => s.angle))).toEqual(new Set(["front", "left", "right"]));
    expect(samples.every((s) => s.profile_id === STUDENT_ID)).toBe(true);
    const profile = ctx.client.tables["profiles"]!.find((p) => p.id === STUDENT_ID);
    expect(profile?.face_enrollment_status).toBe("enrolled");
  });
});

describe("I3 — enroll rejects invalid frames / poses", () => {
  it("returns 400 for wrong frame count", async () => {
    faceContext({ seedSession: false });
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME] }));
    expect(res.status).toBe(400);
  });

  it("returns 413 for an oversized frame", async () => {
    faceContext({ seedSession: false });
    const res = await enroll.POST(req({ frames: ["x".repeat(200_001), LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(413);
  });

  it("returns 400 pose_invalid when no face is detected", async () => {
    faceContext({ seedSession: false });
    insightfaceMock.extractFace.mockResolvedValue({ faces: [] });
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("pose_invalid");
  });

  it("a sidecar fan-out throw → typed JSON 503 (never an HTML 500)", async () => {
    faceContext({ seedSession: false });
    insightfaceMock.extractFace.mockRejectedValueOnce(new Error("sidecar exploded"));
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("insightface_unavailable");
  });

  it("byte-identical frames across angles → 400 duplicate_frames (same-photo-x3 plant)", async () => {
    faceContext({ seedSession: false });
    // Real-mode only: in mock mode marker frames are test scaffolding.
    const prevFlag = process.env.FACE_MOCK_ENABLED;
    delete process.env.FACE_MOCK_ENABLED;
    try {
      const same = "data:image/jpeg;base64,PLAIN_SAME_PHOTO";
      const res = await enroll.POST(req({ frames: [same, same, same] }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("duplicate_frames");
      // Rejected before any biometric leaves the server.
      expect(insightfaceMock.extractFace).not.toHaveBeenCalled();
    } finally {
      if (prevFlag === undefined) delete process.env.FACE_MOCK_ENABLED;
      else process.env.FACE_MOCK_ENABLED = prevFlag;
    }
  });

  it("returns 400 pose_invalid when the side yaw is out of range (real mode)", async () => {
    faceContext({ seedSession: false });
    // Real-mode simulation: pose validation only runs OUTSIDE mock mode
    // (the route skips it entirely while FACE_MOCK_ENABLED=1 because the
    // mocked frames all carry yaw 0).
    const prevFlag = process.env.FACE_MOCK_ENABLED;
    delete process.env.FACE_MOCK_ENABLED;
    try {
      insightfaceMock.extractFace.mockImplementation(async (frame: string) => {
        if (frame.includes("LEFT")) return { faces: [mockFace().yaw !== undefined ? { ...mockFace(), yaw: 5 } : mockFace()] };
        if (frame.includes("RIGHT")) return { faces: [{ ...mockFace(), yaw: -40 }] };
        return { faces: [{ ...mockFace(), yaw: 0 }] };
      });
      const res = await enroll.POST(
        req({ frames: ["data:image/jpeg;base64,PLAIN_F", "data:image/jpeg;base64,PLAIN_L", "data:image/jpeg;base64,PLAIN_R"] }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("pose_invalid");
    } finally {
      if (prevFlag === undefined) delete process.env.FACE_MOCK_ENABLED;
      else process.env.FACE_MOCK_ENABLED = prevFlag;
    }
  });
});

/**
 * Prod incident 2026-09-21 (session cfb12aef) — enrollment pose gate.
 *
 * The student's calibrated neutral sat ~40° off the sidecar's absolute zero
 * (off-axis webcam). The client guided them in NEUTRAL-RELATIVE yaw while the
 * route gated on ABSOLUTE yaw, producing four `pose_invalid` rejections
 * (`FRONT out of range: front=-49.09°`, `SIDE out of range: left=-1.52°`, …)
 * with no actionable message. These tests pin the reconciliation and the
 * anti-tamper bounds that replace it.
 */
describe("enroll pose gate — client/server yaw reconciliation (prod 2026-09-21)", () => {
  /** Run a real-mode (non-mock) enroll with scripted sidecar yaws per angle. */
  async function enrollWithYaws(
    absoluteYaws: [number, number, number],
    yawReadings?: (number | null)[],
  ) {
    faceContext({ seedSession: false, withBaseline: false });
    const prevFlag = process.env.FACE_MOCK_ENABLED;
    delete process.env.FACE_MOCK_ENABLED;
    try {
      let call = 0;
      insightfaceMock.extractFace.mockImplementation(async () => {
        const yaw = absoluteYaws[call] ?? 0;
        call++;
        return { faces: [{ ...mockFace(), yaw }] };
      });
      const body: Record<string, unknown> = {
        frames: [
          "data:image/jpeg;base64,PLAIN_F",
          "data:image/jpeg;base64,PLAIN_L",
          "data:image/jpeg;base64,PLAIN_R",
        ],
      };
      if (yawReadings) body.yawReadings = yawReadings;
      return await enroll.POST(req(body));
    } finally {
      if (prevFlag === undefined) delete process.env.FACE_MOCK_ENABLED;
      else process.env.FACE_MOCK_ENABLED = prevFlag;
    }
  }

  it("ACCEPTS the prod capture: client-guided pose while absolute yaw is off-axis", async () => {
    // Client readings are in band (front 0, left +30, right -30); the sidecar
    // sees the SAME physical poses shifted by the student's ~-40° neutral.
    const res = await enrollWithYaws([-40, -1.5, -70], [0, 30, -30]);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("enrolled");
  });

  it("REJECTS the prod capture when the client sends no reading (legacy strict path)", async () => {
    // Without the client reading the route falls back to the absolute bands,
    // which is exactly how the incident manifested — kept as a regression pin
    // so the fallback cannot silently become permissive.
    const res = await enrollWithYaws([-40, -1.5, -70]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("pose_invalid");
  });

  it("REJECTS the 46° 'Right' frame the client gate used to accept (BUG A)", async () => {
    // The wizard captured this frame and the OLD route accepted it because the
    // blended score cleared ≥90 with zero yaw points. Both gates must refuse.
    const res = await enrollWithYaws([0, 30, -46], [0, 30, -46]);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("pose_invalid");
    expect(body.message).toBe("pose_turn_less");
  });

  it("REJECTS a client that lies about its pose (in-band reading, near-profile absolute)", async () => {
    // A tampered client claims "straight" while the sidecar measures a
    // near-profile — the estimator gap exceeds the trust bound, so the strict
    // absolute band decides and the frame is refused.
    const res = await enrollWithYaws([0, 30, 80], [0, 30, 0]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("pose_invalid");
  });

  it("REJECTS an in-band, mutually-consistent reading at a near-profile angle (sanity veto)", async () => {
    // Both estimators agree, but the pose is past the sanity ceiling — a
    // profile view is not a usable enrollment sample whatever the client says.
    const res = await enrollWithYaws([80, 80, 80], [80, 80, 80]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("pose_invalid");
  });

  it("REJECTS a wrong-way side turn reported by both estimators", async () => {
    // Left angle but the student turned to their right (negative) — the
    // actionable 'wrong_way' case, not an over-rotation.
    const res = await enrollWithYaws([0, -30, -30], [0, -30, -30]);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("pose_invalid");
    expect(body.message).toBe("pose_wrong_way");
  });

  it("returns an actionable reason code in BOTH dev and production", async () => {
    // The incident's real sting: production returned a bare `pose_invalid` with
    // no message, so the student had nothing to act on. The reason must ship in
    // production too (it carries no biometrics or server internals).
    const prevEnv = process.env.NODE_ENV;
    try {
      // NODE_ENV is readonly in Next's types but writable at runtime in tests.
      (process.env as Record<string, string>).NODE_ENV = "production";
      const res = await enrollWithYaws([0, 30, -46], [0, 30, -46]);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("pose_invalid");
      expect(body.message).toBe("pose_turn_less");
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prevEnv ?? "test";
    }
  });

  it("reports pose_no_face when no face is detected", async () => {
    faceContext({ seedSession: false, withBaseline: false });
    const prevFlag = process.env.FACE_MOCK_ENABLED;
    delete process.env.FACE_MOCK_ENABLED;
    try {
      insightfaceMock.extractFace.mockResolvedValue({ faces: [] });
      const res = await enroll.POST(
        req({
          frames: [
            "data:image/jpeg;base64,PLAIN_F",
            "data:image/jpeg;base64,PLAIN_L",
            "data:image/jpeg;base64,PLAIN_R",
          ],
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("pose_invalid");
      expect(body.message).toBe("pose_no_face");
    } finally {
      if (prevFlag === undefined) delete process.env.FACE_MOCK_ENABLED;
      else process.env.FACE_MOCK_ENABLED = prevFlag;
    }
  });

  it("rejects a malformed yawReadings payload at the schema boundary", async () => {
    faceContext({ seedSession: false, withBaseline: false });
    // Two entries instead of three, and an out-of-range value — both must be
    // refused before any sidecar work (the array is parallel to `frames`).
    const short = await enroll.POST(
      req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME], yawReadings: [0, 30] }),
    );
    expect(short.status).toBe(400);

    const outOfRange = await enroll.POST(
      req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME], yawReadings: [0, 30, 9999] }),
    );
    expect(outOfRange.status).toBe(400);
  });

  it("accepts a legacy payload with no yawReadings when the pose is on-axis", async () => {
    // Backward compatibility: an old client that omits the field entirely still
    // enrolls when the sidecar's absolute yaw satisfies the absolute bands.
    const res = await enrollWithYaws([0, 30, -30]);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("enrolled");
  });
});

describe("I-dup — duplicate identity detected at enroll → pending_review", () => {
  it("flags pending_review when a DIFFERENT student's stored sample matches ≥ 0.45", async () => {
    const ctx = faceContext({ seedSession: false, withBaseline: false });
    // Another student (LECTURER_ID used as a stand-in second profile) has
    // stored samples identical to the frames being enrolled.
    const otherId = "00000000-0000-4000-8000-0000000000aa";
    ctx.client.seedProfile({ id: otherId, role: "student", consent_given_at: "2026-01-01T00:00:00Z" });
    ctx.client.tables["profile_face_samples"] = [
      { id: "o1", profile_id: otherId, angle: "front", embedding: SELF_VECTOR, created_at: "2026-01-01T00:00:00Z" },
    ];
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending_review");
    const profile = ctx.client.tables["profiles"]!.find((p) => p.id === STUDENT_ID);
    expect(profile?.face_enrollment_status).toBe("pending_review");
  });
});

// audit-2 C-01: the photo/replay gate lives in the VERIFY ROUTE — the
// sidecar's per-frame P(real) verdict either forces a FAIL vote (enforce
// mode) or is recorded only. These tests pin the routing decision through
// the mocked extractFace's spoof field.
describe("audit-2 C-01 — spoof gate (FACE_SPOOF_ENFORCE)", () => {
  it("forces matched:false when enforcement is ON and the verdict is spoofed", async () => {
    faceContext();
    process.env.FACE_SPOOF_ENFORCE = "1";
    try {
      insightfaceMock.extractFace.mockImplementation(async () => ({
        faces: [mockFace()],
        // The similarity side is a perfect self-match (MATCH marker) — the
        // spoof verdict alone must flip this check to a FAIL vote.
        spoof: { real: false, score: 0.01 },
      }));
      const res = await verify.POST(verifyReq({ trigger: "start" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.matched).toBe(false);
    } finally {
      delete process.env.FACE_SPOOF_ENFORCE;
    }
  });

  it("keeps matched:true when enforcement is ON and the verdict is real", async () => {
    faceContext();
    process.env.FACE_SPOOF_ENFORCE = "1";
    try {
      insightfaceMock.extractFace.mockImplementation(async () => ({
        faces: [mockFace()],
        spoof: { real: true, score: 0.97 },
      }));
      const res = await verify.POST(verifyReq({ trigger: "start" }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.matched).toBe(true);
    } finally {
      delete process.env.FACE_SPOOF_ENFORCE;
    }
  });

  it("record-only when enforcement is unset (dev sidecars without baked weights)", async () => {
    faceContext();
    delete process.env.FACE_SPOOF_ENFORCE;
    insightfaceMock.extractFace.mockImplementation(async () => ({
      faces: [mockFace()],
      spoof: { real: false, score: 0.01 },
    }));
    const res = await verify.POST(verifyReq({ trigger: "start" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.matched).toBe(true);
  });
});

// audit-3 E-F7: the enroll path now applies the SAME majority spoof policy as
// verify — a poisoned baseline must not be planted by a photo/replay.
describe("audit-3 E-F7 — enroll spoof gate", () => {
  it("rejects a majority-spoofed capture → 400 spoof_detected (nothing stored)", async () => {
    // Enforcement is gated on FACE_SPOOF_ENFORCE, matching verify: without it
    // the verdicts are recorded/logged but not enforced.
    vi.stubEnv("FACE_SPOOF_ENFORCE", "1");
    const ctx = faceContext({ seedSession: false, withBaseline: false });
    insightfaceMock.extractFace.mockImplementation(async () => ({
      faces: [mockFace()],
      spoof: { real: false, score: 0.01 },
    }));
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("spoof_detected");
    // The gate fires BEFORE the enroll RPC — no poisoned baseline is written
    // and no enrollment audit row is emitted.
    expect(ctx.client.tables["profile_face_samples"] ?? []).toHaveLength(0);
    expect(ctx.client.tables["audit_events"] ?? []).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it("records but does NOT enforce the verdicts when FACE_SPOOF_ENFORCE is unset", async () => {
    // The documented record-only posture (sidecars without baked weights) must
    // stay consistent between enroll and verify — a false-positive verdict
    // must not be able to block enrollment with no env remedy.
    vi.stubEnv("FACE_SPOOF_ENFORCE", "");
    const ctx = faceContext({ seedSession: false, withBaseline: false });
    insightfaceMock.extractFace.mockImplementation(async () => ({
      faces: [mockFace()],
      spoof: { real: false, score: 0.01 },
    }));
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(200);
    vi.unstubAllEnvs();
  });

  it("allows a capture whose verdicts are all real → 200", async () => {
    const ctx = faceContext({ seedSession: false, withBaseline: false });
    insightfaceMock.extractFace.mockImplementation(async () => ({
      faces: [mockFace()],
      spoof: { real: true, score: 0.97 },
    }));
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("enrolled");
    expect(ctx.client.tables["profile_face_samples"]).toHaveLength(3);
  });

  it("allows a capture with NO verdicts (old sidecar / weights absent) → 200", async () => {
    const ctx = faceContext({ seedSession: false, withBaseline: false });
    // The default beforeEach mock omits `spoof` entirely → unknownCount=3.
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("enrolled");
    expect(ctx.client.tables["profile_face_samples"]).toHaveLength(3);
  });

  it("a single fake verdict among real ones does NOT force a fail → 200", async () => {
    faceContext({ seedSession: false, withBaseline: false });
    let call = 0;
    insightfaceMock.extractFace.mockImplementation(async () => {
      call += 1;
      return {
        faces: [mockFace()],
        spoof: call === 1 ? { real: false, score: 0.2 } : { real: true, score: 0.9 },
      };
    });
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(200);
  });
});

describe("I4 — verify match → active, streak reset, new nonce", () => {
  it("returns 200 with matched true, sessionStatus active, nextNonce", async () => {
    faceContext();
    const res = await verify.POST(verifyReq({ trigger: "start" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matched).toBe(true);
    expect(body.sessionStatus).toBe("active");
    expect(typeof body.nextNonce).toBe("string");
    expect(body.nextNonce).not.toBe(NONCE);
    expect(body.faceFailStreak).toBe(0);
  });

  it("cutover guard: an EMPTY baseline → 403 not_enrolled before any sidecar call", async () => {
    faceContext({ withBaseline: false });
    const res = await verify.POST(verifyReq());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_enrolled");
    expect(insightfaceMock.extractFace).not.toHaveBeenCalled();
  });

  it("face-EXEMPT session with NO baseline skips the guard (0020 step-6 order preserved)", async () => {
    // The exempt short-circuit lives INSIDE record_face_check, BEFORE its
    // enrollment check — the route's baseline guard must not reorder that
    // (an exempted student may legitimately have zero stored samples).
    faceContext({ faceExempt: true, withBaseline: false });
    const res = await verify.POST(verifyReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matched).toBe(true);
    expect(body.distance).toBeNull(); // exempt echo, not a computed verdict
  });
});

describe("I5 — 3 flat fails → flagged", () => {
  it("flags on the 3rd mismatch (with blink-recovery between fails)", async () => {
    const ctx = faceContext();
    // Mismatch marker → 0-vote without a sidecar call.
    insightfaceMock.extractFace.mockImplementation(async () => ({ faces: [] }));
    let nonce = NONCE;
    let lastBody: { sessionStatus?: string; nextNonce?: string } = {};
    for (let i = 0; i < 3; i++) {
      const res = await verify.POST(verifyReq({ trigger: "periodic", nonce, frames: [MATCH_FRAME.replace("FAKE_FRAME_MATCH", "FAKE_FRAME_MISMATCH")] }));
      lastBody = (await res.json()) as { sessionStatus?: string; nextNonce?: string };
      nonce = lastBody.nextNonce as string;
      if (i < 2) {
        expect(lastBody.sessionStatus).toBe("paused");
        const rec = await selfRecover.POST(req({ sessionId: SESSION_ID }));
        const recBody = await rec.json();
        nonce = recBody.nextNonce;
      }
    }
    expect(lastBody.sessionStatus).toBe("flagged");
    expect(ctx.client.tables["quiz_sessions"]!.find((s) => s.id === SESSION_ID)?.status).toBe("flagged");
    expect(insightfaceMock.extractFace).not.toHaveBeenCalled();
  });
});

describe("I5b — single fail → paused", () => {
  it("pauses after one mismatch", async () => {
    const ctx = faceContext();
    const mismatch = MATCH_FRAME.replace("FAKE_FRAME_MATCH", "FAKE_FRAME_MISMATCH");
    const res = await verify.POST(verifyReq({ frames: [mismatch] }));
    const body = await res.json();
    expect(body.sessionStatus).toBe("paused");
    expect(ctx.client.tables["quiz_sessions"]!.find((s) => s.id === SESSION_ID)?.status).toBe("paused");
  });
});

describe("I-vote — multi-frame majority voting", () => {
  it("passes when 2 of 3 frames match, even though one frame failed", async () => {
    faceContext();
    // Frame 1: strong self-match; frame 2: no face (blur/glance);
    // frame 3: weak-but-passing self-match (0.6 vs the 0.5 gate).
    insightfaceMock.extractFace.mockImplementation(async (frame: string) => {
      if (frame === "F2") return { faces: [] };
      if (frame === "F3") return { faces: [{ ...mockFace(), embedding: mix(SELF_VECTOR, 0.6) }] };
      return { faces: [mockFace()] };
    });
    const res = await verify.POST(
      verifyReq({ frames: ["F1", "F2", "F3"] }),
    );
    const body = await res.json();
    expect(body.matched).toBe(true);
    expect(body.sessionStatus).toBe("active");
    // Distance reflects the BEST frame's reading (1 - 1.0 = 0).
    expect(body.distance).toBeCloseTo(0, 5);
  });

  it("fails on a 1-of-3 split (no majority)", async () => {
    faceContext();
    insightfaceMock.extractFace.mockImplementation(async (frame: string) =>
      frame === "GOOD" ? { faces: [mockFace()] } : { faces: [] },
    );
    const res = await verify.POST(verifyReq({ frames: ["BAD1", "GOOD", "BAD2"] }));
    const body = await res.json();
    expect(body.matched).toBe(false);
    expect(body.sessionStatus).toBe("paused");
  });

  it("requires BOTH frames to pass when only two were submitted", async () => {
    faceContext();
    const bothPass = await verify.POST(verifyReq({ frames: ["A", "B"] }));
    expect((await bothPass.json()).matched).toBe(true);

    faceContext();
    insightfaceMock.extractFace.mockImplementation(async (frame: string) =>
      frame === "PASS" ? { faces: [mockFace()] } : { faces: [] },
    );
    const oneFails = await verify.POST(verifyReq({ frames: ["PASS", "FAIL"] }));
    expect((await oneFails.json()).matched).toBe(false);
  });

  it("a second person in frame NEVER drags the score UP (single-face pick)", async () => {
    faceContext();
    // A lookalike with a LARGER bbox is in frame; the student's smaller face
    // is the one that must NOT be used to inflate the score — but more
    // importantly the lookalike's OWN embedding (near-orthogonal to the
    // baseline) must not pass either. The primary face is the LARGEST one;
    // the verdict follows THAT face only.
    insightfaceMock.extractFace.mockImplementation(async () => ({
      faces: [
        { ...mockFace(), embedding: SELF_VECTOR, bbox: [200, 150, 420, 400], det_score: 0.99 }, // student (smaller)
        { ...mockFace(), embedding: testVector(33), bbox: [0, 0, 640, 480], det_score: 0.99 }, // lookalike (larger)
      ],
    }));
    const res = await verify.POST(verifyReq({ frames: ["TWIN1", "TWIN2"] }));
    const body = await res.json();
    // The lookalike's embedding is orthogonal to the baseline → both frames
    // vote 0 → the check FAILS (integrity-safe; no max-over-faces inflation).
    expect(body.matched).toBe(false);
  });

  it("a face below the det_score floor votes 0 (no qualifying face)", async () => {
    faceContext();
    insightfaceMock.extractFace.mockImplementation(async () => ({
      faces: [{ ...mockFace(), det_score: 0.3 }],
    }));
    const res = await verify.POST(verifyReq());
    const body = await res.json();
    expect(body.matched).toBe(false);
  });

  it("server-recorded second_face advisory: ≥2 frames with a large distinct extra face → advisory row", async () => {
    const ctx = faceContext();
    // The student's face is primary (320×336 at center (320,264)); a 200×200
    // distinct face sits ≥1 span (336px) away in 2 of the 3 frames (frame 3
    // is clean) — area 37% ✓, displacement 355px ✓.
    const secondFace = {
      ...mockFace(),
      embedding: testVector(33),
      bbox: [560, 60, 760, 260] as [number, number, number, number],
      det_score: 0.95,
    };
    insightfaceMock.extractFace.mockImplementation(async (_frame: string, _uid: string) => {
      // extractFace receives the raw frame; the mock's own primary-face
      // handling is bypassed — return explicit face lists per call order.
      return { faces: [mockFace(), secondFace] };
    });
    const res = await verify.POST(
      verifyReq({ frames: ["REAL1", "REAL2", "REAL3"], trigger: "periodic" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matched).toBe(true); // the student's own face still passes 1:1
    // The advisory is fire-and-forget in the route — flush the microtask
    // queue (the fake RPC resolves synchronously into .then) before asserting.
    await new Promise((r) => setTimeout(r, 0));
    const advisories = ctx.client.tables["session_advisories"] ?? [];
    const row = advisories.find((a) => a.session_id === SESSION_ID && a.adv_type === "second_face");
    expect(row).toBeTruthy();
  });

  it("no advisory when the extra face appears in only ONE frame (noise gate)", async () => {
    const ctx = faceContext();
    let call = 0;
    insightfaceMock.extractFace.mockImplementation(async () => {
      call += 1;
      return {
        faces:
          call <= 1
            ? [mockFace(), { ...mockFace(), embedding: testVector(34), bbox: [560, 60, 760, 260] as [number, number, number, number], det_score: 0.95 }]
            : [mockFace()],
      };
    });
    const res = await verify.POST(
      verifyReq({ frames: ["REAL1", "REAL2", "REAL3"], trigger: "periodic" }),
    );
    expect(res.status).toBe(200);
    const advisories = ctx.client.tables["session_advisories"] ?? [];
    expect(
      advisories.find((a) => a.session_id === SESSION_ID && a.adv_type === "second_face"),
    ).toBeUndefined();
  });

  it("an oversized frame → 413", async () => {
    faceContext();
    const res = await verify.POST(
      verifyReq({ frames: ["x".repeat(200_001), MATCH_FRAME] }),
    );
    expect(res.status).toBe(413);
  });

  it("more than 3 frames → 400", async () => {
    faceContext();
    const res = await verify.POST(
      verifyReq({ frames: [MATCH_FRAME, MATCH_FRAME, MATCH_FRAME, MATCH_FRAME] }),
    );
    expect(res.status).toBe(400);
  });
});

describe("I5c — nonce_mismatch → 409", () => {
  it("returns 409 for a stale nonce", async () => {
    faceContext();
    const res = await verify.POST(verifyReq({ nonce: "22222222-2222-4222-8222-222222222222" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("nonce_mismatch");
  });

  it("a stale-nonce replay does NOT touch face_verify_attempted_at (no exemption sustain)", async () => {
    // Silence-cron bypass pin: the replay burns no ledger row and commits no
    // face_checks row, so stamping the attempt would keep the exemption fresh
    // forever while verifying nothing.
    faceContext();
    const res = await verify.POST(verifyReq({ nonce: "22222222-2222-4222-8222-222222222222" }));
    expect(res.status).toBe(409);
    expect(adminTouchCount.current).toBe(0);
  });

  it("a genuine verify DOES touch face_verify_attempted_at (outage corroboration intact)", async () => {
    faceContext();
    const res = await verify.POST(verifyReq({ trigger: "start" }));
    expect(res.status).toBe(200);
    expect(adminTouchCount.current).toBeGreaterThan(0);
  });

  // audit-5 O4: the route-level 429 used to return before any stamp, so a
  // client being throttled by the ROUTE (not the SQL throttle) produced no
  // corroboration — asymmetric with the SQL-throttle 429, which stamps via the
  // RPC path. A throttled client is demonstrably attempting verifies.
  it("audit-5 O4: a route-level 429 DOES stamp face_verify_attempted_at", async () => {
    faceContext();
    _seedRateLimit(`face-verify:${STUDENT_ID}`, 60);
    const res = await verify.POST(verifyReq({ trigger: "start" }));
    expect(res.status).toBe(429);
    expect(adminTouchCount.current).toBeGreaterThan(0);
  });
});

describe("I6 — verify on non-active session → 409", () => {
  it("returns 409 session_not_active when completed", async () => {
    faceContext({ status: "completed" });
    const res = await verify.POST(verifyReq());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("session_not_active");
  });
});

describe("I6b — self-recover paused → active", () => {
  it("returns 200 sessionStatus active + nextNonce", async () => {
    faceContext({ status: "paused" });
    const res = await selfRecover.POST(req({ sessionId: SESSION_ID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionStatus).toBe("active");
    expect(typeof body.nextNonce).toBe("string");
  });
});

describe("I6c — self-recover flagged → 403", () => {
  it("returns 403 flagged", async () => {
    faceContext({ status: "flagged" });
    const res = await selfRecover.POST(req({ sessionId: SESSION_ID }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("flagged");
  });
});

describe("I20-ext — role cross-checks", () => {
  it("student → unlock/exempt → 403", async () => {
    faceContext({ status: "flagged" });
    const r1 = await unlock.POST(req({ sessionId: SESSION_ID }));
    expect(r1.status).toBe(403);
    const r2 = await exempt.POST(req({ reason: "test" }), {
      params: Promise.resolve({ id: SESSION_ID }),
    });
    expect(r2.status).toBe(403);
  });

  it("lecturer → enroll/verify/pause → 403", async () => {
    const ctx = makeOwnerContext({ quizStatus: "live" });
    ctx.client.setUser(LECTURER_ID, "lecturer");
    fakeHolder.current = ctx.client;
    expect(
      (await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }))).status,
    ).toBe(403);
    expect((await verify.POST(verifyReq())).status).toBe(403);
    expect((await pause.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) })).status).toBe(403);
  });
});

describe("CSRF + rate limit + malformed + transport", () => {
  it("rejects cross-origin on face routes", async () => {
    faceContext();
    const cross = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example.com" },
      body: JSON.stringify({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }),
    });
    expect((await enroll.POST(cross)).status).toBe(403);
    const crossVerify = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example.com" },
      body: JSON.stringify({ frames: [MATCH_FRAME], trigger: "periodic", nonce: NONCE, sessionId: SESSION_ID }),
    });
    expect((await verify.POST(crossVerify)).status).toBe(403);
    expect((await consent.POST(cross)).status).toBe(403);
  });

  it("returns 429 after seeding rate limits", async () => {
    faceContext();
    _seedRateLimit(`face-enroll:${STUDENT_ID}`, 5);
    expect((await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }))).status).toBe(429);
  });

  it("malformed JSON → 400", async () => {
    faceContext();
    const res = await enroll.POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });

  it("transport error → 503 internal (no raw message)", async () => {
    const ctx = faceContext();
    ctx.client.rpcResult = { data: null, error: { message: "boom" } };
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("boom");
  });

  it("unknown RPC payload → 503", async () => {
    const ctx = faceContext();
    ctx.client.rpcResult = { data: { something: "unexpected" }, error: null };
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(503);
  });
});

describe("I-sidecar-down — sidecar unavailable → 503", () => {
  it("verify returns 503 when extractFace fails", async () => {
    faceContext();
    insightfaceMock.extractFace.mockResolvedValue({ error: "insightface_unavailable" });
    const res = await verify.POST(verifyReq({ frames: ["data:image/jpeg;base64,PLAIN"] }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("insightface_unavailable");
  });

  it("verify returns 503 insightface_error (HTTP error) mapped distinctly", async () => {
    faceContext();
    insightfaceMock.extractFace.mockResolvedValue({ error: "insightface_error" });
    const res = await verify.POST(verifyReq({ frames: ["data:image/jpeg;base64,PLAIN"] }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("insightface_error");
  });

  it("enroll returns 503 when the sidecar is unavailable", async () => {
    faceContext({ seedSession: false });
    insightfaceMock.extractFace.mockResolvedValue({ error: "insightface_unavailable" });
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(503);
  });
});

describe("I-compare-down — compare_face_baseline transport failure → 503", () => {
  it("verify returns 503 internal when the compare RPC errors", async () => {
    const ctx = faceContext();
    ctx.client.compareRpcError = true;
    const res = await verify.POST(verifyReq({ frames: ["data:image/jpeg;base64,PLAIN"] }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("boom");
  });
});

describe("I4b — no-face sentinel (empty frames) records a FAIL row, never a pass", () => {
  it("returns 200 with matched:false → sessionStatus paused, and does NOT call the sidecar", async () => {
    const ctx = faceContext();
    const res = await verify.POST(verifyReq({ frames: [""] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matched).toBe(false);
    expect(body.sessionStatus).toBe("paused");
    expect(body.nextNonce).not.toBe(NONCE); // nonce still rotates (fail row written)
    expect(insightfaceMock.extractFace).not.toHaveBeenCalled();
    expect(ctx.client.tables["quiz_sessions"]!.find((s) => s.id === SESSION_ID)?.status).toBe("paused");
  });

  it("an empty-frame start verify does NOT skip the RPC (no silent gate pass)", async () => {
    faceContext();
    const res = await verify.POST(verifyReq({ frames: [""], trigger: "start" }));
    const body = await res.json();
    expect(body.matched).toBe(false);
  });
});

describe("I-threshold — FACE_SIMILARITY_MIN boundary (0.5)", () => {
  it("similarity exactly 0.5 → match", async () => {
    faceContext();
    insightfaceMock.extractFace.mockImplementation(async () => ({
      faces: [{ ...mockFace(), embedding: mix(SELF_VECTOR, 0.5) }],
    }));
    const res = await verify.POST(verifyReq());
    expect((await res.json()).matched).toBe(true);
  });

  it("similarity 0.49 → no match", async () => {
    faceContext();
    insightfaceMock.extractFace.mockImplementation(async () => ({
      faces: [{ ...mockFace(), embedding: mix(SELF_VECTOR, 0.49) }],
    }));
    const res = await verify.POST(verifyReq());
    const body = await res.json();
    expect(body.matched).toBe(false);
    expect(body.sessionStatus).toBe("paused");
  });
});

describe("consent revoke — atomic biometric purge (0039)", () => {
  it("revoke purges the samples and nulls the status in one step", async () => {
    const ctx = faceContext({ enrolled: true });
    const res = await consent.POST(req({ consent: false }));
    expect(res.status).toBe(200);
    const profile = ctx.client.tables["profiles"]!.find((p) => p.id === STUDENT_ID);
    expect(profile?.face_enrollment_status).toBeNull();
    expect(profile?.consent_given_at).toBeNull();
    expect(ctx.client.tables["profile_face_samples"] ?? []).toHaveLength(0);
  });
});

describe("quiz_not_live — verify on closed quiz → 409", () => {
  it("returns 409 when the quiz is not live", async () => {
    faceContext();
    fakeHolder.current!.tables["quizzes"]![0].status = "closed";
    const res = await verify.POST(verifyReq());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("quiz_not_live");
  });
});

describe("flagged-submit → 409; unlock-of-completed → 409", () => {
  it("submit from flagged → 409 session_not_active (via submit stub)", async () => {
    faceContext({ status: "flagged" });
    const submitRoute = await import("@/app/api/sessions/[id]/submit/route");
    const res = await submitRoute.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("session_not_active");
  });

  it("unlock of completed → 409", async () => {
    lecturerContext();
    const session = fakeHolder.current!.tables["quiz_sessions"]![0];
    session.status = "completed";
    const res = await unlock.POST(req({ sessionId: SESSION_ID }));
    expect(res.status).toBe(409);
  });
});

describe("unlock — lecturer-only route branches", () => {
  it("invalid body → 400", async () => {
    lecturerContext();
    const res = await unlock.POST(req({}));
    expect(res.status).toBe(400);
  });

  it("malformed JSON → 400", async () => {
    lecturerContext();
    const res = await unlock.POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("transport error → 503", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: null, error: { message: "boom" } };
    const res = await unlock.POST(req({ sessionId: SESSION_ID }));
    expect(res.status).toBe(503);
  });

  it("unknown payload → 503", async () => {
    const ctx = lecturerContext();
    ctx.client.rpcResult = { data: { unexpected: true }, error: null };
    const res = await unlock.POST(req({ sessionId: SESSION_ID }));
    expect(res.status).toBe(503);
  });

  it("rate limit → 429", async () => {
    lecturerContext();
    _seedRateLimit(`face-unlock:${LECTURER_ID}`, 10);
    const res = await unlock.POST(req({ sessionId: SESSION_ID }));
    expect(res.status).toBe(429);
  });
});

describe("route-specific mapFaceError overrides", () => {
  it("enroll: live_assessment → 409", async () => {
    const ctx = faceContext({ seedSession: false });
    ctx.client.rpcResult = { data: { error: "live_assessment" }, error: null };
    expect((await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }))).status).toBe(409);
  });

  it("verify: consent_required → 403; not_enrolled → 403; not_assessment → 400", async () => {
    const ctx = faceContext();
    for (const [err, status] of [
      ["consent_required", 403],
      ["not_enrolled", 403],
      ["not_assessment", 400],
      ["invalid_trigger", 400],
    ] as const) {
      ctx.client.rpcResult = { data: { error: err }, error: null };
      const res = await verify.POST(verifyReq());
      expect(res.status, err).toBe(status);
    }
  });

  it("verify: face_exempt short-circuit → 200 with distance null + sessionStatus echoed", async () => {
    faceContext({ faceExempt: true });
    const res = await verify.POST(verifyReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matched).toBe(true);
    expect(body.distance).toBeNull();
    expect(body.sessionStatus).toBe("active");
    expect(body.nextNonce).toBe(NONCE); // no rotation on exempt short-circuit
  });
});

describe("I-health — GET /api/face/health", () => {
  it("returns { available: true } when the sidecar is healthy", async () => {
    faceContext({ seedSession: false });
    const res = await health.GET();
    expect(res.status).toBe(200);
    expect((await res.json()).available).toBe(true);
  });

  it("returns { available: false } when the sidecar is down", async () => {
    faceContext({ seedSession: false });
    insightfaceMock.health.mockResolvedValue(false);
    const res = await health.GET();
    expect(res.status).toBe(200);
    expect((await res.json()).available).toBe(false);
  });

  it("returns 429 after rate limiting", async () => {
    faceContext({ seedSession: false });
    _seedRateLimit(`face-health:${STUDENT_ID}`, 10);
    const res = await health.GET();
    expect(res.status).toBe(429);
  });
});

describe("GET /api/sessions/[id]", () => {
  it("own student → 200 with verify_nonce + face_enrollment_status", async () => {
    faceContext();
    const res = await sessionGet.GET(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(SESSION_ID);
    expect(body.status).toBe("active");
    expect(body.verify_nonce).toBe(NONCE);
  });

  it("lecturer → 200 WITHOUT verify_nonce", async () => {
    lecturerContext();
    const res = await sessionGet.GET(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("flagged");
    expect("verify_nonce" in body).toBe(false);
  });

  it("other student → 404", async () => {
    faceContext();
    fakeHolder.current!.setUser("00000000-0000-4000-8000-0000000000ee", "student");
    const res = await sessionGet.GET(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(404);
  });
});

describe("revoke-during-live → session flagged + re-consent does not clear", () => {
  it("revokes consent, flags the session, and re-consent keeps it flagged", async () => {
    const ctx = faceContext({ enrolled: true });
    ctx.client.seedQuestion({
      id: "00000000-0000-4000-8000-0000000000dd",
      quiz_id: QUIZ_C,
      order_index: 0,
      type: "mcq",
      prompt: "Q1",
      options: ["a", "b"],
      correct_index: 0,
    });
    ctx.client.seedSession({
      id: "00000000-0000-4000-8000-0000000000bb",
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "assessment",
      status: "active",
      verify_nonce: NONCE,
    });

    const res = await consent.POST(req({ consent: false }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.consent).toBe(false);
    expect(body.flagged_sessions).toContain("00000000-0000-4000-8000-0000000000bb");
    const s = ctx.client.tables["quiz_sessions"]!.find(
      (x) => x.id === "00000000-0000-4000-8000-0000000000bb",
    );
    expect(s?.status).toBe("flagged");

    // Biometric samples are purged by the same atomic revoke.
    expect(ctx.client.tables["profile_face_samples"] ?? []).toHaveLength(0);

    // Answer after revocation → 409 session_not_active.
    const answerRoute = await import("@/app/api/sessions/[id]/answer/route");
    const q = ctx.client.tables["questions"]![0];
    const answerRes = await answerRoute.POST(req({ questionId: q.id, selectedIndex: 0 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000bb" }),
    });
    expect(answerRes.status).toBe(409);

    // Re-consent restores consent only — does NOT un-flag or re-enroll.
    const re = await consent.POST(req({ consent: true }));
    expect(re.status).toBe(200);
    const stillFlagged = ctx.client.tables["quiz_sessions"]!.find(
      (x) => x.id === "00000000-0000-4000-8000-0000000000bb",
    );
    expect(stillFlagged?.status).toBe("flagged");
    const profile = ctx.client.tables["profiles"]!.find((p) => p.id === STUDENT_ID);
    expect(profile?.consent_given_at).not.toBeNull();
    expect(profile?.face_enrollment_status).toBeNull();
  });
});

describe("focus-loss pause — reason escalation (0020)", () => {
  it("focus_lost → paused, count accumulates", async () => {
    const ctx = faceContext();
    const res = await pause.POST(req({ reason: "focus_lost" }), {
      params: Promise.resolve({ id: SESSION_ID }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).sessionStatus).toBe("paused");
    const s = ctx.client.tables["quiz_sessions"]!.find((x) => x.id === SESSION_ID)!;
    expect(s.status).toBe("paused");
    expect(s.focus_pause_count).toBe(1);
  });

  it("3rd confirmed focus loss → flagged + audit event", async () => {
    const ctx = faceContext();
    let last: Response | null = null;
    for (let i = 0; i < 3; i++) {
      // Self-recover between strikes so each pause starts from active.
      if (i > 0) await selfRecover.POST(req({ sessionId: SESSION_ID }));
      last = await pause.POST(req({ reason: "focus_lost" }), {
        params: Promise.resolve({ id: SESSION_ID }),
      });
    }
    expect(last!.status).toBe(200);
    expect((await last!.json()).sessionStatus).toBe("flagged");
    const s = ctx.client.tables["quiz_sessions"]!.find((x) => x.id === SESSION_ID)!;
    expect(s.status).toBe("flagged");
    expect(s.focus_pause_count).toBe(3);
    const audits = ctx.client.tables["audit_events"] ?? [];
    expect(audits.some((a) => a.action === "auto_flag_focus_loss")).toBe(true);
  });

  it("invalid reason → 400", async () => {
    faceContext();
    const res = await pause.POST(req({ reason: "party" }), {
      params: Promise.resolve({ id: SESSION_ID }),
    });
    expect(res.status).toBe(400);
  });
});

describe("session advisories — report + accumulate", () => {
  const advisory = sessionAdvisoryRoute;

  function advisoryReq(body: unknown) {
    return req(body);
  }

  it("records a valid type → ok:true", async () => {
    faceContext();
    const res = await advisory.POST(advisoryReq({ type: "voice_activity" }), {
      params: Promise.resolve({ id: SESSION_ID }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const rows = fakeHolder.current!.tables["session_advisories"]!;
    expect(rows).toHaveLength(1);
    expect(rows[0].adv_type).toBe("voice_activity");
    expect(rows[0].occurrences).toBe(1);
  });

  it("repeats of one type ACCUMULATE occurrences (no row growth)", async () => {
    faceContext();
    for (let i = 0; i < 3; i++) {
      await advisory.POST(advisoryReq({ type: "second_face" }), {
        params: Promise.resolve({ id: SESSION_ID }),
      });
    }
    const rows = fakeHolder.current!.tables["session_advisories"]!;
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrences).toBe(3);
  });

  it("invalid type → 400", async () => {
    faceContext();
    const res = await advisory.POST(advisoryReq({ type: "vibes" }), {
      params: Promise.resolve({ id: SESSION_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("non-owner → 404", async () => {
    faceContext();
    fakeHolder.current!.setUser("00000000-0000-4000-8000-0000000000ee", "student");
    const res = await advisory.POST(advisoryReq({ type: "looked_away" }), {
      params: Promise.resolve({ id: SESSION_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("rate limit → 429", async () => {
    faceContext();
    _seedRateLimit(`session-advisory:${STUDENT_ID}`, 10);
    const res = await advisory.POST(advisoryReq({ type: "headset_active" }), {
      params: Promise.resolve({ id: SESSION_ID }),
    });
    expect(res.status).toBe(429);
  });
});

/** Blend a unit vector toward a target cosine (for threshold-boundary tests). */
function mix(base: number[], cosine: number): number[] {
  // Construct v = cosine*base + sqrt(1-cosine²)*ortho where ortho is any
  // unit vector orthogonal to base — gives dot(v, base) = cosine exactly.
  const ortho = new Array(EMBEDDING_DIMS).fill(0);
  ortho[(base.findIndex((x) => x !== 0) + 1) % EMBEDDING_DIMS] = 1;
  const s = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  return base.map((x, i) => cosine * x + s * ortho[i]);
}
