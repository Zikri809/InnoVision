import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase, makeOwnerContext } from "@/app/api/quizzes/__tests__/fake-supabase";
import { _resetRateLimiter, _seedRateLimit } from "@/lib/classes/rate-limit";
import * as pauseRoute from "@/app/api/sessions/[id]/pause/route";
import * as exemptRoute from "@/app/api/sessions/[id]/exempt-face/route";
import * as unavailableRoute from "@/app/api/sessions/[id]/face-unavailable/route";
import * as consentRoute from "@/app/api/face/consent/route";
import * as sessionGetRoute from "@/app/api/sessions/[id]/route";
import * as incidentRoute from "@/app/api/sessions/[id]/incident/route";

const fakeHolder: { current: FakeSupabase | undefined } = { current: undefined };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeHolder.current,
}));

// Storage + metadata writes go through the ADMIN client — mock the boundary
// and assert the upload/insert contract (the real client needs service keys).
const adminMock = {
  storage: {
    from: vi.fn(() => ({
      upload: vi.fn().mockResolvedValue({ error: null }),
      remove: vi.fn().mockResolvedValue({ error: null }),
    })),
  },
  from: vi.fn(() => incidentInsertBuilder()),
};
function incidentInsertBuilder() {
  return {
    insert: vi.fn().mockResolvedValue({ error: null }),
  };
}
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminMock,
}));

const pause = pauseRoute;
const exempt = exemptRoute;
const unavailable = unavailableRoute;
const consent = consentRoute;
const sessionGet = sessionGetRoute;
const incident = incidentRoute;

const QUIZ_C = "00000000-0000-4000-8000-00000000000c";
const SESSION_ID = "00000000-0000-4000-8000-0000000000aa";
const STUDENT_ID = "00000000-0000-4000-8000-0000000000ff";
const LECTURER_ID = "00000000-0000-4000-8000-00000000000a";

