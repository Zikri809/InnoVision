import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockGetUser = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
  })),
}));

import { updateSession } from "@/lib/supabase/middleware";

function nextReq(pathWithQuery: string): NextRequest {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

beforeEach(() => {
  mockGetUser.mockReset();
});

describe("updateSession — middleware redirect matrix", () => {
  it("redirects anonymous users from a protected route to /login with redirect param", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const res = await updateSession(nextReq("/lecturer/classes"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("redirect")).toBe("/lecturer/classes");
  });

  it("preserves the query string in the redirect param path only", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    // pathname (not search) is captured — mirrors the implementation.
    const res = await updateSession(nextReq("/student/quizzes?tab=shared"));
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("redirect")).toBe("/student/quizzes");
  });

  it("lets anonymous users through public routes unchanged", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    for (const path of ["/", "/login", "/register", "/auth/callback"]) {
      const res = await updateSession(nextReq(path));
      expect(res.status).toBe(200);
    }
  });

  it("redirects authenticated users away from auth pages to /dashboard", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });

    for (const path of ["/login", "/register"]) {
      const res = await updateSession(nextReq(path));
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/dashboard");
    }
  });

  it("treats nested public subpaths as public (/auth/callback/x)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const res = await updateSession(nextReq("/auth/callback/exchange"));
    expect(res.status).toBe(200);
  });

  it('does NOT treat similarly-prefixed paths as public ("/loginx")', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const res = await updateSession(nextReq("/loginx"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("returns the passthrough response for authenticated users on protected routes", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });

    const res = await updateSession(nextReq("/dashboard"));
    expect(res.status).toBe(200);
  });
});
