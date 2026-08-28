import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Faithful @supabase/ssr mock: createServerClient captures the cookies.setAll
// handler; exchangeCodeForSession drives it with the cookies a real GoTrue
// exchange would set (recovery session token).
let capturedSetAll:
  | ((cookiesToSet: { name: string; value: string; options?: unknown }[]) => void)
  | undefined;

const mockExchange = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(
    (_url: string, _key: string, options: { cookies: { setAll: unknown } }) => {
      capturedSetAll = options.cookies.setAll as typeof capturedSetAll;
      return {
        auth: {
          exchangeCodeForSession: mockExchange,
        },
      };
    },
  ),
}));

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  },
}));

import { GET } from "@/app/auth/callback/route";

function nextReq(pathWithQuery: string): NextRequest {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

beforeEach(() => {
  capturedSetAll = undefined;
  mockExchange.mockReset();
  mockExchange.mockImplementation(async () => {
    // Real GoTrue exchange sets the session cookie via the ssr setAll hook.
    capturedSetAll?.([{ name: "sb-test-auth-token", value: "session-token" }]);
    return { data: { user: { id: "u1" } }, error: null };
  });
});

describe("auth/callback route — recovery entry point", () => {
  it("exchanges the code and redirects to the sanitized local redirect target", async () => {
    const res = await GET(nextReq("/auth/callback?code=abc&redirect=/reset-password/confirm"));

    expect(mockExchange).toHaveBeenCalledTimes(1);
    expect(mockExchange).toHaveBeenCalledWith("abc");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/reset-password/confirm",
    );
  });

  it("writes the exchanged session cookie onto the redirect response", async () => {
    const res = await GET(nextReq("/auth/callback?code=abc&redirect=/reset-password/confirm"));
    expect(res.cookies.get("sb-test-auth-token")?.value).toBe("session-token");
  });

  it("falls back to the dashboard when the redirect param is missing", async () => {
    const res = await GET(nextReq("/auth/callback?code=abc"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
  });

  it("never redirects off-origin for hostile redirect values", async () => {
    for (const payload of [
      "https://evil.example.com",
      "//evil.example.com",
      "/\\evil.example.com",
      "/login%0d%0aX: 1",
      "/%5cevil.example.com",
    ]) {
      const res = await GET(
        nextReq(`/auth/callback?code=abc&redirect=${encodeURIComponent(payload)}`),
      );
      const location = res.headers.get("location")!;
      // Real sanitizeRedirect maps every hostile payload to /dashboard.
      expect(location).toBe("http://localhost:3000/dashboard");
    }
  });

  it("redirects to /login when no code is present", async () => {
    const res = await GET(nextReq("/auth/callback"));
    expect(mockExchange).not.toHaveBeenCalled();
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("ignores a failed exchange but still redirects to the target (session stays absent)", async () => {
    mockExchange.mockImplementation(async () => {
      return { data: {}, error: { message: "bad code" } };
    });
    const res = await GET(nextReq("/auth/callback?code=expired&redirect=/reset-password/confirm"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/reset-password/confirm",
    );
  });
});
