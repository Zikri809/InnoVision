import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { resetWalkup, DEMO_LECTURER_EMAIL } from "@/lib/demo/walkup-reset";

/**
 * walkup-reset ORDERING guarantees (PLAN_DEMO_MODE.md D6, adversarial rounds
 * 1-2). The load-bearing invariant: the source quiz is NEVER deleted, and a
 * half-built replacement is always cleaned up, unless the replacement is
 * verified LIVE. A failed questions read or an empty source must abort.
 */

const DEMO_CLASS = "class-1";
const SOURCE_QUIZ = "quiz-source";
const NEW_QUIZ = "quiz-new";
const LECTURER = "lect-1";

interface Recorded {
  quizDeletes: (string[] | undefined)[];
  /** Status filter captured on the quiz_sessions delete (curated clear). */
  sessionDeleteStatus: (string | undefined)[];
  deletedUsers: string[];
}

function makeAdmin(opts: {
  questions?: unknown[] | null;
  questionsError?: unknown;
  quizzes?: { id: string; title?: string; created_at: string }[];
  users?: { id: string; email: string; created_at: string }[];
  liveSessions?: { quiz_id: string; student_id: string; status: string }[];
}): { admin: SupabaseClient<Database>; rec: Recorded } {
  const rec: Recorded = { quizDeletes: [], sessionDeleteStatus: [], deletedUsers: [] };
  const questions =
    opts.questions === undefined ? [{ order_index: 0, type: "mcq" }] : opts.questions;
  const users =
    opts.users ??
    [
      { id: LECTURER, email: DEMO_LECTURER_EMAIL, created_at: new Date().toISOString() },
      { id: "g1", email: "guest-1@demo.innovision.test", created_at: new Date().toISOString() },
    ];

  function builder(table: string) {
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let capturedIds: string[] | undefined;
    let capturedStatus: string | undefined;
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.select = chain;
    b.eq = (c: string, v: string) => {
      if (table === "quiz_sessions" && c === "status") capturedStatus = v;
      return b;
    };
    b.neq = chain;
    b.order = chain;
    b.limit = chain;
    b.gte = chain;
    b.lte = chain;
    b.in = (_c: string, ids: string[]) => {
      if (table === "quizzes") capturedIds = ids;
      return b;
    };
    b.update = () => {
      mode = "update";
      return b;
    };
    b.insert = () => {
      mode = "insert";
      return b;
    };
    b.delete = () => {
      mode = "delete";
      return b;
    };
    const settle = () => {
      if (table === "quiz_sessions") {
        if (mode === "delete") {
          rec.sessionDeleteStatus.push(capturedStatus);
          return { data: null, error: null, count: 0 };
        }
        return { data: opts.liveSessions ?? [], error: null };
      }
      if (table === "quizzes") {
        if (mode === "delete") {
          rec.quizDeletes.push(capturedIds);
          return { data: null, error: null, count: capturedIds?.length ?? 0 };
        }
        if (mode === "insert") return { data: { id: NEW_QUIZ }, error: null };
        if (mode === "update") return { data: null, error: null };
        return {
          data: opts.quizzes ?? [
            { id: SOURCE_QUIZ, title: "Try InnoVision — Live Demo", created_at: "2026-01-01T00:00:00Z" },
          ],
          error: null,
        };
      }
      if (table === "questions") {
        if (mode === "insert") return { data: null, error: null };
        return { data: questions, error: opts.questionsError ?? null };
      }
      if (table === "classes") return { data: { id: DEMO_CLASS }, error: null };
      if (table === "class_enrollments") return { data: [], error: null };
      return { data: null, error: null };
    };
    b.single = async () => settle();
    b.maybeSingle = async () => settle();
    b.then = (resolve: (v: unknown) => void) => resolve(settle());
    return b;
  }

  const deleteUser = vi.fn().mockImplementation(async (id: string) => {
    rec.deletedUsers.push(id);
    return { error: null };
  });
  const admin = {
    auth: {
      admin: {
        listUsers: vi.fn().mockResolvedValue({ data: { users }, error: null }),
        deleteUser,
      },
    },
    from: (table: string) => builder(table),
  } as unknown as SupabaseClient<Database>;

  return { admin, rec };
}

