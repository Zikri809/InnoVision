import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { requireAnyUser, requireStudentQuizOwner } from "./guards";

type ProfileRow = { role: string };
type QuizRow = Record<string, unknown>;

/**
 * Minimal hand-rolled supabase stub — just enough surface for
 * requireAnyUser + requireStudentQuizOwner: auth.getUser, profiles select,
 * student_quizzes select. Lets us drive the DB-error seams the fluent
 * FakeSupabase cannot express (SELECT failures).
 */
function makeStub(opts: {
  user?: { id: string } | null;
  profile?: ProfileRow | null;
  profileError?: boolean;
  quiz?: QuizRow | null;
  quizError?: boolean;
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
                eq() {
                  return this;
                },
                maybeSingle: async () => {
                  if (table === "profiles") {
                    if (opts.profileError) return { data: null, error: { message: "db down" } };
                    return { data: opts.profile ?? null, error: null };
                  }
                  if (opts.quizError) return { data: null, error: { message: "db down" } };
                  return { data: opts.quiz ?? null, error: null };
                },
              };
            },
            maybeSingle: async () => {
              if (table === "profiles") {
                if (opts.profileError) return { data: null, error: { message: "db down" } };
                return { data: opts.profile ?? null, error: null };
              }
              if (opts.quizError) return { data: null, error: { message: "db down" } };
              return { data: opts.quiz ?? null, error: null };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient<Database>;
  return { stub, calls };
}

const STUDENT_ID = "00000000-0000-4000-8000-0000000000a1";
const QUIZ_ID = "00000000-0000-4000-8000-0000000000b2";

describe("requireAnyUser", () => {
  it("resolves any authenticated user without a role predicate", async () => {
    const { stub } = makeStub({ user: { id: STUDENT_ID } });
    const result = await requireAnyUser(stub);
    expect(result).toEqual({ ok: true, userId: STUDENT_ID });
  });

  it("unauthenticated → 401 unauthorized", async () => {
    const { stub } = makeStub({ user: null });
    const result = await requireAnyUser(stub);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });
});

describe("requireStudentQuizOwner", () => {
  const quiz = {
    id: QUIZ_ID,
    created_by: STUDENT_ID,
    title: "Practice",
    description: null,
    share_code: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  it("owner resolves the quiz row", async () => {
    const { stub } = makeStub({
      user: { id: STUDENT_ID },
      profile: { role: "student" },
      quiz,
    });
    const result = await requireStudentQuizOwner(stub, QUIZ_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe(STUDENT_ID);
      expect(result.quiz.title).toBe("Practice");
    }
  });

  it("DB error on the quiz SELECT → 503 internal (never a silent 404)", async () => {
    const { stub } = makeStub({
      user: { id: STUDENT_ID },
      profile: { role: "student" },
      quizError: true,
    });
    const result = await requireStudentQuizOwner(stub, QUIZ_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });

  it("missing/non-owned quiz → 404 no-oracle", async () => {
    const { stub } = makeStub({
      user: { id: STUDENT_ID },
      profile: { role: "student" },
      quiz: null,
    });
    const result = await requireStudentQuizOwner(stub, QUIZ_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
  });

  it("wrong role → 403 forbidden", async () => {
    const { stub } = makeStub({
      user: { id: STUDENT_ID },
      profile: { role: "lecturer" },
      quiz,
    });
    const result = await requireStudentQuizOwner(stub, QUIZ_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("unauthenticated → 401 before any quiz read", async () => {
    const { stub, calls } = makeStub({ user: null });
    const result = await requireStudentQuizOwner(stub, QUIZ_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    // Auth short-circuits — no quiz SELECT was issued.
    expect(calls).not.toContain("student_quizzes");
  });
});
