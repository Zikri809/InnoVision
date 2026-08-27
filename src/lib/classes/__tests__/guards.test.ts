import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { requireLecturer, requireStudent, requireUser } from "../guards";

type ProfileRow = { role: string };

/**
 * Minimal hand-rolled supabase stub — same pattern as
 * student-quizzes/guards.test.ts: auth.getUser + profiles select, with a
 * switchable DB-error seam so the 503-vs-403-vs-401 mapping can be pinned.
 */
function makeStub(opts: {
  user?: { id: string } | null;
  profile?: ProfileRow | null;
  profileError?: boolean;
}) {
  const calls: string[] = [];
  const stub = {
    auth: {
      getUser: async () => ({ data: { user: opts.user ?? null }, error: null }),
    },
    from(table: string) {
      calls.push(table);
      return {
        select() {
          return {
            eq(col: string, val: unknown) {
              calls.push(`${table}.${col}=${String(val)}`);
              return {
                maybeSingle: async () => {
                  if (opts.profileError) {
                    return { data: null, error: { message: "db down" } };
                  }
                  return { data: opts.profile ?? null, error: null };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient<Database>;
  return { stub, calls };
}

const USER_ID = "00000000-0000-4000-8000-0000000000c1";

describe("requireUser", () => {
  it("resolves userId when the role matches", async () => {
    const { stub } = makeStub({
      user: { id: USER_ID },
      profile: { role: "lecturer" },
    });
    const result = await requireUser(stub, "lecturer");
    expect(result).toEqual({ ok: true, userId: USER_ID });
  });

  it("unauthenticated → 401 before any profile read", async () => {
    const { stub, calls } = makeStub({ user: null });
    const result = await requireUser(stub, "student");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(calls).not.toContain("profiles");
  });

  it("wrong role → 403 forbidden", async () => {
    const { stub } = makeStub({
      user: { id: USER_ID },
      profile: { role: "student" },
    });
    const result = await requireUser(stub, "lecturer");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("missing profile row (signup trigger race) → 503 profile_unavailable", async () => {
    const { stub } = makeStub({ user: { id: USER_ID }, profile: null });
    const result = await requireUser(stub, "lecturer");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      await expect(result.response.json()).resolves.toMatchObject({
        error: "profile_unavailable",
      });
    }
  });

  it("DB error on the profile SELECT → 503 (never a silent 403)", async () => {
    const { stub } = makeStub({
      user: { id: USER_ID },
      profile: { role: "lecturer" },
      profileError: true,
    });
    const result = await requireUser(stub, "lecturer");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });

  it("profile lookup filters by the authenticated user's id", async () => {
    const { stub, calls } = makeStub({
      user: { id: USER_ID },
      profile: { role: "student" },
    });
    await requireStudent(stub);
    expect(calls).toContain(`profiles.id=${USER_ID}`);
  });
});

describe("role helpers", () => {
  it("requireLecturer demands role=lecturer", async () => {
    const ok = makeStub({ user: { id: USER_ID }, profile: { role: "lecturer" } });
    expect((await requireLecturer(ok.stub)).ok).toBe(true);

    const bad = makeStub({ user: { id: USER_ID }, profile: { role: "student" } });
    expect((await requireLecturer(bad.stub)).ok).toBe(false);
  });

  it("requireStudent demands role=student", async () => {
    const ok = makeStub({ user: { id: USER_ID }, profile: { role: "student" } });
    expect((await requireStudent(ok.stub)).ok).toBe(true);

    const bad = makeStub({ user: { id: USER_ID }, profile: { role: "lecturer" } });
    expect((await requireStudent(bad.stub)).ok).toBe(false);
  });
});