describe("resetWalkup — ordering guarantees", () => {
  it("SUCCESS: prunes stale quizzes, never the new one", async () => {
    const { admin, rec } = makeAdmin({});
    const summary = await resetWalkup(admin);
    expect(summary.quizRecreated).toBe(true);
    expect(summary.newQuizId).toBe(NEW_QUIZ);
    expect(rec.quizDeletes.length).toBe(1);
    expect(rec.quizDeletes[0]).toContain(SOURCE_QUIZ);
    expect(rec.quizDeletes[0]).not.toContain(NEW_QUIZ);
  });

  it("questions READ ERROR aborts before any stale delete (source preserved)", async () => {
    const { admin, rec } = makeAdmin({ questionsError: { message: "boom" } });
    const summary = await resetWalkup(admin);
    expect(summary.quizRecreated).toBe(false);
    expect(summary.quizRecreateFailedReason).toBe("questions_read_error");
    expect(rec.quizDeletes.length).toBe(0);
  });

  it("EMPTY source aborts before any stale delete (never publishes a zero-question quiz)", async () => {
    const { admin, rec } = makeAdmin({ questions: [] });
    const summary = await resetWalkup(admin);
    expect(summary.quizRecreated).toBe(false);
    expect(summary.quizRecreateFailedReason).toBe("source_empty");
    expect(rec.quizDeletes.length).toBe(0);
  });

  it("curated quizzes are preserved: the stale prune touches only walk-up rows", async () => {
    const CURATED = "quiz-curated";
    const { admin, rec } = makeAdmin({
      quizzes: [
        {
          id: SOURCE_QUIZ,
          title: "Try InnoVision — Live Demo",
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: CURATED,
          title: "Demo Assessment — Click to Answer (No Camera)",
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
    });
    const summary = await resetWalkup(admin);
    expect(summary.quizRecreated).toBe(true);
    expect(summary.curatedQuizzesPreserved).toBe(1);
    expect(rec.quizDeletes.length).toBe(1);
    expect(rec.quizDeletes[0]).toContain(SOURCE_QUIZ);
    expect(rec.quizDeletes[0]).not.toContain(CURATED);
  });

  it("no demo lecturer → reason no_lecturer, no delete", async () => {
    const { admin, rec } = makeAdmin({
      users: [{ id: "g1", email: "guest-1@demo.innovision.test", created_at: new Date().toISOString() }],
    });
    const summary = await resetWalkup(admin);
    expect(summary.quizRecreated).toBe(false);
    expect(summary.quizRecreateFailedReason).toBe("no_lecturer");
    expect(rec.quizDeletes.length).toBe(0);
  });

  it("gentle: mid-quiz guests are skipped even at 0h", async () => {
    const oldGuest = {
      id: "g-old",
      email: "guest-old@demo.innovision.test",
      created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    };
    const { admin, rec } = makeAdmin({
      users: [
        { id: LECTURER, email: DEMO_LECTURER_EMAIL, created_at: new Date().toISOString() },
        oldGuest,
      ],
      liveSessions: [{ quiz_id: SOURCE_QUIZ, student_id: "g-old", status: "active" }],
    });
    const summary = await resetWalkup(admin, { maxAgeHours: 0 });
    expect(summary.guestsDeleted).toBe(0);
    expect(summary.guestsSkippedActive).toBe(1);
    expect(rec.deletedUsers).not.toContain("g-old");
    // Recreation defers while the walk-up quiz has a live session.
    expect(summary.quizRecreated).toBe(false);
    expect(summary.quizRecreateFailedReason).toBe("deferred_active_sessions");
    expect(rec.quizDeletes.length).toBe(0);
  });

  it("gentle: curated clear deletes only completed guest sessions", async () => {
    const CURATED = "quiz-curated";
    const { admin, rec } = makeAdmin({
      quizzes: [
        { id: SOURCE_QUIZ, title: "Try InnoVision — Live Demo", created_at: "2026-01-01T00:00:00Z" },
        { id: CURATED, title: "Demo Assessment — Click to Answer (No Camera)", created_at: "2026-01-02T00:00:00Z" },
      ],
    });
    const summary = await resetWalkup(admin);
    expect(summary.quizRecreated).toBe(true);
    expect(rec.sessionDeleteStatus).toContain("completed");
    expect(rec.sessionDeleteStatus).not.toContain(undefined);
  });
});
