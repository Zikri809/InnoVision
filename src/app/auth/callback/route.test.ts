import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Faithful @supabase/ssr mock: createServerClient captures the cookies.setAll
// handler; exchangeCodeForSession drives it with the cookies a real GoTrue
// exchange would set (recovery or OAuth session token).
let capturedSetAll:
  | ((cookiesToSet: { name: string; value: string; options?: unknown }[]) => void)
  | undefined;

const mockExchange = vi.fn();
// Mirrors real @supabase/ssr _removeSession: signOut deletes the auth cookies
// THROUGH THE SAME setAll hook the exchange used (a max-age-0 Set-Cookie on
// whatever response is bound to the client). The route under test must return
// THAT response for the deletions to reach the browser — the assertions below
// fail if it returns a fresh redirect instead.
const mockSignOut = vi.fn(async () => {
  capturedSetAll?.([
    { name: "sb-test-auth-token", value: "", options: { maxAge: 0 } },
  ]);
});

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(
    (_url: string, _key: string, options: { cookies: { setAll: unknown } }) => {
      capturedSetAll = options.cookies.setAll as typeof capturedSetAll;
      return {
        auth: {
          exchangeCodeForSession: mockExchange,
          signOut: mockSignOut,
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

/** Identity shapes the AU-2 branches branch on. */
const RECOVERY_USER = { id: "u1", email: "victim@xxxuni.edu.my", identities: [] };
const AZURE_USER = (email: string | null) => ({
  id: "u2",
  email,
  identities: [
    { provider: "azure", identity_data: { email } },
  ],
});

beforeEach(() => {
  capturedSetAll = undefined;
  mockSignOut.mockClear();
  mockExchange.mockReset();
  mockExchange.mockImplementation(async () => {
    // Real GoTrue exchange sets the session cookie via the ssr setAll hook.
    capturedSetAll?.([{ name: "sb-test-auth-token", value: "session-token" }]);
    return { data: { user: RECOVERY_USER }, error: null };
  });
});

afterEach(() => {
  delete process.env.INSTITUTIONAL_EMAIL_DOMAINS;
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

  it("redirects to plain /login when no code is present", async () => {
    const res = await GET(nextReq("/auth/callback"));
    expect(mockExchange).not.toHaveBeenCalled();
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("surfaces sso-error when GoTrue round-trips an error param (no code)", async () => {
    const res = await GET(
      nextReq("/auth/callback?error=access_denied&error_description=provider%20denied"),
    );
    expect(mockExchange).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?message=sso-error");
  });

  it("failed exchange → clean login redirect, local signOut, cookie CLEARED on the returned response", async () => {
    mockExchange.mockImplementation(async () => {
      return { data: {}, error: { message: "bad code" } };
    });
    const res = await GET(nextReq("/auth/callback?code=expired&redirect=/reset-password/confirm"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?message=sso-error");
    expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
    // The exchange WROTE the session cookie via setAll; the signOut must
    // CLEAR it through the same hook on the response the route RETURNS.
    // Counterfactual: if the route returned a fresh redirect (discarding the
    // signOut's deletions), the cookie here would still hold the session
    // token and this assertion fails.
    expect(res.cookies.get("sb-test-auth-token")?.value).toBe("");
  });
});

describe("auth/callback route — AU-2 institutional domain filter", () => {
  it("with NO domains configured, an azure identity passes through (SSO disabled)", async () => {
    mockExchange.mockImplementation(async () => {
      capturedSetAll?.([{ name: "sb-test-auth-token", value: "session-token" }]);
      return { data: { user: AZURE_USER("student@outlook.com") }, error: null };
    });
    const res = await GET(nextReq("/auth/callback?code=abc&redirect=/dashboard"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
    expect(res.cookies.get("sb-test-auth-token")?.value).toBe("session-token");
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("matching university domain → session cookie set, redirect proceeds", async () => {
    process.env.INSTITUTIONAL_EMAIL_DOMAINS = "xxxuni.edu.my";
    mockExchange.mockImplementation(async () => {
      capturedSetAll?.([{ name: "sb-test-auth-token", value: "session-token" }]);
      return { data: { user: AZURE_USER("student@XXXuni.edu.my") }, error: null };
    });
    const res = await GET(nextReq("/auth/callback?code=abc&redirect=/dashboard"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
    expect(res.cookies.get("sb-test-auth-token")?.value).toBe("session-token");
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("personal Microsoft account → rejected: signOut CLEARS the cookie on the returned response", async () => {
    process.env.INSTITUTIONAL_EMAIL_DOMAINS = "xxxuni.edu.my";
    for (const email of ["student@outlook.com", "student@hotmail.com", "s@sub.xxxuni.edu.my"]) {
      mockSignOut.mockClear();
      capturedSetAll = undefined;
      mockExchange.mockImplementation(async () => {
        capturedSetAll?.([{ name: "sb-test-auth-token", value: "session-token" }]);
        return { data: { user: AZURE_USER(email) }, error: null };
      });
      const res = await GET(nextReq("/auth/callback?code=abc&redirect=/dashboard"));
      expect(res.headers.get("location")).toBe("http://localhost:3000/login?message=sso-domain");
      expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
      // The exchange SET the session cookie via setAll; the route must return
      // the SAME response signOut's deletions were written to. Counterfactual:
      // return a fresh redirect and the value would still be "session-token".
      expect(res.cookies.get("sb-test-auth-token")?.value).toBe("");
    }
  });

  it("azure identity WITHOUT an email claim → rejected (never admit unknown)", async () => {
    process.env.INSTITUTIONAL_EMAIL_DOMAINS = "xxxuni.edu.my";
    mockExchange.mockImplementation(async () => {
      capturedSetAll?.([{ name: "sb-test-auth-token", value: "session-token" }]);
      return { data: { user: AZURE_USER(null) }, error: null };
    });
    const res = await GET(nextReq("/auth/callback?code=abc"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?message=sso-domain");
    expect(mockSignOut).toHaveBeenCalled();
  });

  it("NON-azure identities (recovery, email OTP) are never domain-filtered", async () => {
    process.env.INSTITUTIONAL_EMAIL_DOMAINS = "xxxuni.edu.my";
    // Default mockExchange returns RECOVERY_USER (identities: []) — a
    // password-recovery exchange with a uni email must pass untouched.
    const res = await GET(
      nextReq("/auth/callback?code=abc&redirect=/reset-password/confirm"),
    );
    expect(res.headers.get("location")).toBe("http://localhost:3000/reset-password/confirm");
    expect(res.cookies.get("sb-test-auth-token")?.value).toBe("session-token");
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
