import { describe, it, expect, vi, beforeEach } from "vitest";
import { register } from "./register";

/**
 * Focused tests for the signup server action's matric handling (the matric
 * feature's server-side contract). Supabase clients + next/headers are
 * mocked; message lookups run against the real catalogs.
 */

type AdminBehavior = {
  clash?: boolean;
};

function makeAdminClient(behavior: AdminBehavior = {}) {
  return {
    from: () => ({
      // Duplicate pre-check: .select("id").ilike(...).limit(1)
      select: () => ({
        ilike: () => ({
          limit: async () => ({
            data: behavior.clash ? [{ id: "someone" }] : [],
            error: null,
          }),
        }),
        eq: () => ({
          single: async () => ({ data: { id: "u", role: "lecturer" }, error: null }),
          maybeSingle: async () => ({ data: { role: "lecturer" }, error: null }),
        }),
      }),
      // Lecturer promotion upsert (register chains .upsert(...).select(...).single()).
      upsert: () => ({
        select: () => ({
          single: async () => ({ data: { id: "u", role: "lecturer" }, error: null }),
        }),
      }),
    }),
    auth: {
      admin: {
        updateUserById: async () => ({ error: null }),
      },
    },
  };
}

function makeRlsClient(opts: { signUpError?: string | null } = {}) {
  const signUpCalls: {
    email?: string;
    password?: string;
    options?: { data?: Record<string, unknown> };
  }[] = [];
  return {
    signUpCalls,
    auth: {
      signUp: async (payload: never) => {
        const p = payload as {
          email?: string;
          password?: string;
          options?: { data?: Record<string, unknown> };
        };
        signUpCalls.push(p);
        if (opts.signUpError) {
          return { data: { user: null }, error: { message: opts.signUpError } };
        }
        return {
          data: { user: { id: "new-user" }, session: { access_token: "t" } },
          error: null,
        };
      },
    },
    rpc: async () => ({ data: { ok: true }, error: null }),
    from: () => ({
      update: () => ({
        eq: async () => ({ data: null, error: null }),
      }),
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { consent_given_at: "2026-01-01T00:00:00Z" },
            error: null,
          }),
        }),
      }),
    }),
  };
}

const rlsHolder: { current: ReturnType<typeof makeRlsClient> | undefined } = {
  current: undefined,
};
const adminHolder: { current: ReturnType<typeof makeAdminClient> | undefined } = {
  current: undefined,
};

vi.mock("@/lib/supabase/server", () => ({
  createServerActionClient: async () => rlsHolder.current,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (!adminHolder.current) throw new Error("admin client not configured");
    return adminHolder.current;
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: () => undefined, get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));

beforeEach(() => {
  process.env.LECTURER_INVITE_CODE = "TESTCODE";
  rlsHolder.current = undefined;
  adminHolder.current = undefined;
});

describe("register — matric validation", () => {
  it("student without matric → matricRequired", async () => {
    const res = await register({ email: "a@b.com", password: "hunter22" });
    expect(res.error).toMatch(/required/i);
  });

  it("student with reserved-range matric → matricReserved", async () => {
    const res = await register({ email: "a@b.com", password: "hunter22", matricNo: "990001" });
    expect(res.error).toMatch(/reserved/i);
  });

  it("student with malformed matric → matricInvalid", async () => {
    const res = await register({ email: "a@b.com", password: "hunter22", matricNo: "23ab" });
    expect(res.error).toMatch(/6 digits/i);
  });

  it("happy student path stores the NORMALIZED matric via user_metadata", async () => {
    rlsHolder.current = makeRlsClient();
    adminHolder.current = makeAdminClient();
    const res = await register({ email: "a@b.com", password: "hunter22", matricNo: " 23 1456 " });
    expect(res.session).toBe(true);
    const meta = rlsHolder.current!.signUpCalls[0].options?.data;
    expect(meta?.matric_no).toBe("231456");
  });

  it("duplicate-matric pre-check fires BEFORE signUp and short-circuits", async () => {
    rlsHolder.current = makeRlsClient();
    adminHolder.current = makeAdminClient({ clash: true });
    const res = await register({ email: "a@b.com", password: "hunter22", matricNo: "231456" });
    expect(res.error).toMatch(/already registered/i);
    expect(rlsHolder.current!.signUpCalls).toHaveLength(0);
  });

  it("signUp losing the unique race maps to matricTaken", async () => {
    rlsHolder.current = makeRlsClient({
      signUpError:
        'duplicate key value violates unique constraint "profiles_matric_no_unique"',
    });
    adminHolder.current = makeAdminClient();
    const res = await register({ email: "a@b.com", password: "hunter22", matricNo: "231456" });
    expect(res.error).toMatch(/already registered/i);
  });

  it("LECTURER path ignores matric entirely (even garbage) and skips the pre-check", async () => {
    rlsHolder.current = makeRlsClient();
    // clash: true — IF the student pre-check ever ran on this path it would
    // return matricTaken; asserting success pins that lecturers skip it.
    adminHolder.current = makeAdminClient({ clash: true });
    const res = await register({
      email: "l@b.com",
      password: "hunter22",
      matricNo: "!!!garbage",
      inviteCode: "TESTCODE",
    });
    expect(res.session).toBe(true);
    expect(res.error).toBeUndefined();
    const meta = rlsHolder.current!.signUpCalls[0].options?.data;
    expect(meta?.matric_no).toBeUndefined();
  });
});
