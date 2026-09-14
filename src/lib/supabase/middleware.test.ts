import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockGetUser = vi.fn();
// Captures the cookie adapter updateSession hands to createServerClient, so a
// test can drive setAll() the way @supabase/ssr does on a token refresh.
const ssrOptionsHolder: {
  current: { cookies?: { setAll?: (c: { name: string; value: string; options?: Record<string, unknown> }[]) => void } } | null;
} = { current: null };

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn((_url: string, _key: string, opts: unknown) => {
    ssrOptionsHolder.current = opts as typeof ssrOptionsHolder.current;
    return { auth: { getUser: mockGetUser } };
  }),
}));

import { updateSession } from "@/lib/supabase/middleware";

function nextReq(pathWithQuery: string): NextRequest {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

beforeEach(() => {
  mockGetUser.mockReset();
  ssrOptionsHolder.current = null;
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

  it("preserves the query string in the redirect param (audit-3 A-F8)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    // The query string is part of the preserved destination: the old form
    // stored only the pathname, so an expired session on a query-carrying URL
    // (e.g. the student quiz list's ?class=… link) lost its params.
    const res = await updateSession(nextReq("/student/quizzes?tab=shared"));
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("redirect")).toBe("/student/quizzes?tab=shared");
  });

  it("replays refreshed auth cookies onto the login redirect (audit-3 A-F7)", async () => {
    // A redirect is a FRESH NextResponse, so cookies written by the refresh
    // were previously dropped and the browser kept its expired token.
    mockGetUser.mockImplementation(async () => {
      ssrOptionsHolder.current?.cookies?.setAll?.([
        { name: "sb-innovision-auth-token", value: "refreshed", options: { path: "/" } },
      ]);
      return { data: { user: null } };
    });

    const res = await updateSession(nextReq("/lecturer/classes"));
    expect(res.status).toBe(307);
    expect(res.cookies.get("sb-innovision-auth-token")?.value).toBe("refreshed");
  });

  it("accumulates multi-batch setAll calls, last write per name winning", async () => {
    // @supabase/ssr can invoke setAll more than once in one getUser() (e.g. a
    // chunked-cookie refresh then a clear). Overwriting would replay only the
    // last batch and silently drop the earlier cookies.
    mockGetUser.mockImplementation(async () => {
      const setAll = ssrOptionsHolder.current?.cookies?.setAll;
      setAll?.([{ name: "cookie-a", value: "a1", options: { path: "/" } }]);
      setAll?.([
        { name: "cookie-b", value: "b1", options: { path: "/" } },
        { name: "cookie-a", value: "a2", options: { path: "/" } },
      ]);
      return { data: { user: null } };
    });

    const res = await updateSession(nextReq("/lecturer/classes"));
    expect(res.status).toBe(307);
    // Both batches survive; the duplicate name resolves to the LATER value.
    expect(res.cookies.get("cookie-a")?.value).toBe("a2");
    expect(res.cookies.get("cookie-b")?.value).toBe("b1");
  });

  it("replays refreshed cookies onto the authenticated /dashboard bounce too", async () => {
    mockGetUser.mockImplementation(async () => {
      ssrOptionsHolder.current?.cookies?.setAll?.([
        { name: "sb-innovision-auth-token", value: "bounced", options: { path: "/" } },
      ]);
      return { data: { user: { id: "u1" } } };
    });

    const res = await updateSession(nextReq("/login"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/dashboard");
    expect(res.cookies.get("sb-innovision-auth-token")?.value).toBe("bounced");
  });

  it("lets anonymous users through public routes unchanged", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    for (const path of [
      "/",
      "/login",
      "/register",
      "/auth/callback",
      "/forgot-password",
      "/reset-password/confirm",
    ]) {
      const res = await updateSession(nextReq(path));
      expect(res.status).toBe(200);
    }
  });

  it("redirects authenticated users away from auth pages to /dashboard", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });

    for (const path of [
      "/login",
      "/register",
      "/forgot-password",
      "/reset-password",
    ]) {
      const res = await updateSession(nextReq(path));
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/dashboard");
    }
  });

  it("lets an authenticated recovery session reach /reset-password/confirm", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });

    const res = await updateSession(nextReq("/reset-password/confirm"));
    expect(res.status).toBe(200);
  });

  it("treats nested public subpaths as public (/auth/callback/x)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const res = await updateSession(nextReq("/auth/callback/exchange"));
    expect(res.status).toBe(200);
  });

  it("treats nested subpaths of the reset routes as public", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    for (const path of ["/forgot-password/x", "/reset-password/x"]) {
      const res = await updateSession(nextReq(path));
      expect(res.status).toBe(200);
    }
  });

  it('does NOT treat similarly-prefixed paths as public ("/forgot-passwordx")', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const res = await updateSession(nextReq("/forgot-passwordx"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
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