function req(body?: unknown, init?: RequestInit): Request {
  return new Request("http://localhost", {
    method: init?.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function assessmentContext(opts?: { status?: string; student?: string }) {
  const ctx = makeOwnerContext({ quizStatus: "live" });
  const quizRow = ctx.client.tables["quizzes"]![0];
  quizRow.mode = "assessment";
  ctx.client.setUser(opts?.student ?? STUDENT_ID, "student");
  ctx.client.seedSession({
    id: SESSION_ID,
    quiz_id: QUIZ_C,
    student_id: opts?.student ?? STUDENT_ID,
    mode: "assessment",
    status: opts?.status ?? "active",
    verify_nonce: "11111111-1111-4111-8111-111111111111",
    face_fail_streak: 0,
  });
  fakeHolder.current = ctx.client;
  return ctx;
}

function lecturerContext() {
  const ctx = makeOwnerContext({ quizStatus: "live" });
  const quizRow = ctx.client.tables["quizzes"]![0];
  quizRow.mode = "assessment";
  ctx.client.setUser(LECTURER_ID, "lecturer");
  ctx.client.seedSession({
    id: SESSION_ID,
    quiz_id: QUIZ_C,
    student_id: STUDENT_ID,
    mode: "assessment",
    status: "flagged",
    verify_nonce: "11111111-1111-4111-8111-111111111111",
  });
  fakeHolder.current = ctx.client;
  return ctx;
}

beforeEach(() => {
  fakeHolder.current = undefined;
  _resetRateLimiter();
});

describe("pause — server-side hand-loss pause", () => {
  it("assessment active → paused (200)", async () => {
    const ctx = assessmentContext();
    const res = await pause.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(200);
    expect((await res.json()).sessionStatus).toBe("paused");
    expect(ctx.client.tables["quiz_sessions"]!.find((s) => s.id === SESSION_ID)?.status).toBe("paused");
  });

  it("already paused → idempotent 200", async () => {
    assessmentContext({ status: "paused" });
    const res = await pause.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(200);
  });

  it("flagged → 409 session_not_active", async () => {
    assessmentContext({ status: "flagged" });
    const res = await pause.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("session_not_active");
  });

  it("completed → 409 session_not_active", async () => {
    assessmentContext({ status: "completed" });
    const res = await pause.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(409);
  });

  it("practice session → 409 not_assessment", async () => {
    const ctx = makeOwnerContext({ quizStatus: "live" });
    ctx.client.tables["quizzes"]![0].mode = "practice";
    ctx.client.setUser(STUDENT_ID, "student");
    ctx.client.seedSession({
      id: SESSION_ID,
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
      verify_nonce: "11111111-1111-4111-8111-111111111111",
    });
    fakeHolder.current = ctx.client;
    const res = await pause.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_assessment");
  });

  it("lecturer → 403", async () => {
    lecturerContext();
    const res = await pause.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(403);
  });

  it("rate limit → 429", async () => {
    assessmentContext();
    _seedRateLimit(`pause:${STUDENT_ID}`, 20);
    const res = await pause.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(429);
  });
});

describe("exempt-face — lecturer only", () => {
  it("lecturer exempts a flagged session → active + face_exempt", async () => {
    const ctx = lecturerContext();
    const res = await exempt.POST(req({ reason: "camera broken" }), {
      params: Promise.resolve({ id: SESSION_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionStatus).toBe("active");
    const s = ctx.client.tables["quiz_sessions"]!.find((x) => x.id === SESSION_ID);
    expect(s?.face_exempt).toBe(true);
  });

  it("student → 403", async () => {
    assessmentContext({ status: "flagged" });
    const res = await exempt.POST(req({ reason: "x" }), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(403);
  });

  it("missing reason → 400", async () => {
    lecturerContext();
    const res = await exempt.POST(req({}), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(400);
  });

  it("completed → 409", async () => {
    lecturerContext();
    fakeHolder.current!.tables["quiz_sessions"]![0].status = "completed";
    const res = await exempt.POST(req({ reason: "x" }), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(409);
  });
});

describe("face-unavailable — idempotent", () => {
  it("records face_unavailable_at (200 ok)", async () => {
    const ctx = assessmentContext();
    const res = await unavailable.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(ctx.client.tables["quiz_sessions"]!.find((s) => s.id === SESSION_ID)?.face_unavailable_at).toBeTruthy();
  });

  it("second call is idempotent (200)", async () => {
    assessmentContext();
    await unavailable.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    const res = await unavailable.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(200);
  });

  it("transport error → 503", async () => {
    const ctx = assessmentContext();
    ctx.client.rpcResult = { data: null, error: { message: "boom" } };
    const res = await unavailable.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(503);
  });

  it("unknown payload → 503", async () => {
    const ctx = assessmentContext();
    ctx.client.rpcResult = { data: { unexpected: true }, error: null };
    const res = await unavailable.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(503);
  });

  it("rate limit → 429", async () => {
    assessmentContext();
    _seedRateLimit(`face-unavailable:${STUDENT_ID}`, 10);
    const res = await unavailable.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(429);
  });

  it("practice session → 400 not_assessment", async () => {
    const ctx = makeOwnerContext({ quizStatus: "live" });
    ctx.client.tables["quizzes"]![0].mode = "practice";
    ctx.client.setUser(STUDENT_ID, "student");
    ctx.client.seedSession({
      id: SESSION_ID,
      quiz_id: QUIZ_C,
      student_id: STUDENT_ID,
      mode: "practice",
      status: "active",
      verify_nonce: "11111111-1111-4111-8111-111111111111",
    });
    fakeHolder.current = ctx.client;
    const res = await unavailable.POST(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_assessment");
  });

  it("non-UUID id → 404", async () => {
    assessmentContext();
    const res = await unavailable.POST(req(), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });
});

describe("consent — set + revoke", () => {
  it("set consent → 200 consent true + consent_given_at written", async () => {
    const ctx = makeOwnerContext({ quizStatus: "live" });
    ctx.client.setUser(STUDENT_ID, "student");
    ctx.client.seedProfile({ id: STUDENT_ID, role: "student", consent_given_at: null, face_enrollment_status: null });
    fakeHolder.current = ctx.client;
    const res = await consent.POST(req({ consent: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).consent).toBe(true);
    expect(ctx.client.tables["profiles"]!.find((p) => p.id === STUDENT_ID)?.consent_given_at).toBeTruthy();
  });

  it("revoke → 200 consent false + enrollment status cleared + audit", async () => {
    const ctx = makeOwnerContext({ quizStatus: "live" });
    ctx.client.setUser(STUDENT_ID, "student");
    ctx.client.seedProfile({ id: STUDENT_ID, role: "student", consent_given_at: "2026-01-01T00:00:00Z", face_enrollment_status: "enrolled" });
    fakeHolder.current = ctx.client;
    const res = await consent.POST(req({ consent: false }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.consent).toBe(false);
    const profile = ctx.client.tables["profiles"]!.find((p) => p.id === STUDENT_ID);
    expect(profile?.consent_given_at).toBeNull();
    expect(profile?.face_enrollment_status).toBeNull();
    expect(profile?.face_deletion_pending).toBe(false);
    expect((ctx.client.tables["audit_events"] ?? []).some((a) => a.action === "consent_revoked")).toBe(true);
  });
});

describe("GET /api/sessions/[id]", () => {
  it("own student → 200 with verify_nonce", async () => {
    assessmentContext();
    const res = await sessionGet.GET(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(SESSION_ID);
    expect(body.status).toBe("active");
    expect(body.verify_nonce).toBe("11111111-1111-4111-8111-111111111111");
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
    assessmentContext();
    fakeHolder.current!.setUser("00000000-0000-4000-8000-0000000000ee", "student");
    const res = await sessionGet.GET(req(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(404);
  });

  it("non-UUID id → 404", async () => {
    assessmentContext();
    const res = await sessionGet.GET(req(), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(404);
  });
});

describe("incident upload � ring-buffer clip route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminMock.storage.from = vi.fn(() => ({
      upload: vi.fn().mockResolvedValue({ error: null }),
      remove: vi.fn().mockResolvedValue({ error: null }),
    }));
    adminMock.from = vi.fn(() => incidentInsertBuilder());
  });

  function incidentReq(opts?: { size?: number; declared?: number; type?: string }) {
    const size = opts?.size ?? 1024;
    const blob = new Blob([new Uint8Array(size)], { type: opts?.type ?? "video/webm" });
    const form = new FormData();
    form.append("clip", blob, "clip.webm");
    form.append("reason", "paused");
    form.append("durationMs", "4200");
    form.append("recordedFrom", new Date(0).toISOString());
    const headers: Record<string, string> = {};
    if (opts?.declared != null) headers["content-length"] = String(opts.declared);
    return new Request("http://localhost", { method: "POST", headers, body: form });
  }

  it("active assessment + valid clip ? 200 ok; storage + row written with webm content type", async () => {
    assessmentContext();
    const res = await incident.POST(incidentReq(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(adminMock.storage.from).toHaveBeenCalledWith("incident-footage");
    expect(adminMock.from).toHaveBeenCalledWith("incident_clips");
  });

  it("completed session ? 400 (no post-submit storage-bloat channel)", async () => {
    assessmentContext({ status: "completed" });
    const res = await incident.POST(incidentReq(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(400);
  });

  it("practice session ? 400", async () => {
    const ctx = makeOwnerContext({ quizStatus: "live" });
    ctx.client.tables["quizzes"]![0].mode = "practice";
    ctx.client.setUser(STUDENT_ID, "student");
    fakeHolder.current = ctx.client;
    const res = await incident.POST(incidentReq(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect([400, 404]).toContain(res.status);
  });

  it("non-owner ? 404", async () => {
    assessmentContext();
    fakeHolder.current!.setUser("00000000-0000-4000-8000-0000000000ee", "student");
    const res = await incident.POST(incidentReq(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(404);
  });

  it("declared content-length over the cap ? 413 BEFORE buffering the body", async () => {
    assessmentContext();
    const res = await incident.POST(
      incidentReq({ declared: 40_000_000 }),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );
    expect(res.status).toBe(413);
    expect(adminMock.storage.from).not.toHaveBeenCalled();
  });

  it("oversized actual clip ? 413 and NO storage write", async () => {
    assessmentContext();
    const res = await incident.POST(
      incidentReq({ size: 31_000_000 }),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );
    expect(res.status).toBe(413);
    expect(adminMock.storage.from).not.toHaveBeenCalled();
  });

  it("rate limit ? 429", async () => {
    assessmentContext();
    _seedRateLimit(`session-incident:${STUDENT_ID}`, 6);
    const res = await incident.POST(incidentReq(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(429);
  });

  it("storage failure ? 503, no row inserted", async () => {
    assessmentContext();
    adminMock.storage.from = vi.fn(() => ({
      upload: vi.fn().mockResolvedValue({ error: { message: "bucket down" } }),
      remove: vi.fn().mockResolvedValue({ error: null }),
    }));
    const res = await incident.POST(incidentReq(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(503);
  });
});
