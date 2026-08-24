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

const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

// Mock the CompreFace client so unit tests never touch Docker. Tests control
// the responses via the mutable `comprefaceMock`.
const comprefaceMock = {
  recognize: vi.fn(),
  recognizeFaces: vi.fn(),
  detect: vi.fn(),
  addSubjectExample: vi.fn(),
  deleteSubject: vi.fn(),
  subjectExists: vi.fn(),
  health: vi.fn(),
  isMockMatchFrame: (f: string) => f.includes("FAKE_FRAME_MATCH"),
  isMockMismatchFrame: (f: string) => f.includes("FAKE_FRAME_MISMATCH"),
  isMockModeEnabled: () => process.env.COMPREFACE_MOCK_ENABLED === "1",
};
vi.mock("@/lib/face/server/compreface-client", () => ({
  recognize: (...a: unknown[]) => comprefaceMock.recognize(...a),
  recognizeFaces: (...a: unknown[]) => comprefaceMock.recognizeFaces(...a),
  // Mirror of the real selfSimilarity (max self-subject similarity across faces).
  selfSimilarity: (faces: { subjects: { subject: string; similarity: number }[] }[], uid: string) => {
    let best = 0;
    for (const face of faces) {
      for (const s of face.subjects) {
        if (s.subject === uid && s.similarity > best) best = s.similarity;
      }
    }
    return best;
  },
  detect: (...a: unknown[]) => comprefaceMock.detect(...a),
  addSubjectExample: (...a: unknown[]) => comprefaceMock.addSubjectExample(...a),
  deleteSubject: (...a: unknown[]) => comprefaceMock.deleteSubject(...a),
  subjectExists: (...a: unknown[]) => comprefaceMock.subjectExists(...a),
  health: (...a: unknown[]) => comprefaceMock.health(...a),
  isMockMatchFrame: (f: string) => f.includes("FAKE_FRAME_MATCH"),
  isMockMismatchFrame: (f: string) => f.includes("FAKE_FRAME_MISMATCH"),
  isMockModeEnabled: () => process.env.COMPREFACE_MOCK_ENABLED === "1",
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
// Enroll frames carry the MATCH marker so the route's mock-aware pose-skip /
// duplicate-skip path is exercised (mirrors the E2E fake tracker).
const FRONT_FRAME = "data:image/jpeg;base64,FAKE_FRAME_MATCH_FRONT";
const LEFT_FRAME = "data:image/jpeg;base64,FAKE_FRAME_MATCH_LEFT";
const RIGHT_FRAME = "data:image/jpeg;base64,FAKE_FRAME_MATCH_RIGHT";

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

/** A live assessment context with the student enrolled + consented + seeded. */
function faceContext(opts?: {
  status?: string;
  enrolled?: boolean;
  consented?: boolean;
  faceExempt?: boolean;
  seedSession?: boolean;
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
  // The CompreFace client is module-mocked; these env vars are not strictly
  // needed for the mocked path but keep the routes' env reads from throwing.
  process.env.COMPREFACE_BASE_URL = "http://localhost:8000";
  process.env.COMPREFACE_API_KEY = "test-key";
  process.env.COMPREFACE_MOCK_ENABLED = "1";
});

afterAll(() => {
  delete process.env.COMPREFACE_BASE_URL;
  delete process.env.COMPREFACE_API_KEY;
  delete process.env.COMPREFACE_MOCK_ENABLED;
});

beforeEach(() => {
  fakeHolder.current = undefined;
  _resetRateLimiter();
  vi.clearAllMocks();
  // Default CompreFace behavior: match frame → self subject, no duplicates,
  // pose valid.
  comprefaceMock.recognizeFaces.mockResolvedValue([
    { subjects: [{ subject: STUDENT_ID, similarity: 0.95 }] },
  ]);
  comprefaceMock.detect.mockResolvedValue({ faces: [{ yaw: 0 }] });
  comprefaceMock.addSubjectExample.mockResolvedValue({ imageId: "img-1" });
  comprefaceMock.deleteSubject.mockResolvedValue({ ok: true });
  comprefaceMock.subjectExists.mockResolvedValue(true);
  comprefaceMock.health.mockResolvedValue(true);
});

describe("I1 — enroll requires consent", () => {
  it("returns 403 consent_required when consent is null", async () => {
    faceContext({ consented: false, seedSession: false });
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("consent_required");
  });
});

describe("I2 — enroll stores 3 frames + sets enrolled status", () => {
  it("returns 200 { ok:true, status:enrolled } and writes the status", async () => {
    const ctx = faceContext({ seedSession: false });
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("enrolled");
    expect(comprefaceMock.addSubjectExample).toHaveBeenCalledTimes(3);
    const profile = ctx.client.tables["profiles"]!.find((p) => p.id === STUDENT_ID);
    expect(profile?.face_enrollment_status).toBe("enrolled");
  });
});

describe("I3 — enroll rejects invalid frames", () => {
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

  it("returns 400 pose_invalid when CompreFace detect returns a bad yaw", async () => {
    faceContext({ seedSession: false });
    // Real-mode simulation: pose validation only runs OUTSIDE mock mode
    // (the route skips it entirely while COMPREFACE_MOCK_ENABLED=1 because
    // the mocked detect() returns yaw 0 for everything).
    const prevFlag = process.env.COMPREFACE_MOCK_ENABLED;
    delete process.env.COMPREFACE_MOCK_ENABLED;
    try {
      // Non-match frames so pose validation runs; front yaw 90 is out of range.
      comprefaceMock.detect.mockResolvedValue({ faces: [{ yaw: 90 }] });
      const res = await enroll.POST(
        req({ frames: ["data:image/jpeg;base64,PLAIN_F", "data:image/jpeg;base64,PLAIN_L", "data:image/jpeg;base64,PLAIN_R"] }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("pose_invalid");
    } finally {
      if (prevFlag === undefined) delete process.env.COMPREFACE_MOCK_ENABLED;
      else process.env.COMPREFACE_MOCK_ENABLED = prevFlag;
    }
  });
});

describe("I-dup — duplicate identity detected at enroll → pending_review", () => {
  it("flags pending_review when a different subject matches with high similarity", async () => {
    const ctx = faceContext({ seedSession: false });
    // Real-mode simulation: the duplicate check only runs OUTSIDE mock mode
    // (mirrors the pose-validation skip — see I3 above).
    const prevFlag = process.env.COMPREFACE_MOCK_ENABLED;
    delete process.env.COMPREFACE_MOCK_ENABLED;
    try {
      // Use NON-match frames so the route's duplicate check (recognize) runs.
      const nonMatchFrames = [
        "data:image/jpeg;base64,PLAIN_FRONT",
        "data:image/jpeg;base64,PLAIN_LEFT",
        "data:image/jpeg;base64,PLAIN_RIGHT",
      ];
      // Pose validation: detect returns yaw 0 for all (front ok, but left/right
      // would fail pose... so mock detect to return valid yaw per frame).
      comprefaceMock.detect.mockImplementation(async (frame: string) => {
        if (frame.includes("PLAIN_LEFT")) return { faces: [{ yaw: 40 }] };
        if (frame.includes("PLAIN_RIGHT")) return { faces: [{ yaw: -40 }] };
        return { faces: [{ yaw: 0 }] };
      });
      // CompreFace recognize (used for the duplicate check) returns a DIFFERENT
      // subject with similarity above FACE_SUSPICION_MIN (0.45).
      comprefaceMock.recognize.mockResolvedValue({
        subject: "00000000-0000-4000-8000-0000000000aa",
        similarity: 0.8,
        subjects: [{ subject: "00000000-0000-4000-8000-0000000000aa", similarity: 0.8 }],
      });
      const res = await enroll.POST(req({ frames: nonMatchFrames }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("pending_review");
      const profile = ctx.client.tables["profiles"]!.find((p) => p.id === STUDENT_ID);
      expect(profile?.face_enrollment_status).toBe("pending_review");
    } finally {
      if (prevFlag === undefined) delete process.env.COMPREFACE_MOCK_ENABLED;
      else process.env.COMPREFACE_MOCK_ENABLED = prevFlag;
    }
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
});

describe("I5 — 3 flat fails → flagged", () => {
  it("flags on the 3rd mismatch (with blink-recovery between fails)", async () => {
    const ctx = faceContext();
    // CompreFace returns a mismatch (no self match).
    comprefaceMock.recognizeFaces.mockResolvedValue([{ subjects: [] }]);
    let nonce = NONCE;
    let lastBody: { sessionStatus?: string; nextNonce?: string } = {};
    for (let i = 0; i < 3; i++) {
      const res = await verify.POST(verifyReq({ trigger: "periodic", nonce }));
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
  });
});

describe("I5b — single fail → paused", () => {
  it("pauses after one mismatch", async () => {
    const ctx = faceContext();
    comprefaceMock.recognizeFaces.mockResolvedValue([{ subjects: [] }]);
    const res = await verify.POST(verifyReq());
    const body = await res.json();
    expect(body.sessionStatus).toBe("paused");
    expect(ctx.client.tables["quiz_sessions"]!.find((s) => s.id === SESSION_ID)?.status).toBe("paused");
  });
});

describe("I-vote — multi-frame majority voting", () => {
  it("passes when 2 of 3 frames match, even though one frame failed", async () => {
    faceContext();
    // Frame 1: strong self-match; frame 2: no self reading (blur/glance);
    // frame 3: weak-but-passing self-match.
    comprefaceMock.recognizeFaces.mockImplementation(async (frame: string) => {
      if (frame === "F1") return [{ subjects: [{ subject: STUDENT_ID, similarity: 0.95 }] }];
      if (frame === "F2") return [{ subjects: [] }];
      return [{ subjects: [{ subject: STUDENT_ID, similarity: 0.6 }] }];
    });
    const res = await verify.POST(
      verifyReq({ frames: ["F1", "F2", "F3"] }),
    );
    const body = await res.json();
    expect(body.matched).toBe(true);
    expect(body.sessionStatus).toBe("active");
    // Distance reflects the BEST frame's reading.
    expect(body.distance).toBeCloseTo(0.05, 5);
  });

  it("fails on a 1-of-3 split (no majority)", async () => {
    faceContext();
    comprefaceMock.recognizeFaces.mockImplementation(async (frame: string) => {
      return frame === "GOOD"
        ? [{ subjects: [{ subject: STUDENT_ID, similarity: 0.9 }] }]
        : [{ subjects: [] }];
    });
    const res = await verify.POST(verifyReq({ frames: ["BAD1", "GOOD", "BAD2"] }));
    const body = await res.json();
    expect(body.matched).toBe(false);
    expect(body.sessionStatus).toBe("paused");
  });

  it("requires BOTH frames to pass when only two were submitted", async () => {
    faceContext();
    comprefaceMock.recognizeFaces.mockResolvedValue([
      { subjects: [{ subject: STUDENT_ID, similarity: 0.95 }] },
    ]);
    const bothPass = await verify.POST(verifyReq({ frames: ["A", "B"] }));
    expect((await bothPass.json()).matched).toBe(true);

    faceContext();
    comprefaceMock.recognizeFaces.mockImplementation(async (frame: string) =>
      frame === "PASS" ? [{ subjects: [{ subject: STUDENT_ID, similarity: 0.95 }] }] : [{ subjects: [] }],
    );
    const oneFails = await verify.POST(verifyReq({ frames: ["PASS", "FAIL"] }));
    expect((await oneFails.json()).matched).toBe(false);
  });

  it("a lookalike ranking top-1 does NOT fail the check (1:1 by lookup)", async () => {
    faceContext();
    // A classmate outranks the student in the gallery — the old margin rule
    // would have failed this; the caller's OWN similarity is what counts.
    comprefaceMock.recognizeFaces.mockResolvedValue([
      {
        subjects: [
          { subject: "00000000-0000-4000-8000-0000000000aa", similarity: 0.8 },
          { subject: STUDENT_ID, similarity: 0.7 },
        ],
      },
    ]);
    const res = await verify.POST(verifyReq({ frames: ["TWIN1", "TWIN2"] }));
    const body = await res.json();
    expect(body.matched).toBe(true);
    expect(body.distance).toBeCloseTo(0.3, 5);
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

describe("I-compreface-down — CompreFace unavailable → 503", () => {
  it("verify returns 503 when CompreFace recognize fails", async () => {
    faceContext();
    comprefaceMock.recognizeFaces.mockResolvedValue({ error: "compreface_unavailable" });
    const res = await verify.POST(verifyReq());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("compreface_unavailable");
  });

  it("verify returns 503 comprehend_error (HTTP error) mapped distinctly", async () => {
    faceContext();
    comprefaceMock.recognizeFaces.mockResolvedValue({ error: "compreface_error" });
    const res = await verify.POST(verifyReq());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("compreface_error");
  });

  it("enroll returns 503 when CompreFace addSubjectExample fails", async () => {
    faceContext({ seedSession: false });
    comprefaceMock.addSubjectExample.mockResolvedValue({ error: "compreface_unavailable" });
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(503);
  });
});

describe("I4b — no-face sentinel (empty frames) records a FAIL row, never a pass", () => {
  it("returns 200 with matched:false → sessionStatus paused, and does NOT call CompreFace", async () => {
    const ctx = faceContext();
    const res = await verify.POST(verifyReq({ frames: [""] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matched).toBe(false);
    expect(body.sessionStatus).toBe("paused");
    expect(body.nextNonce).not.toBe(NONCE); // nonce still rotates (fail row written)
    expect(comprefaceMock.recognizeFaces).not.toHaveBeenCalled();
    const session = ctx.client.tables["quiz_sessions"]!.find((s) => s.id === SESSION_ID);
    expect(session?.status).toBe("paused");
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
    comprefaceMock.recognizeFaces.mockResolvedValue([
      { subjects: [{ subject: STUDENT_ID, similarity: 0.5 }] },
    ]);
    const res = await verify.POST(verifyReq());
    expect((await res.json()).matched).toBe(true);
  });

  it("similarity 0.49 → no match", async () => {
    faceContext();
    comprefaceMock.recognizeFaces.mockResolvedValue([
      { subjects: [{ subject: STUDENT_ID, similarity: 0.49 }] },
    ]);
    const res = await verify.POST(verifyReq());
    const body = await res.json();
    expect(body.matched).toBe(false);
    expect(body.sessionStatus).toBe("paused");
  });
});

describe("deletion-pending lifecycle", () => {
  it("revoke clears face_deletion_pending when the CompreFace delete succeeds", async () => {
    const ctx = faceContext({ enrolled: true });
    const res = await consent.POST(req({ consent: false }));
    expect(res.status).toBe(200);
    expect(comprefaceMock.deleteSubject).toHaveBeenCalledWith(STUDENT_ID);
    const profile = ctx.client.tables["profiles"]!.find((p) => p.id === STUDENT_ID);
    expect(profile?.face_deletion_pending).toBe(false);
    expect(profile?.face_enrollment_status).toBeNull();
  });

  it("revoke leaves face_deletion_pending true when CompreFace deletion fails", async () => {
    const ctx = faceContext({ enrolled: true });
    comprefaceMock.deleteSubject.mockResolvedValue({ error: "compreface_unavailable" });
    const res = await consent.POST(req({ consent: false }));
    expect(res.status).toBe(200);
    const profile = ctx.client.tables["profiles"]!.find((p) => p.id === STUDENT_ID);
    expect(profile?.face_deletion_pending).toBe(true);
  });

  it("enroll deletes the pending subject BEFORE adding examples", async () => {
    const ctx = faceContext({ seedSession: false });
    const profile = ctx.client.tables["profiles"]!.find((p) => p.id === STUDENT_ID)!;
    profile.face_deletion_pending = true;
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(200);
    // deleteSubject (pending cleanup) happens before addSubjectExample.
    expect(comprefaceMock.deleteSubject).toHaveBeenCalledWith(STUDENT_ID);
    expect(
      comprefaceMock.deleteSubject.mock.invocationCallOrder[0],
    ).toBeLessThan(comprefaceMock.addSubjectExample.mock.invocationCallOrder[0]);
    expect(profile.face_enrollment_status).toBe("enrolled");
    // The RPC (stub) clears the deletion-pending marker on success.
    expect(profile.face_deletion_pending).toBe(false);
  });

  it("enroll aborts (does not add examples) when the pending delete fails", async () => {
    const ctx = faceContext({ seedSession: false });
    const profile = ctx.client.tables["profiles"]!.find((p) => p.id === STUDENT_ID)!;
    profile.face_deletion_pending = true;
    comprefaceMock.deleteSubject.mockResolvedValue({ error: "compreface_unavailable" });
    const res = await enroll.POST(req({ frames: [FRONT_FRAME, LEFT_FRAME, RIGHT_FRAME] }));
    expect(res.status).toBe(503);
    expect(comprefaceMock.addSubjectExample).not.toHaveBeenCalled();
    expect(profile.face_deletion_pending).toBe(true); // flag preserved for the cleanup retry
  });
});

describe("quiz_not_live — verify on closed quiz → 409", () => {
  it("returns 409 when the quiz is not live", async () => {
    const ctx = faceContext();
    ctx.client.tables["quizzes"]![0].status = "closed";
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
  it("returns { available: true } when CompreFace is healthy", async () => {
    faceContext({ seedSession: false });
    const res = await health.GET();
    expect(res.status).toBe(200);
    expect((await res.json()).available).toBe(true);
  });

  it("returns { available: false } when CompreFace is down", async () => {
    faceContext({ seedSession: false });
    comprefaceMock.health.mockResolvedValue(false);
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

describe("revoke-during-live → session flagged + re-consent does not clear", () => {  it("revokes consent, flags the session, and re-consent keeps it flagged", async () => {
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

    // The revoke route best-effort deletes the CompreFace subject.
    expect(comprefaceMock.deleteSubject).toHaveBeenCalledWith(STUDENT_ID);

    // Answer after revocation → 409 session_not_active.
    const answerRoute = await import("@/app/api/sessions/[id]/answer/route");
    const q = ctx.client.tables["questions"]![0];
    const answerRes = await answerRoute.POST(req({ questionId: q.id, selectedIndex: 0 }), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000bb" }),
    });
    expect(answerRes.status).toBe(409);

    // Re-consent restores consent only — does NOT un-flag.
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

describe("focus-loss pause � reason escalation (0020)", () => {
  it("focus_lost ? paused, count accumulates", async () => {
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

  it("3rd confirmed focus loss ? flagged + audit event", async () => {
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

  it("invalid reason ? 400", async () => {
    faceContext();
    const res = await pause.POST(req({ reason: "party" }), {
      params: Promise.resolve({ id: SESSION_ID }),
    });
    expect(res.status).toBe(400);
  });
});

describe("session advisories � report + accumulate", () => {
  const advisory = sessionAdvisoryRoute;

  function advisoryReq(body: unknown) {
    return req(body);
  }

  it("records a valid type ? ok:true", async () => {
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

  it("invalid type ? 400", async () => {
    faceContext();
    const res = await advisory.POST(advisoryReq({ type: "vibes" }), {
      params: Promise.resolve({ id: SESSION_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("non-owner ? 404", async () => {
    faceContext();
    fakeHolder.current!.setUser("00000000-0000-4000-8000-0000000000ee", "student");
    const res = await advisory.POST(advisoryReq({ type: "looked_away" }), {
      params: Promise.resolve({ id: SESSION_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("rate limit ? 429", async () => {
    faceContext();
    _seedRateLimit(`session-advisory:${STUDENT_ID}`, 10);
    const res = await advisory.POST(advisoryReq({ type: "headset_active" }), {
      params: Promise.resolve({ id: SESSION_ID }),
    });
    expect(res.status).toBe(429);
  });
});
