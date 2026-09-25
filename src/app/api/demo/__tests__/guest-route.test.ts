import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * POST /api/demo/guest (PLAN_DEMO_MODE.md D2).
 *
 * Mocks the admin + SSR clients so the REAL route (guards, flag gate, ordering,
 * session assertion, join call) runs. Covers:
 *  - flag-off → framework notFound() (no bespoke shape)
 *  - happy path: create → sign in → assert session → join → { redirect }
 *  - sign-in failure → 503 (never a 200 with no session)
 *  - session assertion failure → 503 (the swallowed-cookie-set failure mode)
 *  - account cap → 503 demo_full
 *  - non-demo body code → 400
 */

const mocks = vi.hoisted(() => ({
  createGuestUser: vi.fn(),
  joinDemoClass: vi.fn(),
  countExistingGuests: vi.fn(),
  countGuestAccounts: vi.fn(),
  signInWithPassword: vi.fn(),
  getUser: vi.fn(),
  admin: {},
}));

vi.mock("@/lib/demo/guests", () => ({
  createGuestUser: mocks.createGuestUser,
  joinDemoClass: mocks.joinDemoClass,
  countExistingGuests: mocks.countExistingGuests,
  countGuestAccounts: mocks.countGuestAccounts,
  isGuestEmail: (e: string | null | undefined) =>
    Boolean(e && e.endsWith("@demo.innovision.test")),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mocks.admin,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerActionClient: async () => ({
    auth: { signInWithPassword: mocks.signInWithPassword, getUser: mocks.getUser },
  }),
}));

const notFoundError = new Error("NEXT_NOT_FOUND");
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw notFoundError;
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "10.0.0.9" }),
}));

vi.mock("@/lib/log", () => ({ logError: vi.fn() }));

import { POST } from "@/app/api/demo/guest/route";

function req(body: unknown = {}, origin?: string): Request {
  return new Request("http://localhost:3000/api/demo/guest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

const GUEST = {
  id: "g1",
  email: "guest-abcd1234@demo.innovision.test",
  password: "pw",
  fullName: "Guest #1 (Visitor)",
  matric: "980001",
};

const ORIGINAL_FLAG = process.env.NEXT_PUBLIC_DEMO_MODE;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.countExistingGuests.mockResolvedValue(0);
  mocks.countGuestAccounts.mockResolvedValue(0);
  mocks.createGuestUser.mockResolvedValue(GUEST);
  mocks.signInWithPassword.mockResolvedValue({ error: null });
  mocks.getUser.mockResolvedValue({ data: { user: { id: "g1", email: GUEST.email } } });
  mocks.joinDemoClass.mockResolvedValue({ ok: true });
  process.env.NEXT_PUBLIC_DEMO_MODE = "1";
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.NEXT_PUBLIC_DEMO_MODE;
  else process.env.NEXT_PUBLIC_DEMO_MODE = ORIGINAL_FLAG;
});

describe("POST /api/demo/guest", () => {
  it("flag-off → notFound() (framework 404), creates nothing", async () => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    await expect(POST(req())).rejects.toBe(notFoundError);
    expect(mocks.createGuestUser).not.toHaveBeenCalled();
  });

  it("happy path: provisions, signs in, asserts session, joins, returns redirect", async () => {
    const res = await POST(req({ code: "SCAN23" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redirect).toBe("/student/quizzes");
    expect(mocks.createGuestUser).toHaveBeenCalledTimes(1);
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({
      email: GUEST.email,
      password: GUEST.password,
    });
    expect(mocks.joinDemoClass).toHaveBeenCalledTimes(1);
  });

  it("still returns a redirect when the join RPC fails (visitor is signed in)", async () => {
    mocks.joinDemoClass.mockResolvedValue({ ok: false, error: "join_unavailable" });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).redirect).toBe("/student/quizzes");
  });

  it("sign-in failure → 503 (never a 200 with no session)", async () => {
    mocks.signInWithPassword.mockResolvedValue({ error: { message: "bad" } });
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(mocks.joinDemoClass).not.toHaveBeenCalled();
  });

  it("session-assertion failure (swallowed cookie set) → 503", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const res = await POST(req());
    expect(res.status).toBe(503);
  });

  it("rejects a session bound to a DIFFERENT guest id (identity, not just domain)", async () => {
    // Same guest domain but a different user id — isGuestEmail alone would pass;
    // the id equality assertion must reject.
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "someone-else", email: "guest-ffffffff@demo.innovision.test" } },
    });
    const res = await POST(req());
    expect(res.status).toBe(503);
  });

  it("account cap reached → 503 demo_full, creates nothing", async () => {
    mocks.countGuestAccounts.mockResolvedValue(200);
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("demo_full");
    expect(mocks.createGuestUser).not.toHaveBeenCalled();
  });

  it("a non-demo body code → 400 invalid_code", async () => {
    const res = await POST(req({ code: "DEMK42" }));
    expect(res.status).toBe(400);
    expect(mocks.createGuestUser).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request (CSRF)", async () => {
    const res = await POST(req({}, "https://evil.example"));
    expect(res.status).toBe(403);
    expect(mocks.createGuestUser).not.toHaveBeenCalled();
  });

  it("provisioning throw → 503 internal, no crash", async () => {
    mocks.createGuestUser.mockRejectedValue(new Error("boom"));
    const res = await POST(req());
    expect(res.status).toBe(503);
  });
});
