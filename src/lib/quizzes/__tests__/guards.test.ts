import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { requireClassOwner, requireQuizOwner } from "../guards";

type ProfileRow = { role: string };

/**
 * Minimal hand-rolled supabase stub (student-quizzes/guards.test.ts pattern):
 * auth.getUser, profiles select, plus a classes/quizzes select with DB-error
 * seams so the 503-vs-404 mapping and no-oracle semantics can be pinned.
 */
function makeStub(opts: {
  user?: { id: string } | null;
  profile?: ProfileRow | null;
  cls?: Record<string, unknown> | null;
  classError?: boolean;
  quiz?: Record<string, unknown> | null;
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
        select(_cols?: string) {
          const eqs: string[] = [];
          const builder = {
            eq(col: string, val: unknown) {
              eqs.push(`${col}=${String(val)}`);
              calls.push(`${table}.${col}=${String(val)}`);
              return builder;
            },
            maybeSingle: async () => {
              // Apply recorded eq() filters the way the real client would:
              // any row field that mismatches a filtered column yields zero rows.
              const matches = (row: Record<string, unknown> | null | undefined) => {
                if (!row) return false;
                return eqs.every((e) => {
                  const [col, val] = e.split("=");
                  return row[col] === undefined || String(row[col]) === val;
                });
              };
              if (table === "profiles") {
                return { data: opts.profile ?? null, error: null };
              }
              if (table === "classes") {
                if (opts.classError) return { data: null, error: { message: "db down" } };
                return { data: matches(opts.cls) ? opts.cls : null, error: null };
              }
              if (opts.quizError) return { data: null, error: { message: "db down" } };
              return { data: matches(opts.quiz) ? opts.quiz : null, error: null };
            },
          };
          return builder;
        },
      };
    },
  } as unknown as SupabaseClient<Database>;
  return { stub, calls };
}

const LECTURER_ID = "00000000-0000-4000-8000-0000000000d1";
const OTHER_ID = "00000000-0000-4000-8000-0000000000d2";
const CLASS_ID = "00000000-0000-4000-8000-0000000000e1";
const QUIZ_ID = "00000000-0000-4000-8000-0000000000f2";

describe("requireClassOwner", () => {
  it("owner resolves the class with archivedAt surfaced", async () => {
    const archivedAt = "2026-01-02T00:00:00Z";
    const { stub } = makeStub({
      user: { id: LECTURER_ID },
      profile: { role: "lecturer" },
      cls: { id: CLASS_ID, archived_at: archivedAt },
    });
    const result = await requireClassOwner(stub, CLASS_ID);
    expect(result).toEqual({
      ok: true,
      userId: LECTURER_ID,
      archivedAt,
    });
  });

  it("filters by lecturer_id ownership", async () => {
    const { stub, calls } = makeStub({
      user: { id: LECTURER_ID },
      profile: { role: "lecturer" },
      cls: { id: CLASS_ID, archived_at: null },
    });
    await requireClassOwner(stub, CLASS_ID);
    expect(calls).toContain(`classes.lecturer_id=${LECTURER_ID}`);
  });

  it("non-owned / missing class → 404 no-oracle", async () => {
    // Zero rows either way: other owner's row is filtered by the query.
    for (const cls of [null, { id: CLASS_ID, archived_at: null, lecturer_id: OTHER_ID }]) {
      const { stub } = makeStub({
        user: { id: LECTURER_ID },
        profile: { role: "lecturer" },
        cls,
      });
      const result = await requireClassOwner(stub, CLASS_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(404);
    }
  });

  it("DB error on the class SELECT → 503 internal", async () => {
    const { stub } = makeStub({
      user: { id: LECTURER_ID },
      profile: { role: "lecturer" },
      classError: true,
    });
    const result = await requireClassOwner(stub, CLASS_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });

  it("non-lecturer → 403 before any class read", async () => {
    const { stub, calls } = makeStub({
      user: { id: LECTURER_ID },
      profile: { role: "student" },
    });
    const result = await requireClassOwner(stub, CLASS_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expect(calls).not.toContain("classes");
  });
});

describe("requireQuizOwner", () => {
  const QUIZ_ROW = {
    id: QUIZ_ID,
    class_id: CLASS_ID,
    title: "Midterm",
    mode: "assessment",
    status: "draft",
    time_limit_sec: 600,
  };

  it("owner resolves the explicit quiz projection (no classes payload leak)", async () => {
    const { stub } = makeStub({
      user: { id: LECTURER_ID },
      profile: { role: "lecturer" },
      quiz: { ...QUIZ_ROW, classes: { lecturer_id: LECTURER_ID } },
    });
    const result = await requireQuizOwner(stub, QUIZ_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quiz).toEqual(QUIZ_ROW);
      expect(JSON.stringify(result.quiz)).not.toContain("lecturer_id");
    }
  });

  it("missing/non-owned quiz → 404 no-oracle", async () => {
    const { stub } = makeStub({
      user: { id: LECTURER_ID },
      profile: { role: "lecturer" },
      quiz: null,
    });
    const result = await requireQuizOwner(stub, QUIZ_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
  });

  it("DB error on the quiz SELECT → 503 internal (never a silent 404)", async () => {
    const { stub } = makeStub({
      user: { id: LECTURER_ID },
      profile: { role: "lecturer" },
      quizError: true,
    });
    const result = await requireQuizOwner(stub, QUIZ_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });

  it("unauthenticated → 401 before any quiz read", async () => {
    const { stub, calls } = makeStub({ user: null });
    const result = await requireQuizOwner(stub, QUIZ_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(calls).not.toContain("quizzes");
  });
});
