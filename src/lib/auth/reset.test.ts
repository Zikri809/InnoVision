import { describe, it, expect, vi, beforeEach } from "vitest";
import { requestReset, confirmPassword } from "./reset";
import { _resetRateLimiter, _seedRateLimit } from "@/lib/classes/rate-limit";

/**
 * Focused tests for the password-reset server actions. Supabase clients +
 * next/headers are mocked; message lookups run against the real catalogs.
 *
 * Key contracts under test:
 * - No enumeration oracle: requestReset resolves without error for unknown
 *   emails AND for GoTrue errors other than throttle (generic success).
 * - Rate limiting: per-IP and per-email budgets, plus Supabase 429 mapping.
 * - confirmPassword min-length parity with register (6).
 */

function makeClient(opts: {
  resetError?: { message: string; status?: number } | null;
  updateError?: { message: string } | null;
} = {}) {
  const calls = {
    resetForEmail: [] as { email: string; redirectTo?: string }[],
    updateUser: [] as { password?: string }[],
  };
  return {
    calls,
    auth: {
      resetPasswordForEmail: async (email: string, options: { redirectTo?: string }) => {
        calls.resetForEmail.push({ email, redirectTo: options?.redirectTo });
        if (opts.resetError) return { data: {}, error: opts.resetError };
        return { data: {}, error: null };
      },
      updateUser: async (payload: { password?: string }) => {
        calls.updateUser.push(payload);
        if (opts.updateError) return { data: {}, error: opts.updateError };
        return { data: {}, error: null };
      },
    },
  };
}

const clientHolder: { current: ReturnType<typeof makeClient> | undefined } = {
  current: undefined,
};

// Configurable next/headers mock so tests can exercise the ms-locale branch
// (cookies), the headers()-throws fallbacks, and the unknown-IP key.
const headersState: {
  get: (name: string) => string | null;
  throwOnGet?: boolean;
} = {
  get: () => null,
};
const cookieState: { value?: string } = {};

vi.mock("@/lib/supabase/server", () => ({
  createServerActionClient: async () => clientHolder.current,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (cookieState.value ? { value: cookieState.value } : undefined) }),
  headers: async () => {
    if (headersState.throwOnGet) throw new Error("outside request scope");
    return { get: (name: string) => headersState.get(name) };
  },
}));

beforeEach(() => {
  clientHolder.current = makeClient();
  _resetRateLimiter();
  headersState.get = () => null;
  headersState.throwOnGet = false;
  cookieState.value = undefined;
  delete process.env.RESET_RATE_LIMIT;
  delete process.env.RESET_IP_RATE_LIMIT;
  delete process.env.RESET_CONFIRM_RATE_LIMIT;
});

function seedHeaders(table: Record<string, string>) {
  headersState.get = (name: string) => table[name] ?? null;
}

