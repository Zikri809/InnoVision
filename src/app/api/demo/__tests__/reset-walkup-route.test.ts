import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * POST /api/demo/reset-walkup (PLAN_DEMO_MODE.md D6).
 *
 * The load-bearing assertion is AUTHORIZATION: the flag alone must not let a
 * visitor (any same-origin phone on the booth LAN) fire a service-role reset.
 */

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  resetWalkup: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));

vi.mock("@/lib/demo/walkup-reset", () => ({
  resetWalkup: mocks.resetWalkup,
  DEMO_LECTURER_EMAIL: "demo-lecturer@innovision.test",
}));

vi.mock("@/lib/log", () => ({ logError: vi.fn() }));

const notFoundError = new Error("NEXT_NOT_FOUND");
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw notFoundError;
  },
}));

import { POST } from "@/app/api/demo/reset-walkup/route";

function req(body: unknown = { confirm: true }): Request {
  return new Request("http://localhost:3000/api/demo/reset-walkup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ORIGINAL_FLAG = process.env.NEXT_PUBLIC_DEMO_MODE;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_DEMO_MODE = "1";
  mocks.resetWalkup.mockResolvedValue({ guestsDeleted: 3, quizRecreated: true });
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.NEXT_PUBLIC_DEMO_MODE;
  else process.env.NEXT_PUBLIC_DEMO_MODE = ORIGINAL_FLAG;
});

describe("POST /api/demo/reset-walkup", () => {
  it("flag-off → notFound(), never runs the reset", async () => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    await expect(POST(req())).rejects.toBe(notFoundError);
    expect(mocks.resetWalkup).not.toHaveBeenCalled();
  });

  it("anonymous → 401, never runs the reset", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(mocks.resetWalkup).not.toHaveBeenCalled();
  });

  it("a non-demo-lecturer session → 403 (flag-gating is not authorization)", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "s1", email: "student1@innovision.test" } },
    });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(mocks.resetWalkup).not.toHaveBeenCalled();
  });

  it("without confirm:true → 400, never runs the reset", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "l1", email: "demo-lecturer@innovision.test" } },
    });
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(mocks.resetWalkup).not.toHaveBeenCalled();
  });

  it("demo lecturer + confirm → 200 with the summary", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "l1", email: "demo-lecturer@innovision.test" } },
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.summary.guestsDeleted).toBe(3);
    expect(mocks.resetWalkup).toHaveBeenCalledTimes(1);
  });
});
