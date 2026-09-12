import { describe, it, expect, vi, beforeEach } from "vitest";
import { startInstitutionalSso } from "./sso";
import { _resetRateLimiter } from "@/lib/classes/rate-limit";

/**
 * Focused tests for the SSO-start action's redirect threading (QR class
 * join) + classroom-scale rate limit. next/headers and the Supabase client
 * are mocked; the OAuth call captures redirectTo verbatim.
 */

// Configurable next/headers mock (reset.test.ts pattern).
const headersState: { get: (name: string) => string | null } = { get: () => null };

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => headersState.get(name) }),
}));

type OAuthCall = {
  provider: string;
  options?: { redirectTo?: string; scopes?: string };
};

const clientHolder: { current: ReturnType<typeof makeClient> | null } = { current: null };

function makeClient(opts: { oauthError?: string; noUrl?: boolean } = {}) {
  const oauthCalls: OAuthCall[] = [];
  return {
    oauthCalls,
    auth: {
      signInWithOAuth: async (payload: never) => {
        const p = payload as { provider: string; options?: { redirectTo?: string; scopes?: string } };
        oauthCalls.push(p);
        if (opts.oauthError) return { data: {}, error: { message: opts.oauthError } };
        if (opts.noUrl) return { data: {}, error: null };
        return { data: { url: "https://microsoftonline.example/authorize" }, error: null };
      },
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerActionClient: async () => clientHolder.current,
}));

vi.mock("@/lib/auth/institutional", () => ({
  isSsoConfigured: () => true,
}));

function seedHeaders(table: Record<string, string>) {
  headersState.get = (name: string) => table[name] ?? null;
}

beforeEach(() => {
  clientHolder.current = makeClient();
  _resetRateLimiter();
  headersState.get = () => null;
  seedHeaders({
    "x-forwarded-host": "innovision.example",
    "x-forwarded-proto": "https",
  });
});

describe("startInstitutionalSso redirect threading", () => {
  it("appends a sanitized redirect param when one is supplied", async () => {
    const res = await startInstitutionalSso({ redirect: "/join/ABC234" });
    expect(res.url).toBeTruthy();
    const call = clientHolder.current!.oauthCalls[0];
    expect(call.options?.redirectTo).toBe(
      "https://innovision.example/auth/callback?redirect=%2Fjoin%2FABC234",
    );
  });

  it("keeps the bare callback URL when no redirect is passed (existing logins unchanged)", async () => {
    await startInstitutionalSso();
    const call = clientHolder.current!.oauthCalls[0];
    expect(call.options?.redirectTo).toBe("https://innovision.example/auth/callback");
  });

  it("keeps the bare callback URL for an empty redirect", async () => {
    await startInstitutionalSso({ redirect: "" });
    const call = clientHolder.current!.oauthCalls[0];
    expect(call.options?.redirectTo).toBe("https://innovision.example/auth/callback");
  });

  it("folds an absolute-URL redirect to the /dashboard fallback (no param appended)", async () => {
    await startInstitutionalSso({ redirect: "https://evil.example/phish" });
    const call = clientHolder.current!.oauthCalls[0];
    expect(call.options?.redirectTo).toBe("https://innovision.example/auth/callback");
  });

  it("folds a protocol-relative redirect to the fallback", async () => {
    await startInstitutionalSso({ redirect: "//evil.example" });
    const call = clientHolder.current!.oauthCalls[0];
    expect(call.options?.redirectTo).toBe("https://innovision.example/auth/callback");
  });

  it("folds a backslash redirect (including encoded) to the fallback", async () => {
    await startInstitutionalSso({ redirect: "/\\evil.example" });
    const call = clientHolder.current!.oauthCalls[0];
    expect(call.options?.redirectTo).toBe("https://innovision.example/auth/callback");
  });

  it("preserves query + hash of a local target through the round-trip", async () => {
    await startInstitutionalSso({ redirect: "/student/classes?x=1#top" });
    const call = clientHolder.current!.oauthCalls[0];
    expect(call.options?.redirectTo).toBe(
      "https://innovision.example/auth/callback?redirect=%2Fstudent%2Fclasses%3Fx%3D1%23top",
    );
  });

  it("keeps a local target and appends the param with an empty origin when headers throw", async () => {
    headersState.get = () => {
      throw new Error("outside request scope");
    };
    // headers() throws on the RATE-LIMIT lookup first — the action swallows
    // that, then throws again for origin; sanitizeRedirect against the
    // localhost fallback keeps the target (still a local path), and origin
    // stays empty — matching the documented behavior.
    const res = await startInstitutionalSso({ redirect: "/join/ABC234" });
    expect(res.url).toBeTruthy();
    const call = clientHolder.current!.oauthCalls[0];
    // Empty origin + local target: URL stays relative-ish (origin="") but the
    // redirect param is present and encoded.
    expect(call.options?.redirectTo).toContain("/auth/callback?redirect=%2Fjoin%2FABC234");
  });

  it("surfaces sso_failed when the provider errors", async () => {
    clientHolder.current = makeClient({ oauthError: "provider down" });
    const res = await startInstitutionalSso({ redirect: "/join/ABC234" });
    expect(res.error).toBe("sso_failed");
  });
});

describe("startInstitutionalSso rate limit (classroom scale)", () => {
  it("allows a classroom-sized burst from one shared IP", async () => {
    seedHeaders({ "x-forwarded-for": "10.1.2.3" });
    for (let i = 0; i < 60; i++) {
      const res = await startInstitutionalSso();
      expect(res.error).toBeUndefined();
    }
  });

  it("still throttles scripted abuse beyond the window", async () => {
    seedHeaders({ "x-forwarded-for": "10.1.2.3" });
    for (let i = 0; i < 60; i++) await startInstitutionalSso();
    const res = await startInstitutionalSso();
    expect(res.error).toBe("too_many_attempts");
  });
});