describe("requestReset", () => {
  it("rejects malformed email without touching Supabase", async () => {
    const res = await requestReset({ email: "not-an-email" });
    expect(res.error).toMatch(/valid email/i);
    expect(clientHolder.current!.calls.resetForEmail).toHaveLength(0);
  });

  it("normalizes email (trim + lowercase) before the rate-limit key and call", async () => {
    await requestReset({ email: "  STUDENT@Example.COM " });
    expect(clientHolder.current!.calls.resetForEmail[0]?.email).toBe(
      "student@example.com",
    );
  });

  it("passes an absolute redirectTo through /auth/callback?redirect=/reset-password/confirm", async () => {
    seedHeaders({ "x-forwarded-for": "203.0.113.9, 10.0.0.1", "x-forwarded-host": "localhost:3000" });
    await requestReset({ email: "student@example.com" });
    const call = clientHolder.current!.calls.resetForEmail[0];
    expect(call?.redirectTo).toContain("/auth/callback?redirect=/reset-password/confirm");
    expect(call?.redirectTo).toMatch(/^https?:\/\//);
  });

  it("resolves WITHOUT error for unknown accounts (no enumeration oracle)", async () => {
    const res = await requestReset({ email: "ghost@example.com" });
    expect(res.error).toBeUndefined();
  });

  it("swallows GoTrue errors as generic success EXCEPT throttle (429)", async () => {
    clientHolder.current = makeClient({
      resetError: { message: "SMTP failure", status: 500 },
    });
    const ok = await requestReset({ email: "a@b.com" });
    expect(ok.error).toBeUndefined();

    clientHolder.current = makeClient({
      resetError: { message: "Too many requests", status: 429 },
    });
    const throttled = await requestReset({ email: "a@b.com" });
    expect(throttled.error).toMatch(/too many/i);
  });

  it("enforces the per-email budget", async () => {
    seedHeaders({ "x-forwarded-for": "203.0.113.9" });
    for (let i = 0; i < 5; i++) {
      await requestReset({ email: "victim@example.com" });
    }
    const res = await requestReset({ email: "victim@example.com" });
    expect(res.error).toMatch(/too many/i);
    expect(clientHolder.current!.calls.resetForEmail).toHaveLength(5);
  });

  it("enforces the per-IP budget across rotating emails", async () => {
    seedHeaders({ "x-forwarded-for": "203.0.113.9" });
    _seedRateLimit("reset-ip:203.0.113.9", 10);
    const res = await requestReset({ email: "rotate1@example.com" });
    expect(res.error).toMatch(/too many/i);
  });

  it("uses the unknown-IP key when x-forwarded-for is absent", async () => {
    seedHeaders({});
    _seedRateLimit("reset-ip:unknown", 10);
    const res = await requestReset({ email: "nohdr@example.com" });
    expect(res.error).toMatch(/too many/i);
  });

  it("skips the IP budget but proceeds when headers() throws (non-request scope)", async () => {
    headersState.throwOnGet = true;
    const res = await requestReset({ email: "headless@example.com" });
    expect(res.error).toBeUndefined();
    expect(clientHolder.current!.calls.resetForEmail).toHaveLength(1);
  });

  it("builds a relative redirectTo when headers() throws (origin fallback)", async () => {
    headersState.throwOnGet = true;
    await requestReset({ email: "headless@example.com" });
    expect(clientHolder.current!.calls.resetForEmail[0]?.redirectTo).toBe(
      "/auth/callback?redirect=/reset-password/confirm",
    );
  });

  it("uses the host header when x-forwarded-host is absent", async () => {
    seedHeaders({ "x-forwarded-for": "203.0.113.9", host: "app.example.com" });
    await requestReset({ email: "hostfallback@example.com" });
    expect(clientHolder.current!.calls.resetForEmail[0]?.redirectTo).toContain(
      "http://app.example.com/auth/callback",
    );
  });

  it("defaults to https origin when x-forwarded-proto is present", async () => {
    seedHeaders({
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-proto": "https",
    });
    await requestReset({ email: "proto@example.com" });
    expect(clientHolder.current!.calls.resetForEmail[0]?.redirectTo).toContain(
      "https://app.example.com/auth/callback",
    );
  });

  it("selects Malay error copy when the locale cookie is ms", async () => {
    seedHeaders({ "x-forwarded-for": "203.0.113.9" });
    cookieState.value = "ms";
    const res = await requestReset({ email: "not-an-email" });
    expect(res.error).toBe("Sila masukkan alamat e-mel yang sah.");
  });

  it("respects env-tuned RESET_RATE_LIMIT via the envLimit override", async () => {
    vi.stubEnv("RESET_RATE_LIMIT", "1");
    vi.resetModules();
    const { requestReset: freshRequestReset } = await import("./reset");
    seedHeaders({ "x-forwarded-for": "203.0.113.9" });
    await freshRequestReset({ email: "envtuned@example.com" });
    const res = await freshRequestReset({ email: "envtuned@example.com" });
    expect(res.error).toMatch(/too many/i);
    vi.unstubAllEnvs();
  });
});

describe("confirmPassword", () => {
  it("rejects short passwords with the register-parity message (min 6)", async () => {
    const res = await confirmPassword({ password: "12345" });
    expect(res.error).toMatch(/at least 6/i);
    expect(clientHolder.current!.calls.updateUser).toHaveLength(0);
  });

  it("updates the password via the recovery session", async () => {
    const res = await confirmPassword({ password: "newpass123" });
    expect(res.error).toBeUndefined();
    expect(clientHolder.current!.calls.updateUser[0]?.password).toBe("newpass123");
  });

  it("maps updateUser failure to the generic reset-failed message", async () => {
    clientHolder.current = makeClient({
      updateError: { message: "Auth session missing" },
    });
    const res = await confirmPassword({ password: "newpass123" });
    expect(res.error).toMatch(/could not update/i);
  });

  it("enforces the per-IP confirm budget", async () => {
    seedHeaders({ "x-forwarded-for": "203.0.113.9" });
    _seedRateLimit("reset-confirm:203.0.113.9", 10);
    const res = await confirmPassword({ password: "newpass123" });
    expect(res.error).toMatch(/too many/i);
  });

  it("uses the unknown-IP key for confirm when x-forwarded-for is absent", async () => {
    seedHeaders({});
    _seedRateLimit("reset-confirm:unknown", 10);
    const res = await confirmPassword({ password: "newpass123" });
    expect(res.error).toMatch(/too many/i);
  });

  it("skips the confirm IP budget but proceeds when headers() throws", async () => {
    headersState.throwOnGet = true;
    const res = await confirmPassword({ password: "newpass123" });
    expect(res.error).toBeUndefined();
    expect(clientHolder.current!.calls.updateUser).toHaveLength(1);
  });

  it("selects Malay short-password copy when the locale cookie is ms", async () => {
    cookieState.value = "ms";
    const res = await confirmPassword({ password: "12345" });
    expect(res.error).toBe("Kata laluan mesti sekurang-kurangnya 6 aksara.");
  });
});
