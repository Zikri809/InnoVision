import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateMyMatric } from "./update-matric";

/**
 * Server actions are plain async functions on the server — invoked directly
 * here over mocked Supabase clients (same seam the route tests use).
 */

type ProfileRow = Record<string, unknown> & { id?: string };

function makeRlsClient(opts: {
  user?: { id: string } | null;
  profile?: ProfileRow | null;
  updateError?: { message: string; code?: string } | null;
}) {
  const updates: unknown[] = [];
  return {
    updates,
    auth: {
      getUser: async () => ({ data: { user: opts.user ?? null }, error: null }),
    },
    from: (table: string) => {
      expect(table).toBe("profiles");
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: opts.profile ?? null, error: null }),
          }),
        }),
        update: (payload: unknown) => {
          updates.push(payload);
          return {
            eq: () =>
              Promise.resolve({
                data: null,
                error: opts.updateError ?? null,
              }),
          };
        },
      };
    },
  };
}

function makeAdminClient(opts: { clash?: boolean }) {
  return {
    from: () => ({
      select: () => ({
        ilike: (_col: string, _val: unknown) => ({
          neq: () => ({
            limit: async () => ({ data: opts.clash ? [{ id: "other" }] : [], error: null }),
          }),
        }),
      }),
    }),
  };
}

const rlsHolder: { current: ReturnType<typeof makeRlsClient> | undefined } = { current: undefined };
const adminHolder: { current: ReturnType<typeof makeAdminClient> | undefined } = { current: undefined };

vi.mock("@/lib/supabase/server", () => ({
  createServerActionClient: async () => rlsHolder.current,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminHolder.current,
}));
vi.mock("@/lib/i18n/locale", () => ({
  getLocale: async () => "en",
}));

beforeEach(() => {
  rlsHolder.current = undefined;
  adminHolder.current = undefined;
});

describe("updateMyMatric", () => {
  it("unauthenticated → sessionExpired copy", async () => {
    rlsHolder.current = makeRlsClient({ user: null });
    const res = await updateMyMatric("231456");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/session has expired/i);
  });

  it("non-student role → studentsOnly copy", async () => {
    rlsHolder.current = makeRlsClient({
      user: { id: "u1" },
      profile: { id: "u1", role: "lecturer" },
    });
    const res = await updateMyMatric("231456");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/only students/i);
  });

  it("empty input → matricRequired copy", async () => {
    rlsHolder.current = makeRlsClient({ user: { id: "u1" }, profile: { id: "u1", role: "student" } });
    const res = await updateMyMatric("   ");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/required/i);
  });

  it("reserved range → matricReserved copy", async () => {
    rlsHolder.current = makeRlsClient({ user: { id: "u1" }, profile: { id: "u1", role: "student" } });
    const res = await updateMyMatric("990001");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/reserved/i);
  });

  it("malformed input → matricInvalid copy", async () => {
    rlsHolder.current = makeRlsClient({ user: { id: "u1" }, profile: { id: "u1", role: "student" } });
    const res = await updateMyMatric("23abc");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/6 digits/i);
  });

  it("duplicate held by another student → matricTaken, no update issued", async () => {
    rlsHolder.current = makeRlsClient({ user: { id: "u1" }, profile: { id: "u1", role: "student" } });
    adminHolder.current = makeAdminClient({ clash: true });
    const res = await updateMyMatric("231456");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already registered/i);
    expect(rlsHolder.current.updates).toHaveLength(0);
  });

  it("happy path normalizes and persists", async () => {
    rlsHolder.current = makeRlsClient({ user: { id: "u1" }, profile: { id: "u1", role: "student" } });
    adminHolder.current = makeAdminClient({ clash: false });
    const res = await updateMyMatric(" 23 1456 ");
    expect(res).toEqual({ ok: true, value: "231456" });
    expect(rlsHolder.current.updates).toEqual([{ matric_no: "231456" }]);
  });

  it("unique-index loss at write time → matricTaken copy", async () => {
    rlsHolder.current = makeRlsClient({
      user: { id: "u1" },
      profile: { id: "u1", role: "student" },
      updateError: {
        message: 'duplicate key value violates unique constraint "profiles_matric_no_unique"',
        code: "23505",
      },
    });
    adminHolder.current = makeAdminClient({ clash: false });
    const res = await updateMyMatric("231456");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already registered/i);
  });
});
